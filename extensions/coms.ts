/**
 * coms — Peer-to-peer messaging between Pi agents on the same machine
 *
 * Each agent listens on a single endpoint (unix socket on POSIX, named pipe on
 * Windows) and discovers peers through per-project registry files under
 * ~/.pi/coms/projects/<project>/agents/<name>.json.
 *
 * Phase A (foundation): identity resolution, registry I/O, transport bind/send,
 * connection handlers.
 *
 * Usage: pi -e extensions/coms.ts
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@mariozechner/pi-coding-agent";
import {
  getEditorHost,
  installEditorHost,
  uninstallEditorHost,
} from "./editor-host.ts";
import {
  Key,
  Text,
  Container,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  fuzzyFilter,
} from "@mariozechner/pi-tui";
import type {
  AutocompleteItem,
  AutocompleteProvider,
} from "@mariozechner/pi-tui";
import { spawnSync } from "node:child_process";
import { Type } from "@sinclair/typebox";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { pickLevelOneName } from "./naming.ts";
import { complete } from "@earendil-works/pi-ai/compat";

// ━━ Constants ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const COMS_DIR =
  process.env.PI_COMS_DIR || path.join(os.homedir(), ".pi", "coms");
const MAX_HOPS = Number(process.env.PI_COMS_MAX_HOPS) || 5;
const MAX_RELAY_DEPTH = 5; // max hops a status event propagates up the agent tree
const PING_INTERVAL_MS = Number(process.env.PI_COMS_PING_INTERVAL_MS) || 10_000;
const KEEPALIVE_INTERVAL_MS = 30_000;
const TREE_PING_HOP_TIMEOUT_MS = 3_000;
const TREE_PING_MAX_DEPTH = 5;
const STALE_TIMEOUT_MS = PING_INTERVAL_MS * 3; // evict after 3 missed cascade cycles
const IS_ROOT = !process.env.PI_PARENT_SESSION;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const LINE_CAP_BYTES = 64 * 1024;

const FALLBACK_PALETTE = [
  "#72F1B8",
  "#36F9F6",
  "#FF7EDB",
  "#FEDE5D",
  "#C792EA",
  "#FF8B39",
  "#4D9DE0",
  "#FFAA8B",
];

// ━━ Types ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

type EnvelopeType = "prompt" | "ping" | "tree_ping";

interface Envelope {
  type: EnvelopeType;
  msg_id: string;
  sender_session: string;
  sender_endpoint: string;
  hops: number;
  timestamp: string;
}

interface PromptEnvelope extends Envelope {
  type: "prompt";
  prompt: string;
  sender_name: string;
  sender_cwd: string;
  conversation_id?: string | null;
}

interface PingEnvelope extends Envelope {
  type: "ping";
}

interface TreePingEnvelope extends Envelope {
  type: "tree_ping";
  request_id: string; // shared across one full cascade cycle
  max_depth: number; // remaining depth budget (decrements each hop)
  sender_card?: AgentCard; // sender's own card — carries liveness + stats down the vertical channel
}

interface TreePongNode {
  session_id: string;
  card: AgentCard;
  children: TreePongNode[];
}

interface TreePong {
  type: "tree_pong";
  request_id: string;
  node: TreePongNode;
}

// Fire-and-forget push from a node to its lateral peers after cascade collection.
// Same subtree content as tree_pong — lets peers see the sender's full subtree.
interface TreeAnnounce {
  type: "tree_announce";
  sender_session: string;
  sender_parent_session?: string; // sender's parent session_id — lets receivers compute sibling relationship
  node: TreePongNode;
}

interface AgentCard {
  name: string;
  purpose: string;
  model: string;
  color: string;
  context_used_pct: number;
  is_running?: boolean;
  is_blocked?: boolean;
}

interface Pong {
  type: "pong";
  msg_id: string;
  agent_card: AgentCard;
}

interface StatusMessage {
  type: "status";
  is_running: boolean;
  is_blocked?: boolean;
  closing?: boolean;
  // Relay fields — present when this event was forwarded up the tree.
  // origin_session is WHO this event is about (may differ from sender_session).
  // Falls back to sender_session for compat with older coms instances.
  origin_session?: string;
  origin_card?: AgentCard;
  relay_depth?: number;
}

interface RegistryEntry {
  session_id: string;
  name: string;
  purpose: string;
  model: string;
  color: string;
  pid: number;
  endpoint: string;
  cwd: string;
  started_at: string;
  explicit: boolean;
  version: number;
  // Live status snapshot — refreshed every KEEPALIVE_INTERVAL_MS by the heartbeat.
  // Optional so older entries (pre-heartbeat-refresh) still parse cleanly.
  context_used_pct?: number;
  queue_depth?: number;
  is_running?: boolean;
  heartbeat_at?: string;
  tmux_session?: string;
  tmux_window?: string;
  tmux_pane?: string;
}

// Minimal context for the currently-running coms-initiated turn — used only
// for hop-count inheritance so outbound sends from within that turn increment
// the counter correctly.
interface InboundContext {
  msg_id: string;
  hops: number;
}

// Find the entry that initiated the most recent turn: the last branch entry
// that is a real user message or an injected custom_message (e.g. coms-inbound).
// Assistant and toolResult entries are turn *output*, never initiators, so they
// are skipped. Returns null if no initiator is found.
//
// This is the linchpin of correct auto-reply: a turn should only reply to coms
// when it was actually triggered by an inbound coms message — not merely because
// an inbound happens to be sitting in the queue while some other turn (e.g. a
// proactive self-investigation) completes.
function findTurnInitiator(branch: any[]): any | null {
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (e.type === "custom_message") return e;
    if (e.type === "message" && e.message?.role === "user") return e;
    // assistant / toolResult are turn output — keep walking back
  }
  return null;
}

// ━━ Helpers ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(): string {
  const time = Date.now();
  const rand = crypto.randomBytes(10);
  let timeStr = "";
  let t = time;
  for (let i = 9; i >= 0; i--) {
    timeStr = CROCKFORD[t % 32] + timeStr;
    t = Math.floor(t / 32);
  }
  let randStr = "";
  let bits = 0;
  let value = 0;
  for (const byte of rand) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      randStr += CROCKFORD[(value >> bits) & 31];
    }
  }
  return (timeStr + randStr).slice(0, 26);
}

function hexFg(hex: string, s: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
}

function isValidHex(hex: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(hex);
}

function fallbackColor(sessionId: string): string {
  const h = crypto
    .createHash("sha256")
    .update(sessionId)
    .digest("hex")
    .slice(0, 8);
  return FALLBACK_PALETTE[Number(BigInt("0x" + h)) % FALLBACK_PALETTE.length];
}

function parseFrontmatter(raw: string): {
  name?: string;
  description?: string;
  color?: string;
  body: string;
} {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { body: raw };
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      // strip surrounding quotes for values like color: "#36F9F6"
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      frontmatter[key] = val;
    }
  }
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    color: frontmatter.color,
    body: match[2],
  };
}

function makeEndpoint(sessionId: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\pi-coms-${sessionId}`;
  }
  return path.join(COMS_DIR, "sockets", `${sessionId}.sock`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function abbreviateModel(model: string, maxLen = 20): string {
  let m = model || "";
  // Strip vendor prefixes that add noise (us., eu., ap. routing prefixes + anthropic/openai/meta etc.)
  m = m.replace(/^(us|eu|ap)\./, "");
  m = m.replace(
    /^(anthropic|openai|meta|google|mistral|amazon|bedrock)\./i,
    "",
  );
  // Strip claude- prefix since it's implied
  if (m.startsWith("claude-")) m = m.slice("claude-".length);
  // If still too long, take the tail — the end carries version/variant info
  if (m.length > maxLen) m = m.slice(m.length - maxLen);
  return m;
}

// ━━ CLI flag shape (read via pi.registerFlag/pi.getFlag) ━━━━━━━━━━━━━━━━━━━

interface CliFlags {
  name?: string;
  purpose?: string;
  project?: string;
  color?: string;
  explicit?: boolean;
}

function readCliFlags(pi: ExtensionAPI): CliFlags {
  // Identity flags are declared via pi.registerFlag at extension load time so
  // pi's CLI parser accepts them; here we just read them back.
  const name = pi.getFlag("cname") as string | undefined;
  const purpose = pi.getFlag("purpose") as string | undefined;
  const project = pi.getFlag("project") as string | undefined;
  const color = pi.getFlag("color") as string | undefined;
  const explicit = pi.getFlag("explicit") as boolean | undefined;
  return {
    name: name && name.length > 0 ? name : undefined,
    purpose: purpose && purpose.length > 0 ? purpose : undefined,
    project: project && project.length > 0 ? project : undefined,
    color: color && color.length > 0 ? color : undefined,
    explicit: explicit === true,
  };
}

// ━━ Registry I/O ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function projectAgentsDir(project: string): string {
  return path.join(COMS_DIR, "projects", project, "agents");
}

function registryFilePath(project: string, name: string): string {
  return path.join(projectAgentsDir(project), `${name}.json`);
}

function writeRegistryAtomic(entry: RegistryEntry, project: string): string {
  const dir = projectAgentsDir(project);
  fs.mkdirSync(dir, { recursive: true });
  const final = registryFilePath(project, entry.name);
  const tmp = `${final}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
  fs.renameSync(tmp, final);
  return final;
}

function readAllRegistryEntries(project: string): RegistryEntry[] {
  const dir = projectAgentsDir(project);
  if (!fs.existsSync(dir)) return [];
  const out: RegistryEntry[] = [];
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, f), "utf-8");
      const parsed = JSON.parse(raw) as RegistryEntry;
      if (parsed && typeof parsed.session_id === "string") {
        out.push(parsed);
      }
    } catch {
      // skip malformed
    }
  }
  return out;
}

function readAllRegistryEntriesAcrossProjects(): RegistryEntry[] {
  const root = path.join(COMS_DIR, "projects");
  let projects: string[];
  try {
    projects = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: RegistryEntry[] = [];
  for (const p of projects) {
    try {
      if (!fs.statSync(path.join(root, p)).isDirectory()) continue;
    } catch {
      continue;
    }
    out.push(...readAllRegistryEntries(p));
  }
  return out;
}

function removeRegistryEntry(project: string, name: string): void {
  try {
    fs.unlinkSync(registryFilePath(project, name));
  } catch {
    // best-effort
  }
}

function pruneDeadEntries(project: string): RegistryEntry[] {
  const entries = readAllRegistryEntries(project);
  const live: RegistryEntry[] = [];
  for (const entry of entries) {
    try {
      process.kill(entry.pid, 0);
      live.push(entry);
    } catch (e: any) {
      if (e && e.code === "ESRCH") {
        removeRegistryEntry(project, entry.name);
      } else {
        // EPERM means the process exists but we can't signal it — treat as live.
        live.push(entry);
      }
    }
  }
  return live;
}

function resolveUniqueName(project: string, desiredName: string): string {
  // Returns a name that doesn't collide with any LIVE registered agent.
  // pruneDeadEntries auto-removes ESRCH entries; we only care about live ones.
  const liveEntries = pruneDeadEntries(project);
  const liveNames = new Set(liveEntries.map((e) => e.name));
  if (!liveNames.has(desiredName)) return desiredName;
  let n = 2;
  while (liveNames.has(`${desiredName}${n}`)) n++;
  return `${desiredName}${n}`;
}

function pruneDeadEntriesAllProjects(): RegistryEntry[] {
  const root = path.join(COMS_DIR, "projects");
  let projects: string[];
  try {
    projects = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: RegistryEntry[] = [];
  for (const p of projects) {
    try {
      if (!fs.statSync(path.join(root, p)).isDirectory()) continue;
    } catch {
      continue;
    }
    out.push(...pruneDeadEntries(p));
  }
  return out;
}

function keepaliveTouch(file: string): void {
  try {
    const now = new Date();
    fs.utimesSync(file, now, now);
  } catch {
    // best-effort
  }
}

// ━━ Transport ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function probeStaleSocket(endpoint: string): Promise<"in_use" | "stale"> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ path: endpoint });
    let settled = false;
    const finish = (verdict: "in_use" | "stale") => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(verdict);
    };
    const timer = setTimeout(() => finish("stale"), 250);
    sock.once("connect", () => {
      clearTimeout(timer);
      finish("in_use");
    });
    sock.once("error", (err: any) => {
      clearTimeout(timer);
      if (err && err.code === "ECONNREFUSED") {
        finish("stale");
      } else {
        // ENOENT or other — treat as stale (file may be gone or unusable)
        finish("stale");
      }
    });
  });
}

async function bindEndpoint(
  endpoint: string,
  connHandler: (socket: net.Socket) => void,
): Promise<net.Server> {
  if (process.platform !== "win32" && fs.existsSync(endpoint)) {
    const verdict = await probeStaleSocket(endpoint);
    if (verdict === "in_use") {
      throw new Error(`coms: endpoint already in use (${endpoint})`);
    }
    try {
      fs.unlinkSync(endpoint);
    } catch {
      // best-effort
    }
  }
  return await new Promise<net.Server>((resolve, reject) => {
    const server = net.createServer(connHandler);
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

function readOneLine(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      if (buf.length > LINE_CAP_BYTES) {
        if (settled) return;
        settled = true;
        socket.removeListener("data", onData);
        reject(new Error("line too large"));
        return;
      }
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        if (settled) return;
        settled = true;
        socket.removeListener("data", onData);
        resolve(buf.slice(0, nl));
      }
    };
    socket.on("data", onData);
    socket.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    socket.once("close", () => {
      if (settled) return;
      settled = true;
      reject(new Error("connection closed before line received"));
    });
  });
}

function sendEnvelope(
  endpoint: string,
  envelope:
    | Envelope
    | Pong
    | { type: string; msg_id?: string; [k: string]: any },
): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ path: endpoint });
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      reject(err);
    };
    sock.once("error", fail);
    sock.once("connect", async () => {
      try {
        sock.write(JSON.stringify(envelope) + "\n");
        const line = await readOneLine(sock);
        const parsed = JSON.parse(line);
        try {
          sock.end();
        } catch {
          /* ignore */
        }
        if (settled) return;
        settled = true;
        if (parsed && parsed.type === "nack") {
          reject(new Error(parsed.error || "nack"));
        } else {
          resolve(parsed);
        }
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

// ━━ System-prompt frontmatter scan ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function findSystemPromptPath(argv: string[]): string | null {
  // Prefer --system-prompt (overwrite). Fall back to --append-system-prompt.
  // These flags are pi-builtin (not extension-registered) so we still scan
  // argv directly. First match wins per preference order.
  const scan = (flag: string): string | null => {
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === flag && i + 1 < argv.length) {
        const candidate = argv[i + 1];
        if (candidate.endsWith(".md")) {
          try {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
              return candidate;
            }
          } catch {
            // fall through
          }
        }
      }
    }
    return null;
  };
  return scan("--system-prompt") ?? scan("--append-system-prompt");
}

function readFrontmatterFromArgv(argv: string[]): {
  name?: string;
  description?: string;
  color?: string;
} {
  const p = findSystemPromptPath(argv);
  if (!p) return {};
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const { name, description, color } = parseFrontmatter(raw);
    return { name, description, color };
  } catch {
    return {};
  }
}

// ━━ Default export ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export default function (pi: ExtensionAPI) {
  // ━━ Register identity CLI flags so pi's parser accepts them. ━━━━━━━━━
  // Without these, pi 0.73+ rejects the invocation with "Unknown options:
  // --cname, --project, ..." before this extension's hooks ever fire.
  // Agent name flag is `--cname`: pi's harness owns `--name` and resumes it.
  pi.registerFlag("cname", {
    description:
      "Override coms agent name (otherwise from frontmatter or auto-generated). Distinct from pi's own --name, which the harness owns and resumes.",
    type: "string",
    default: undefined,
  });
  pi.registerFlag("purpose", {
    description:
      "Override agent purpose (otherwise from frontmatter description)",
    type: "string",
    default: undefined,
  });
  pi.registerFlag("project", {
    description: "Project namespace for peer discovery",
    type: "string",
    default: "default",
  });
  pi.registerFlag("color", {
    description:
      "Hex color #RRGGBB (otherwise from frontmatter or palette fallback)",
    type: "string",
    default: undefined,
  });
  pi.registerFlag("explicit", {
    description:
      "Hide this agent from auto-discovery; only addressable by exact name",
    type: "boolean",
    default: false,
  });

  // State containers — shared across all hooks for this extension instance.
  let identity: {
    session_id: string;
    name: string;
    purpose: string;
    color: string;
    project: string;
    explicit: boolean;
    cwd: string;
    model: string;
    endpoint: string;
    registryFiles: string[];
    tmux_session?: string;
    tmux_window?: string;
    tmux_pane?: string;
  } | null = null;

  // Register once at extension-init level (not inside session_start) so it
  // doesn't stack on reloads. Reads `identity` at exit time — always current
  // because identity is a mutable let in this closure.
  // Covers every exit path including Pi's emergencyTerminalExit → process.exit(129)
  // (dead pty on kill-pane / kill-window), which skips session_shutdown entirely.
  process.on("exit", () => {
    if (identity) {
      try {
        spawnSync("tmux", ["kill-session", "-t", `${identity.name}-subs`]);
      } catch {
        /* ignore */
      }
    }
  });

  const peerCards: Map<string, AgentCard & { staleCount: number }> = new Map();
  // Session ID of our parent agent — set on first incoming tree_ping.
  // null for root agents (no parent).
  let myParentSessionId: string | null = null;
  let server: net.Server | null = null;
  let pingTimer: NodeJS.Timeout | null = null;
  let keepaliveTimer: NodeJS.Timeout | null = null;
  let includeExplicit = false;
  let extraProjects: string[] = [];
  let currentCtx: ExtensionContext | null = null;
  let currentInbound: InboundContext | null = null;
  let firstTurnDone = false;
  let selectedIndex = -1;
  let widgetVisible = true;
  let agentRunning = false;
  let agentBlocked = false;
  let spinnerFrame = 0;
  let spinnerTimer: NodeJS.Timeout | null = null;
  const host = getEditorHost();
  let leaderActive = false;

  // All pools this agent is registered in and reads from.
  // Always includes identity.project (own-name pool); extraProjects adds named pools.
  function allProjects(): string[] {
    if (!identity) return [];
    return [
      identity.project,
      ...extraProjects.filter((p) => p !== identity!.project),
    ];
  }

  // Read registry entries across all display pools, deduplicated by session_id.
  function readAllDisplayEntries(): RegistryEntry[] {
    const seen = new Set<string>();
    const out: RegistryEntry[] = [];
    for (const p of allProjects()) {
      for (const e of readAllRegistryEntries(p)) {
        if (!seen.has(e.session_id)) {
          seen.add(e.session_id);
          out.push(e);
        }
      }
    }
    return out;
  }

  // Phase A stub handlers — each just acks valid envelopes. Phase B replaces these.
  function ackOk(socket: net.Socket, msg_id: string): void {
    try {
      socket.write(JSON.stringify({ type: "ack", msg_id }) + "\n");
    } catch {
      // ignore
    }
    try {
      socket.end();
    } catch {
      /* ignore */
    }
  }

  function nack(socket: net.Socket, msg_id: string, error: string): void {
    try {
      socket.write(JSON.stringify({ type: "nack", msg_id, error }) + "\n");
    } catch {
      // ignore
    }
    try {
      socket.end();
    } catch {
      /* ignore */
    }
  }

  function handlePrompt(socket: net.Socket, env: PromptEnvelope): void {
    // 1. Hop limit check
    if (typeof env.hops !== "number" || env.hops >= MAX_HOPS) {
      nack(socket, env.msg_id, "hops exceeded");
      return;
    }

    // Steer the receiver immediately. hops is stored in details so agent_start
    // can arm currentInbound for hop-count inheritance.
    try {
      pi.sendMessage(
        {
          customType: "coms-inbound",
          content: `[coms · from ${env.sender_name} · reply via coms_send target="${env.sender_name}" if needed]\n\n${env.prompt}`,
          display: true,
          details: {
            msg_id: env.msg_id,
            hops: env.hops,
            sender_name: env.sender_name,
          },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    } catch (err) {
      nack(socket, env.msg_id, "internal error");
      return;
    }

    ackOk(socket, env.msg_id);
    try {
      pi.appendEntry("coms-log", {
        event: "inbound_prompt",
        msg_id: env.msg_id,
        sender: env.sender_name,
        hops: env.hops,
      });
    } catch {
      // best-effort
    }
  }

  function handlePing(socket: net.Socket, env: PingEnvelope): void {
    const ctx = currentCtx;
    const ident = identity;
    const pct = ctx ? Math.round(ctx.getContextUsage()?.percent ?? 0) : 0;
    const effective = recomputeEffective();
    const card: AgentCard = {
      name: ident?.name ?? "unknown",
      purpose: ident?.purpose ?? "",
      model: ctx?.model?.name ?? ctx?.model?.id ?? ident?.model ?? "unknown",
      color: ident?.color ?? "#36F9F6",
      context_used_pct: pct,
      is_running: effective.running,
      is_blocked: effective.blocked || undefined,
    };
    const pong: Pong = { type: "pong", msg_id: env.msg_id, agent_card: card };
    try {
      socket.write(JSON.stringify(pong) + "\n");
    } catch {
      // ignore
    }
    try {
      socket.end();
    } catch {
      /* ignore */
    }
  }

  function handleStatus(_socket: net.Socket, msg: StatusMessage): void {
    // Status messages carry sender_session so we can match directly.
    // Fire-and-forget — no reply needed.
    const senderSid: string = (msg as any).sender_session;
    if (!senderSid) return;

    // origin_session is WHO this event is about. Differs from sender_session
    // when the message has been relayed up the tree. Falls back to sender_session
    // for compatibility with older coms instances that don't include origin_session.
    const originSid: string = (msg as any).origin_session ?? senderSid;
    const originCard: AgentCard | undefined = (msg as any).origin_card;
    const relayDepth: number = (msg as any).relay_depth ?? 0;

    // Ignore events about ourselves.
    if (identity && originSid === identity.session_id) return;

    if (msg.closing) {
      const closingCard = peerCards.get(originSid);
      const wasChild =
        identity && closingCard
          ? agentRelationship(identity.name, closingCard.name) === "child"
          : false;
      peerCards.delete(originSid);
      updateSpinnerTimer();
      host.requestRender();
      if (wasChild) void broadcastStatus(agentRunning);
      // Relay close to parent + siblings if the sender was our direct child.
      if (relayDepth < MAX_RELAY_DEPTH) {
        const closingSenderCard = peerCards.get(senderSid) ?? closingCard;
        const closingSenderIsMyDirectChild =
          identity && closingSenderCard
            ? closingSenderCard.name.startsWith(identity.name + "-") &&
              !closingSenderCard.name
                .slice(identity.name.length + 1)
                .includes("-")
            : false;
        if (closingSenderIsMyDirectChild) {
          const cardForRelay = originCard ?? closingCard;
          if (cardForRelay) {
            void relayCardEvent(
              senderSid,
              originSid,
              cardForRelay,
              false,
              undefined,
              true,
              relayDepth,
            );
          }
        }
      }
      return;
    }

    const existing = peerCards.get(originSid);

    // Determine card data. Prefer fresh origin_card from the broadcast;
    // fall back to existing card; for direct (non-relayed) peers look up registry.
    let cardData:
      | (AgentCard & { session_id?: string; cwd?: string; endpoint?: string })
      | null = null;
    if (originCard) {
      cardData = originCard;
    } else if (existing) {
      cardData = existing as any;
    } else if (originSid === senderSid) {
      // Direct peer — look up from registry.
      const entry = readAllDisplayEntries().find(
        (e) => e.session_id === originSid,
      );
      if (entry) {
        cardData = {
          name: entry.name,
          purpose: entry.purpose,
          model: entry.model,
          color: entry.color,
          context_used_pct: null,
          session_id: entry.session_id,
          cwd: entry.cwd,
          endpoint: entry.endpoint,
        };
      }
    }
    if (!cardData) return;

    const cardName = cardData.name ?? existing?.name;
    if (!cardName) return;

    const isChild = identity
      ? agentRelationship(identity.name, cardName) === "child"
      : false;

    if (existing) {
      // Update in place, refreshing card fields if we have fresh data.
      if (originCard) {
        existing.name = originCard.name ?? existing.name;
        existing.model = originCard.model ?? existing.model;
        existing.color = originCard.color ?? existing.color;
        existing.purpose = originCard.purpose ?? existing.purpose;
        existing.context_used_pct =
          originCard.context_used_pct ?? existing.context_used_pct;
      }
      existing.is_running = msg.is_running;
      existing.is_blocked = msg.is_blocked ?? false;
      (existing as any).lastSeenAt = Date.now();
      updateSpinnerTimer();
      host.requestRender();
      if (isChild) void broadcastStatus(agentRunning);
    } else {
      peerCards.set(originSid, {
        session_id: originSid,
        name: cardName,
        purpose: cardData.purpose ?? "",
        model: cardData.model ?? "unknown",
        color: cardData.color ?? fallbackColor(originSid),
        cwd: (cardData as any).cwd,
        endpoint: (cardData as any).endpoint,
        context_used_pct: cardData.context_used_pct ?? null,
        is_running: msg.is_running ?? false,
        is_blocked: msg.is_blocked ?? false,
        staleCount: 0,
        lastSeenAt: Date.now(),
      } as any);
      updateSpinnerTimer();
      host.requestRender();
      if (isChild) void broadcastStatus(agentRunning);
    }

    // Relay to parent + siblings if the sender is our direct child.
    // Direct child = exactly one name segment beyond ours (e.g. amber-frog under amber).
    // We never relay downstream to our own children — they already received the
    // broadcast from the origin's parent in the first hop.
    const senderCard = peerCards.get(senderSid);
    const senderIsMyDirectChild =
      identity && senderCard
        ? senderCard.name.startsWith(identity.name + "-") &&
          !senderCard.name.slice(identity.name.length + 1).includes("-")
        : false;
    if (senderIsMyDirectChild && relayDepth < MAX_RELAY_DEPTH) {
      const relayCard: AgentCard = {
        name: cardName,
        purpose: cardData.purpose ?? "",
        model: cardData.model ?? "unknown",
        color: cardData.color ?? fallbackColor(originSid),
        context_used_pct: cardData.context_used_pct ?? 0,
        is_running: msg.is_running,
        is_blocked: msg.is_blocked,
      };
      void relayCardEvent(
        senderSid,
        originSid,
        relayCard,
        msg.is_running,
        msg.is_blocked,
        false,
        relayDepth,
      );
    }
  }

  // Compute the effective status this agent should advertise to its parent —
  // own state bubbled up with the highest-priority child state.
  // Priority: blocked > running > idle (blocked implies running for display purposes).
  function recomputeEffective(): { running: boolean; blocked: boolean } {
    let running = agentRunning;
    let blocked = agentBlocked;
    if (identity) {
      for (const [sid, card] of peerCards.entries()) {
        if (sid === identity.session_id) continue;
        if (agentRelationship(identity.name, card.name) !== "child") continue;
        if (card.is_blocked) blocked = true;
        if (card.is_running) running = true;
      }
    }
    return { running, blocked };
  }

  // Forward a child/descendant card event one hop upstream.
  // senderSid: who sent US this event — excluded from relay targets to prevent echoing.
  // originSid: who the event is actually about.
  function relayCardEvent(
    senderSid: string,
    originSid: string,
    originCard: AgentCard,
    isRunning: boolean,
    isBlocked: boolean | undefined,
    closing: boolean,
    relayDepth: number,
  ): Promise<void> {
    if (!identity || relayDepth >= MAX_RELAY_DEPTH) return Promise.resolve();
    const entries = readAllDisplayEntries();
    const payload =
      JSON.stringify({
        type: "status",
        is_running: isRunning,
        is_blocked: isBlocked || undefined,
        closing: closing || undefined,
        sender_session: identity.session_id,
        origin_session: originSid,
        origin_card: originCard,
        relay_depth: relayDepth + 1,
      }) + "\n";
    const sends = entries
      .filter(
        (e) =>
          e.session_id !== identity!.session_id &&
          e.session_id !== originSid && // don't echo back to origin
          e.session_id !== senderSid && // don't echo back to who told us
          // Only relay to parent and siblings — never downstream to our own children.
          // The first-hop broadcast (from the origin's direct parent) already covered them.
          agentRelationship(identity!.name, e.name) !== "child",
      )
      .map(
        (entry) =>
          new Promise<void>((resolve) => {
            try {
              const sock = net.createConnection(entry.endpoint);
              const done = () => resolve();
              sock.once("connect", () => {
                try {
                  sock.write(payload);
                  sock.end();
                } catch {
                  /* ignore */
                }
              });
              sock.once("close", done);
              sock.once("error", done);
              setTimeout(done, 500);
            } catch {
              resolve();
            }
          }),
      );
    return Promise.all(sends).then(() => undefined);
  }

  function broadcastPeerClosed(deadSessionId: string): Promise<void> {
    if (!identity) return Promise.resolve();
    const entries = readAllDisplayEntries();
    const payload =
      JSON.stringify({
        type: "status",
        is_running: false,
        closing: true,
        sender_session: deadSessionId,
        origin_session: deadSessionId,
      }) + "\n";
    const sends = entries
      .filter(
        (e) =>
          e.session_id !== identity!.session_id &&
          e.session_id !== deadSessionId,
      )
      .map(
        (entry) =>
          new Promise<void>((resolve) => {
            try {
              const sock = net.createConnection(entry.endpoint);
              const done = () => resolve();
              sock.once("connect", () => {
                try {
                  sock.write(payload);
                  sock.end();
                } catch {
                  /* ignore */
                }
              });
              sock.once("close", done);
              sock.once("error", done);
              setTimeout(done, 500);
            } catch {
              resolve();
            }
          }),
      );
    return Promise.all(sends).then(() => undefined);
  }

  function broadcastStatus(
    is_running: boolean,
    closing = false,
  ): Promise<void> {
    if (!identity) return Promise.resolve();
    const entries = readAllDisplayEntries();
    // Broadcast effective (cascaded) status so the parent sees the subtree state.
    const effective = closing
      ? { running: false, blocked: false }
      : recomputeEffective();
    // Surface state to the tmux pane so agent-picker can show running/idle/blocked.
    const pane = process.env.TMUX_PANE;
    if (pane) {
      const paneState = effective.blocked
        ? "blocked"
        : effective.running
          ? "running"
          : "idle";
      try {
        spawnSync("tmux", ["set-option", "-p", "-t", pane, "@agent_state", paneState]);
        spawnSync("tmux", ["set-option", "-p", "-t", pane, "@agent_state_changed", String(Math.floor(Date.now() / 1000))]);
      } catch {
        /* best-effort */
      }
    }
    const ctx = currentCtx;
    const selfCard: AgentCard = {
      name: identity.name,
      purpose: identity.purpose,
      model: ctx?.model?.name ?? ctx?.model?.id ?? identity.model,
      color: identity.color,
      context_used_pct: Math.round(ctx?.getContextUsage()?.percent ?? 0),
      is_running: effective.running,
      is_blocked: effective.blocked || undefined,
    };
    const payload =
      JSON.stringify({
        type: "status",
        is_running: effective.running,
        is_blocked: effective.blocked || undefined,
        closing: closing || undefined,
        sender_session: identity.session_id,
        origin_session: identity.session_id,
        origin_card: selfCard,
        relay_depth: 0,
      }) + "\n";
    const sends = entries
      .filter((e) => e.session_id !== identity!.session_id)
      .map(
        (entry) =>
          new Promise<void>((resolve) => {
            try {
              const sock = net.createConnection(entry.endpoint);
              const done = () => resolve();
              sock.once("connect", () => {
                try {
                  sock.write(payload);
                  sock.end();
                } catch {
                  /* ignore */
                }
              });
              sock.once("close", done);
              sock.once("error", done);
              // Safety timeout so shutdown never hangs more than 500ms per peer.
              setTimeout(done, 500);
            } catch {
              resolve();
            }
          }),
      );
    return Promise.all(sends).then(() => undefined);
  }

  function updateSpinnerTimer(): void {
    const anyRunning =
      agentRunning || [...peerCards.values()].some((c) => c.is_running);
    if (anyRunning && !spinnerTimer) {
      spinnerTimer = setInterval(() => {
        spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
        host.requestRender();
      }, 100);
      try {
        (spinnerTimer as any).unref?.();
      } catch {
        /* ignore */
      }
    } else if (!anyRunning && spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
  }

  function isValidEnvelope(obj: any): obj is Envelope {
    return (
      obj &&
      typeof obj === "object" &&
      typeof obj.type === "string" &&
      typeof obj.msg_id === "string" &&
      typeof obj.sender_session === "string" &&
      typeof obj.sender_endpoint === "string"
    );
  }

  function connHandler(socket: net.Socket): void {
    let buf = "";
    let handled = false;
    const onData = (chunk: Buffer) => {
      if (handled) return;
      buf += chunk.toString("utf-8");
      if (buf.length > LINE_CAP_BYTES) {
        handled = true;
        socket.removeListener("data", onData);
        nack(socket, "", "malformed envelope");
        return;
      }
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      handled = true;
      socket.removeListener("data", onData);
      const line = buf.slice(0, nl);
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        nack(socket, "", "malformed envelope");
        return;
      }
      if (!isValidEnvelope(parsed)) {
        // Status messages are lightweight pushes — they don't carry envelope fields.
        if (parsed && parsed.type === "status") {
          handleStatus(socket, parsed as StatusMessage);
          return;
        }
        if (parsed && parsed.type === "tree_announce") {
          handleTreeAnnounce(parsed as TreeAnnounce);
          return;
        }
        const mid =
          parsed && typeof parsed.msg_id === "string" ? parsed.msg_id : "";
        nack(socket, mid, "malformed envelope");
        return;
      }
      try {
        if (parsed.type === "prompt") {
          handlePrompt(socket, parsed as PromptEnvelope);
        } else if (parsed.type === "ping") {
          handlePing(socket, parsed as PingEnvelope);
        } else if (parsed.type === "tree_ping") {
          void handleTreePing(socket, parsed as TreePingEnvelope);
        } else if (parsed.type === "status") {
          handleStatus(socket, parsed as StatusMessage);
        } else {
          nack(socket, parsed.msg_id, "unknown type");
        }
      } catch {
        nack(socket, parsed.msg_id, "internal error");
      }
    };
    socket.on("data", onData);
    socket.once("error", () => {
      // connection failures during handshake — drop quietly
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    });
  }

  // ━━ session_start ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;

    // 1. Resolve identity from CLI flags > frontmatter > defaults.
    const flags = readCliFlags(pi);
    const fm = readFrontmatterFromArgv(process.argv);
    const namedProject =
      flags.project && flags.project !== "default" ? flags.project : null;
    const explicit = flags.explicit === true;
    const session_id = ulid();

    const liveNames = new Set(pruneDeadEntriesAllProjects().map((e) => e.name));
    const defaultName =
      flags.name || fm.name
        ? resolveUniqueName(
            flags.name || fm.name || "",
            flags.name || fm.name || "",
          )
        : (process.env.PI_COMS_NAME ?? // preserved across /reload — reuse same name
          pickLevelOneName(liveNames));
    const name = defaultName;
    const purpose = flags.purpose || fm.description || "";

    // Color: validate at every level; fall through invalid hex to next.
    // Order: --color CLI flag > frontmatter color > deterministic fallback.
    let color = fallbackColor(session_id);
    if (fm.color && isValidHex(fm.color)) {
      color = fm.color;
    }
    if (flags.color && isValidHex(flags.color)) {
      color = flags.color;
    }

    const endpoint = makeEndpoint(session_id);
    const cwd = ctx.cwd || process.cwd();
    const model = ctx.model?.name ?? ctx.model?.id ?? "unknown";

    // Detect tmux location — stored in registry so peers can navigate here.
    let tmuxSession: string | undefined;
    let tmuxWindow: string | undefined;
    const tmuxPane = process.env.TMUX_PANE || undefined;
    if (tmuxPane) {
      try {
        const rs = spawnSync(
          "tmux",
          ["display-message", "-p", "-t", tmuxPane, "#S"],
          { encoding: "utf-8" },
        );
        const rw = spawnSync(
          "tmux",
          ["display-message", "-p", "-t", tmuxPane, "#W"],
          { encoding: "utf-8" },
        );
        if (rs.status === 0) tmuxSession = rs.stdout.trim() || undefined;
        if (rw.status === 0) tmuxWindow = rw.stdout.trim() || undefined;
      } catch {
        /* tmux unavailable */
      }
    }

    // 2. Ensure storage dirs exist.
    try {
      const poolsToInit = namedProject ? [name, namedProject] : [name];
      for (const p of poolsToInit) {
        fs.mkdirSync(path.join(COMS_DIR, "projects", p, "agents"), {
          recursive: true,
        });
      }
      if (process.platform !== "win32") {
        fs.mkdirSync(path.join(COMS_DIR, "sockets"), { recursive: true });
        try {
          fs.chmodSync(COMS_DIR, 0o700);
        } catch {
          /* best-effort */
        }
      }
    } catch (err) {
      ctx.ui?.notify?.(
        `coms: failed to create dirs — ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
      return;
    }

    // 3. Bind the endpoint.
    try {
      server = await bindEndpoint(endpoint, connHandler);
    } catch (err) {
      ctx.ui?.notify?.(
        `coms: bind failed — ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
      return;
    }

    // 4. Build + write registry entry atomically.
    const entry: RegistryEntry = {
      session_id,
      name,
      purpose,
      model,
      color,
      pid: process.pid,
      endpoint,
      cwd,
      started_at: nowIso(),
      explicit,
      version: 1,
      tmux_session: tmuxSession,
      tmux_window: tmuxWindow,
      tmux_pane: tmuxPane,
    };
    let registryFiles: string[];
    try {
      // Always write to own-name pool. Also write to named project if specified.
      const poolsToWrite = namedProject ? [name, namedProject] : [name];
      registryFiles = poolsToWrite.map((p) => writeRegistryAtomic(entry, p));
    } catch (err) {
      ctx.ui?.notify?.(
        `coms: registry write failed — ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
      try {
        server?.close();
      } catch {
        /* ignore */
      }
      return;
    }

    identity = {
      session_id,
      name,
      purpose,
      color,
      project: name, // primary pool = own coms name
      explicit,
      cwd,
      model,
      endpoint,
      registryFiles,
      tmux_session: tmuxSession,
      tmux_window: tmuxWindow,
      tmux_pane: tmuxPane,
    };
    includeExplicit = false;
    firstTurnDone = false;
    extraProjects = namedProject ? [namedProject] : [];
    // Expose identity so co-loaded extensions (subagent-widget etc.) can read it.
    process.env.PI_COMS_PROJECT = name;
    process.env.PI_COMS_NAME = name;

    // 5. Audit log: boot.
    try {
      pi.appendEntry("coms-log", {
        event: "boot",
        session_id,
        name,
        project: name,
        extra_projects: extraProjects,
      });
    } catch {
      // best-effort
    }

    // 6. Surface presence in the UI + install the live pool widget.
    try {
      const extraPools = extraProjects.filter((p) => p !== name);
      const poolSuffix =
        extraPools.length > 0 ? ` [${extraPools.join(", ")}]` : "";
      installPoolWidget(ctx);
      ctx.ui.setWorkingVisible(false);
      installEditorHost(ctx);
      host.unregisterOwner("coms"); // idempotent if session_start re-runs

      const agentLabel = () => {
        const extra = extraProjects.filter((p) => p !== identity?.project);
        return extra.length > 0 ? `${name} [${extra.join(", ")}]` : name;
      };
      const setLeaderStatus = (active: boolean) => {
        if (!identity || !currentCtx?.hasUI) return;
        const extra = extraProjects.filter((p) => p !== identity!.project);
        const suffix = extra.length > 0 ? ` [${extra.join(", ")}]` : "";
        const base = `@${identity.name}${suffix}`;
        try {
          currentCtx.ui.setStatus("coms", active ? `${base} [C-x]` : base);
        } catch {
          /* ignore */
        }
      };
      const leaderBindings = new Map<string, () => void>([["h", toggleWidget]]);

      // Bottom-left: working spinner. Bottom-right: @name ─ model ─ ctx%.
      host.registerSegment({
        owner: "coms",
        zone: "bottom_left",
        get: () =>
          agentRunning
            ? hexFg(
                identity?.color ?? "#36F9F6",
                SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!,
              )
            : null,
      });
      host.registerSegment({
        owner: "coms",
        zone: "bottom_right",
        order: 0,
        get: () => `@${agentLabel()}`,
      });
      host.registerSegment({
        owner: "coms",
        zone: "bottom_right",
        order: 1,
        get: () => ctx.model?.name ?? null,
      });
      host.registerSegment({
        owner: "coms",
        zone: "bottom_right",
        order: 2,
        get: () => {
          const p = ctx.getContextUsage()?.percent;
          return p != null ? `${Math.round(p)}%` : "?%";
        },
      });

      // Dim the whole editor while the C-x leader is armed.
      host.registerDecorator({
        owner: "coms",
        decorate: (lines) =>
          leaderActive
            ? lines.map((l) => ctx.ui.theme.bg("toolPendingBg", l))
            : lines,
      });

      // Pool navigation + C-x leader, replicated from the old ComsNavEditor.
      host.registerKeyHandler({
        owner: "coms",
        handle: (data, api) => {
          if (leaderActive) {
            leaderActive = false;
            setLeaderStatus(false);
            if (!matchesKey(data, Key.escape)) leaderBindings.get(data)?.();
            host.requestRender();
            return true;
          }
          if (matchesKey(data, Key.ctrl("x"))) {
            leaderActive = true;
            setLeaderStatus(true);
            host.requestRender();
            return true;
          }
          // Let the autocomplete dropdown own C-n/C-p/enter/esc while open.
          if (api.isShowingAutocomplete()) return false;
          const rows = buildPoolRows().map((r) => r.name);
          const sel = selectedIndex;
          if (matchesKey(data, Key.ctrl("n"))) {
            if (rows.length > 0) {
              selectedIndex = sel >= rows.length - 1 ? -1 : sel + 1;
              host.requestRender();
            }
            return true;
          }
          if (matchesKey(data, Key.ctrl("p"))) {
            if (rows.length > 0) {
              selectedIndex = sel === -1 ? rows.length - 1 : sel - 1;
              host.requestRender();
            }
            return true;
          }
          if (matchesKey(data, Key.enter) && sel >= 0) {
            const n = rows[sel];
            if (n) navigateToAgent(n);
            selectedIndex = -1;
            host.requestRender();
            return true;
          }
          if (matchesKey(data, Key.escape) && sel >= 0) {
            selectedIndex = -1;
            host.requestRender();
            return true;
          }
          if (data === "x" && sel >= 0) {
            const n = rows[sel];
            if (n) closeAgent(n);
            selectedIndex = -1;
            host.requestRender();
            return true;
          }
          return false;
        },
      });

      ctx.ui.setStatus("coms", `@${name}${poolSuffix}`);

      // @-mention completion for peer agents across ALL pools.
      // Layers on top of the built-in @ file provider: matches @<token>,
      // merges live agent suggestions with file suggestions under the same prefix.
      const AT_TOKEN = /(?:^|\s)@([^\s@]*)$/;
      ctx.ui.addAutocompleteProvider((current: AutocompleteProvider) => ({
        async getSuggestions(lines, cursorLine, cursorCol, options) {
          const line = lines[cursorLine] ?? "";
          const m = line.slice(0, cursorCol).match(AT_TOKEN);
          if (!m)
            return current.getSuggestions(
              lines,
              cursorLine,
              cursorCol,
              options,
            );
          const token = m[1] ?? "";

          // All agents across every pool, deduped by session_id, self excluded.
          const seen = new Set<string>();
          const uniq: RegistryEntry[] = [];
          for (const e of readAllRegistryEntriesAcrossProjects()) {
            if (identity && e.session_id === identity.session_id) continue;
            if (seen.has(e.session_id)) continue;
            seen.add(e.session_id);
            uniq.push(e);
          }
          const matched = token
            ? fuzzyFilter(uniq, token, (e) => `${e.name} ${e.purpose}`)
            : uniq;
          const relIcon = (peer: string) =>
            identity
              ? { parent: "↑", child: "↓", sibling: "~", peer: " " }[
                  agentRelationship(identity.name, peer)
                ]
              : " ";
          const home = os.homedir();
          const prettyPath = (p: string) => {
            if (!p) return "";
            const withTilde = p.startsWith(home)
              ? "~" + p.slice(home.length)
              : p;
            const parts = withTilde.split("/").filter(Boolean);
            // Match tmux status style: keep leading + basename, collapse middle to "...".
            if (parts.length <= 3) return withTilde;
            return `${parts[0]}/${parts[1]}/.../${parts[parts.length - 1]}`;
          };
          const agentItems: AutocompleteItem[] = matched
            .slice(0, 20)
            .map((e) => ({
              value: `@${e.name}`,
              label: `@${e.name}`,
              description: `${relIcon(e.name)} ${prettyPath(e.cwd)}${e.purpose ? ` · ${e.purpose}` : ""}`,
            }));

          const base = await current.getSuggestions(
            lines,
            cursorLine,
            cursorCol,
            options,
          );
          if (options.signal.aborted) return base;
          if (base && base.prefix === `@${token}`) {
            return {
              prefix: base.prefix,
              items: [...agentItems, ...base.items],
            };
          }
          if (agentItems.length === 0) return base;
          return { prefix: `@${token}`, items: agentItems };
        },
        applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
          return current.applyCompletion(
            lines,
            cursorLine,
            cursorCol,
            item,
            prefix,
          );
        },
        shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
          return (
            current.shouldTriggerFileCompletion?.(
              lines,
              cursorLine,
              cursorCol,
            ) ?? true
          );
        },
      }));
    } catch {
      // hasUI may be false in some contexts — non-fatal.
    }

    // 7. Announce presence to peers immediately — no need to wait for first ping cycle.
    broadcastStatus(false).catch(() => {});

    // 8. Start ping + keepalive cycles.
    // Only root runs the cascade timer. Non-root agents ping reactively when
    // they receive a tree_ping from their parent (see handleTreePing).
    pingTimer = setInterval(() => {
      if (IS_ROOT) runCascadePing().catch(() => {});
    }, PING_INTERVAL_MS);
    try {
      (pingTimer as any).unref?.();
    } catch {
      /* ignore */
    }
    keepaliveTimer = setInterval(() => {
      if (!identity) return;
      try {
        const ctx = currentCtx;
        // Detect missing-registry BEFORE writing so the self_heal audit only
        // fires when something actually went wrong (file unlinked under us).
        const missingBeforeWrite = identity.registryFiles.some(
          (f) => !fs.existsSync(f),
        );
        const live: RegistryEntry = {
          session_id: identity.session_id,
          name: identity.name,
          purpose: identity.purpose,
          model: ctx?.model?.name ?? ctx?.model?.id ?? identity.model,
          color: identity.color,
          pid: process.pid,
          endpoint: identity.endpoint,
          cwd: identity.cwd,
          started_at: nowIso(),
          explicit: identity.explicit,
          version: 1,
          context_used_pct: Math.round(ctx?.getContextUsage()?.percent ?? 0),
          heartbeat_at: nowIso(),
          tmux_session: identity.tmux_session,
          tmux_window: identity.tmux_window,
          tmux_pane: identity.tmux_pane,
        };
        // Write to all pools on every keepalive tick.
        for (const p of allProjects()) writeRegistryAtomic(live, p);
        if (missingBeforeWrite) {
          pi.appendEntry("coms-log", {
            event: "self_heal",
            session_id: identity.session_id,
            reason: "registry file missing",
          });
          if (identity.registryFiles.some((f) => !fs.existsSync(f))) {
            for (const p of allProjects()) writeRegistryAtomic(live, p);
          }
        }
      } catch {
        /* best-effort */
      }
      // Cleanup stale cards on every keepalive tick (all agents).
      cleanupStaleCards();
    }, KEEPALIVE_INTERVAL_MS);
    try {
      (keepaliveTimer as any).unref?.();
    } catch {
      /* ignore */
    }

    // Kick one ping cycle immediately so the widget populates fast.
    if (IS_ROOT) runCascadePing().catch(() => {});
  });

  // ━━ Helpers used by tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // ━━ Cascading tree ping ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /** Build our own AgentCard for inclusion in tree_pong responses. */
  function selfCard(): AgentCard {
    const ctx = currentCtx;
    const ident = identity;
    const pct = ctx ? Math.round(ctx.getContextUsage()?.percent ?? 0) : 0;
    const effective = recomputeEffective();
    return {
      name: ident?.name ?? "unknown",
      purpose: ident?.purpose ?? "",
      model: ctx?.model?.name ?? ctx?.model?.id ?? ident?.model ?? "unknown",
      color: ident?.color ?? "#36F9F6",
      context_used_pct: pct,
      is_running: effective.running,
      is_blocked: effective.blocked || undefined,
    };
  }

  /** Return registry entries for our direct children only. */
  function directChildEntries(): RegistryEntry[] {
    if (!identity) return [];
    const myName = identity.name;
    const entries = readAllDisplayEntries();
    return entries.filter((e) => {
      if (e.session_id === identity!.session_id) return false;
      // Direct child: exactly one more name segment
      return (
        e.name.startsWith(myName + "-") &&
        !e.name.slice(myName.length + 1).includes("-")
      );
    });
  }

  /** Return registry entries for siblings (same parent pool, not parent/child). */
  /**
   * Handles an incoming tree_ping: fans out to our direct children, collects
   * their tree_pong responses within the hop timeout, builds a TreePongNode
   * for our own subtree, updates local peerCards from child subtree data,
   * then writes the tree_pong back to the calling socket.
   */
  async function handleTreePing(
    socket: net.Socket,
    env: TreePingEnvelope,
  ): Promise<void> {
    if (!identity) {
      try {
        socket.end();
      } catch {
        /* ignore */
      }
      return;
    }

    // Record our parent session on the first tree_ping we receive.
    if (!myParentSessionId) myParentSessionId = env.sender_session;

    // A tree_ping carries the sender's card down the vertical channel — refresh our
    // view of the parent (fresh stats + liveness), mirroring how pong carries cards up.
    if (env.sender_card) {
      applyTreePongNode({
        session_id: env.sender_session,
        card: env.sender_card,
        children: [],
      });
    }

    const childNodes: TreePongNode[] = [];

    if (env.max_depth > 0) {
      const children = directChildEntries();
      if (children.length > 0) {
        const childPing: TreePingEnvelope = {
          type: "tree_ping",
          msg_id: ulid(),
          sender_session: identity.session_id,
          sender_endpoint: identity.endpoint,
          hops: 0,
          timestamp: nowIso(),
          request_id: env.request_id,
          max_depth: env.max_depth - 1,
          sender_card: selfCard(),
        };

        const results = await Promise.allSettled(
          children.map(async (child) => {
            const resp = await Promise.race([
              sendEnvelope(child.endpoint, childPing),
              new Promise<null>((res) =>
                setTimeout(() => res(null), TREE_PING_HOP_TIMEOUT_MS),
              ),
            ]);
            return { child, resp };
          }),
        );

        for (const r of results) {
          if (r.status === "fulfilled" && r.value.resp?.type === "tree_pong") {
            const pong = r.value.resp as TreePong;
            childNodes.push(pong.node);
            // Update peerCards with freshly received subtree data
            applyTreePongNode(pong.node);
          } else {
            // Timed out or failed — note the child; it will be evicted by cleanupStaleCards
            // if it stays absent long enough.
          }
        }
      }
    }

    // Build our own node, announce to lateral peers, then respond to parent.
    const myNode: TreePongNode = {
      session_id: identity.session_id,
      card: selfCard(),
      children: childNodes,
    };
    void broadcastTreeAnnounce(myNode);

    const pong: TreePong = {
      type: "tree_pong",
      request_id: env.request_id,
      node: myNode,
    };
    try {
      socket.write(JSON.stringify(pong) + "\n");
    } catch {
      /* ignore */
    }
    try {
      socket.end();
    } catch {
      /* ignore */
    }
  }

  /**
   * Recursively applies a TreePongNode subtree to peerCards.
   * parentSid is the session_id of the node's parent — stored on the card so
   * buildPoolRows can derive relationships without name parsing.
   */
  function applyTreePongNode(node: TreePongNode, parentSid?: string): void {
    if (!identity || node.session_id === identity.session_id) return;
    const now = Date.now();
    const existing = peerCards.get(node.session_id);
    if (existing) {
      // Refresh in place.
      Object.assign(existing, node.card);
      (existing as any).lastSeenAt = now;
      (existing as any).parentSessionId =
        parentSid ?? (existing as any).parentSessionId;
      existing.staleCount = 0;
    } else {
      peerCards.set(node.session_id, {
        ...node.card,
        session_id: node.session_id,
        staleCount: 0,
        lastSeenAt: now,
        parentSessionId: parentSid,
      } as any);
    }
    updateSpinnerTimer();
    host.requestRender();
    for (const child of node.children) {
      applyTreePongNode(child, node.session_id);
    }
  }

  /**
   * Fire-and-forget: broadcast our subtree node to our lateral peers so they
   * can see our children without needing to ping us. Direct children are
   * excluded — they learn our liveness + card over the vertical channel (the
   * tree_ping they receive carries our card). This keeps the two mechanisms
   * disjoint: ping/pong is vertical, announce is lateral.
   */
  function broadcastTreeAnnounce(node: TreePongNode): void {
    if (!identity) return;
    const childSids = new Set(directChildEntries().map((e) => e.session_id));
    const entries = readAllDisplayEntries().filter(
      (e) =>
        e.session_id !== identity!.session_id && !childSids.has(e.session_id),
    );
    const payload =
      JSON.stringify({
        type: "tree_announce",
        sender_session: identity.session_id,
        sender_parent_session: myParentSessionId ?? undefined,
        node,
      } satisfies TreeAnnounce) + "\n";
    for (const entry of entries) {
      try {
        const sock = net.createConnection({ path: entry.endpoint });
        sock.once("connect", () => {
          try {
            sock.write(payload);
            sock.end();
          } catch {
            /* ignore */
          }
        });
        sock.once("error", () => {
          try {
            sock.destroy();
          } catch {
            /* ignore */
          }
        });
        setTimeout(() => {
          try {
            sock.destroy();
          } catch {
            /* ignore */
          }
        }, 1000);
      } catch {
        /* ignore */
      }
    }
  }

  function handleTreeAnnounce(msg: TreeAnnounce): void {
    if (!identity) return;
    if (msg.sender_session === identity.session_id) return;
    if (!msg.node) return;
    // Pass the sender's parent session so the announcer's own card gets the correct
    // parentSessionId, enabling sibling relationship detection in buildPoolRows.
    applyTreePongNode(msg.node, msg.sender_parent_session);
    if (currentCtx?.hasUI) installPoolWidget(currentCtx);
  }

  /**
   * Evict peerCards that haven't been seen (via tree_announce / tree_pong / status)
   * within STALE_TIMEOUT_MS. Called from the keepalive timer so all agents benefit.
   */
  function cleanupStaleCards(): void {
    const cutoff = Date.now() - STALE_TIMEOUT_MS;
    let changed = false;
    for (const [sid, card] of peerCards.entries()) {
      if (identity && sid === identity.session_id) continue;
      const lastSeen = (card as any).lastSeenAt ?? 0;
      if (lastSeen < cutoff) {
        peerCards.delete(sid);
        changed = true;
      }
    }
    if (changed && currentCtx?.hasUI) installPoolWidget(currentCtx);
  }

  /**
   * Root-only: initiates a full cascading tree ping to all direct children.
   * Children process the cascade, then broadcast tree_announce to their peers
   * (including us). Root's own peerCards are updated via those announces.
   * For flat peer setups (no children), we broadcast our own announce to peers.
   */
  async function runCascadePing(): Promise<void> {
    if (!identity) return;

    const children = directChildEntries();

    // Always announce ourselves every cycle so children (and lateral peers) keep
    // our card fresh. We announce with empty children — subtree data reaches peers
    // independently via their own pong/announce handling.
    broadcastTreeAnnounce({
      session_id: identity.session_id,
      card: selfCard(),
      children: [],
    });

    if (children.length === 0) {
      return;
    }

    const requestId = ulid();
    const cascadePing: TreePingEnvelope = {
      type: "tree_ping",
      msg_id: ulid(),
      sender_session: identity.session_id,
      sender_endpoint: identity.endpoint,
      hops: 0,
      timestamp: nowIso(),
      request_id: requestId,
      max_depth: TREE_PING_MAX_DEPTH,
      sender_card: selfCard(),
    };

    const results = await Promise.allSettled(
      children.map(async (child) => {
        const resp = await Promise.race([
          sendEnvelope(child.endpoint, cascadePing),
          new Promise<null>((res) =>
            setTimeout(() => res(null), TREE_PING_HOP_TIMEOUT_MS),
          ),
        ]);
        return { child, resp };
      }),
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value.resp?.type === "tree_pong") {
        // Pass identity.session_id as parent — these nodes are our direct children.
        applyTreePongNode((r.value.resp as TreePong).node, identity.session_id);
      }
      // Absent children are handled by cleanupStaleCards (TTL-based eviction).
    }
  }

  async function pingPeer(endpoint: string): Promise<AgentCard | null> {
    if (!identity) return null;
    const env: PingEnvelope = {
      type: "ping",
      msg_id: ulid(),
      sender_session: identity.session_id,
      sender_endpoint: identity.endpoint,
      hops: 0,
      timestamp: nowIso(),
    };
    try {
      const resp = await sendEnvelope(endpoint, env);
      if (resp && resp.type === "pong" && resp.agent_card) {
        return resp.agent_card as AgentCard;
      }
    } catch {
      // ignore — peer unreachable
    }
    return null;
  }

  function toggleWidget(): void {
    widgetVisible = !widgetVisible;
    if (widgetVisible) {
      if (currentCtx) installPoolWidget(currentCtx);
    } else if (currentCtx?.hasUI) {
      try {
        currentCtx.ui.setWidget("coms-pool", undefined);
      } catch {
        /* ignore */
      }
    }
  }

  // ━━ Pool rows (shared between renderPool and the nav editor) ━━━━━━━━━━━━
  function agentRelationship(
    myName: string,
    peerName: string,
  ): "parent" | "child" | "sibling" | "peer" {
    // Hierarchy is now encoded by prefix nesting (Docker-style levels)
    // e.g. parent="amber", child="amber-basin", sibling1="amber-basin", sibling2="amber-grove"
    if (peerName.startsWith(myName + "-")) return "child";
    if (myName.startsWith(peerName + "-")) return "parent";
    const myParent = myName.split("-").slice(0, -1).join("-");
    const peerParent = peerName.split("-").slice(0, -1).join("-");
    if (myParent && peerParent && myParent === peerParent) return "sibling";
    return "peer";
  }

  interface PoolRow {
    name: string;
    model: string;
    color: string;
    purpose: string;
    pct: number | null;
    pending: boolean;
    stale: boolean;
    running: boolean;
    blocked: boolean;
    relationship: "parent" | "child" | "sibling" | "peer";
    depth: number; // 0=direct peer, 1=child, 2=grandchild, etc. — drives tree indentation
  }

  function buildPoolRows(): PoolRow[] {
    const registryEntries = includeExplicit
      ? readAllRegistryEntriesAcrossProjects()
      : readAllDisplayEntries();

    const rows: PoolRow[] = [];
    const seenSessions = new Set<string>();

    const mySid = identity?.session_id ?? "";

    // Build a parent-pointer map from stored cards.
    // parentOf.get(sid) = that agent's parent's session_id.
    const parentOf = new Map<string, string>();
    for (const [sid, card] of peerCards.entries()) {
      const p = (card as any).parentSessionId as string | undefined;
      if (p) parentOf.set(sid, p);
    }
    // Include ourselves so treeDepth can walk up through us.
    if (myParentSessionId && mySid) parentOf.set(mySid, myParentSessionId);

    // Count hops from a session to the root of the known tree.
    const treeDepth = (sid: string): number => {
      let d = 0,
        cur = sid;
      const visited = new Set<string>();
      while (true) {
        const p = parentOf.get(cur);
        if (!p || visited.has(p)) break;
        visited.add(cur);
        cur = p;
        d++;
        if (d > 20) break;
      }
      return d;
    };

    const myDepth = treeDepth(mySid);

    // Relationship from our perspective, using stored parent pointers.
    const sessionRelationship = (
      sid: string,
    ): "parent" | "child" | "sibling" | "peer" => {
      if (sid === myParentSessionId) return "parent";
      if (parentOf.get(sid) === mySid) return "child";
      if (myParentSessionId && parentOf.get(sid) === myParentSessionId)
        return "sibling";
      return "peer";
    };

    // Visual depth: how many levels below my horizontal this card sits.
    // My children = 1, siblings' children = 1, grandchildren = 2, etc.
    const visualDepth = (sid: string): number =>
      Math.max(0, treeDepth(sid) - myDepth);

    for (const [sid, card] of peerCards.entries()) {
      if (identity && sid === identity.session_id) continue;
      seenSessions.add(sid);
      rows.push({
        name: card.name,
        model: card.model,
        color: card.color,
        purpose: card.purpose,
        pct: card.context_used_pct,
        pending: false,
        stale: (card as any).lastSeenAt
          ? Date.now() - (card as any).lastSeenAt > STALE_TIMEOUT_MS * 0.67
          : (card.staleCount ?? 0) >= 3,
        running: card.is_running ?? false,
        blocked: card.is_blocked ?? false,
        relationship: sessionRelationship(sid),
        depth: visualDepth(sid),
      });
    }

    const seenNames = new Set(rows.map((r) => r.name));
    for (const entry of registryEntries) {
      if (identity && entry.session_id === identity.session_id) continue;
      if (!includeExplicit && entry.explicit) continue;
      if (seenSessions.has(entry.session_id)) continue;
      if (seenNames.has(entry.name)) continue;
      rows.push({
        name: entry.name,
        model: entry.model,
        color: entry.color,
        purpose: entry.purpose,
        pct: null,
        pending: true,
        stale: false,
        running: false,
        blocked: false,
        relationship: sessionRelationship(entry.session_id),
        depth: visualDepth(entry.session_id),
      });
    }

    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  }

  function navigateToAgent(name: string): void {
    if (!identity) return;
    const target = resolveTarget(name);

    const pane = target?.tmux_pane;

    if (pane) {
      // pane_id is globally unique — select-pane handles same-window,
      // same-session-different-window, and (with switch-client) cross-session.
      try {
        // Cross-session: switch to the session containing the pane first.
        const info = spawnSync(
          "tmux",
          [
            "display-message",
            "-p",
            "-t",
            pane,
            "#{session_name}:#{window_index}",
          ],
          { encoding: "utf-8" },
        );
        if (info.status === 0 && info.stdout.trim()) {
          spawnSync("tmux", ["switch-client", "-t", info.stdout.trim()], {
            encoding: "utf-8",
          });
        }
        // Select the specific pane (works for same-window and cross-window).
        const r = spawnSync("tmux", ["select-pane", "-t", pane], {
          encoding: "utf-8",
        });
        if (r.status !== 0) {
          currentCtx?.ui?.notify?.(
            `coms: can't select pane for ${name}`,
            "error",
          );
        }
      } catch {
        currentCtx?.ui?.notify?.("coms: tmux not available", "error");
      }
      return;
    }

    // No pane ID — fall back to session:window or window-name scan.
    let tmuxTarget: string | undefined;

    if (target?.tmux_session) {
      tmuxTarget = `${target.tmux_session}:${target.tmux_window ?? name}`;
    } else {
      try {
        const list = spawnSync(
          "tmux",
          ["list-windows", "-a", "-F", "#{session_name}:#{window_name}"],
          { encoding: "utf-8" },
        );
        if (list.status === 0) {
          tmuxTarget = list.stdout
            .trim()
            .split("\n")
            .find((l) => l.endsWith(`:${name}`));
        }
      } catch {
        /* tmux not available */
      }
    }

    if (!tmuxTarget) {
      currentCtx?.ui?.notify?.(
        `coms: no tmux location found for ${name}`,
        "error",
      );
      return;
    }

    try {
      const result = spawnSync("tmux", ["switch-client", "-t", tmuxTarget], {
        encoding: "utf-8",
      });
      if (result.status !== 0) {
        currentCtx?.ui?.notify?.(`coms: can't navigate to ${name}`, "error");
      }
    } catch {
      currentCtx?.ui?.notify?.("coms: tmux not available", "error");
    }
  }

  function closeAgent(name: string): void {
    const target = resolveTarget(name);
    const pane = target?.tmux_pane;
    if (!pane) {
      currentCtx?.ui?.notify?.(`coms: no tmux pane known for ${name}`, "error");
      return;
    }
    try {
      const r = spawnSync("tmux", ["kill-pane", "-t", pane], {
        encoding: "utf-8",
      });
      if (r.status !== 0) {
        currentCtx?.ui?.notify?.(`coms: couldn't close ${name}`, "error");
        return;
      }
      // Cascade — kill the target's subs session so its subagents die too.
      spawnSync("tmux", ["kill-session", "-t", `${name}-subs`]);
      // Broadcast the goodbye on behalf of the dead peer — we're still alive
      // so there's no shutdown timing issue. All peers drop the card immediately.
      if (target?.session_id) {
        void broadcastPeerClosed(target.session_id);
      }
      // Drop from our own pool immediately too.
      const closedIsChild =
        identity && target
          ? agentRelationship(identity.name, target.name) === "child"
          : false;
      peerCards.delete(target?.session_id ?? "");
      updateSpinnerTimer();
      host.requestRender();
      if (closedIsChild) void broadcastStatus(agentRunning);
    } catch {
      currentCtx?.ui?.notify?.("coms: tmux not available", "error");
    }
  }

  // ━━ Pool widget rendering ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  function renderPool(width: number, theme: Theme): string[] {
    // Hide the pool while autocomplete/slash-command dropdown is open so
    // there is only one selector on screen at a time.
    if (host.isShowingAutocomplete()) {
      return [];
    }

    const rows = buildPoolRows();

    if (rows.length === 0) {
      return [];
    }

    const effectiveSel = selectedIndex < rows.length ? selectedIndex : -1;
    const out: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const isSelected = i === effectiveSel;
      const pctLabel = r.pct == null ? "--%" : `${r.pct}%`;

      // Use └ icon + indent when this is a tree node below the top row:
      //   depth > 1: any deeply nested agent (grandchild+ from root's view)
      //   depth === 1 AND relationship !== "child": sibling's child visible from non-root
      // Use relationship icon otherwise (depth 0, or depth 1 direct own child → ↓).
      const useRelIcon =
        r.depth === 0 || (r.depth === 1 && r.relationship === "child");
      const indent = useRelIcon ? "" : "  ".repeat(Math.max(1, r.depth - 1));
      const relIcon = useRelIcon
        ? theme.fg(
            "dim",
            { parent: "↑", child: "↓", sibling: "~", peer: " " }[
              r.relationship
            ] ?? " ",
          )
        : theme.fg("dim", "└");

      if (r.stale) {
        const dimRow = `✗ ${indent}${r.name.padEnd(11)} ${abbreviateModel(r.model).padEnd(16)}  ${pctLabel.padStart(4)}  —  ${r.purpose || ""}`;
        const truncated = truncateToWidth(
          (isSelected ? "❯ " : "  ") + theme.fg("dim", dimRow),
          width,
        );
        out.push(isSelected ? theme.bold(truncated) : truncated);
        continue;
      }

      const swatch = r.blocked
        ? theme.fg("warning", "⊘")
        : r.running
          ? hexFg(
              r.color,
              SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!,
            )
          : r.pending
            ? theme.fg("dim", "●")
            : hexFg(r.color, "●");
      const namePart = !useRelIcon
        ? theme.fg("dim", (indent + r.name).padEnd(11 + indent.length))
        : theme.fg("accent", r.name.padEnd(11));
      const modelPart = theme.fg("dim", abbreviateModel(r.model).padEnd(16));
      const pctPart = theme.fg(
        r.pending ? "dim" : "accent",
        pctLabel.padStart(4),
      );
      const sep = theme.fg("dim", "  —  ");
      const purposePart = theme.fg("muted", r.purpose || "");

      const rawLine =
        (isSelected ? "❯ " : "  ") +
        swatch +
        " " +
        relIcon +
        namePart +
        " " +
        modelPart +
        " " +
        pctPart +
        sep +
        purposePart;
      const truncated = truncateToWidth(rawLine, width);
      out.push(isSelected ? theme.bold(truncated) : truncated);
    }

    return out;
  }

  function installPoolWidget(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.setWidget(
        "coms-pool",
        (_tui, theme) => ({
          invalidate() {},
          render(width: number): string[] {
            return renderPool(width, theme);
          },
        }),
        { placement: "belowEditor" },
      );
    } catch {
      // non-fatal
    }
  }

  // ━━ Ping cycle ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // refreshPool() removed — replaced by runCascadePing() (root) + refreshSiblings() (non-root).

  function listProjects(): string[] {
    const root = path.join(COMS_DIR, "projects");
    try {
      return fs.readdirSync(root).filter((d) => {
        try {
          return fs.statSync(path.join(root, d)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  }

  function resolveTarget(target: string): RegistryEntry | null {
    // Tolerate a leading @ — the mention UI and coms_list surface names as
    // "@name", and models tend to pass that form straight into target.
    target = target.replace(/^@/, "");
    // Search display pools first (own-name + extra).
    const displayEntries = readAllDisplayEntries();
    const byName = displayEntries.find((e) => e.name === target);
    if (byName) return byName;
    const bySession = displayEntries.find((e) => e.session_id === target);
    if (bySession) return bySession;
    // Fall back to scanning all projects.
    for (const proj of listProjects()) {
      const entries = pruneDeadEntries(proj);
      const e = entries.find(
        (e) => e.session_id === target || e.name === target,
      );
      if (e) return e;
    }
    return null;
  }

  // ━━ Tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  pi.registerTool({
    name: "coms_list",
    label: "Coms List",
    description:
      "List peer agents discoverable via coms. Returns names, models, and live context-window usage. " +
      'Use project="*" if you must scan all projects. include_explicit=true reveals agents marked --explicit.',
    parameters: Type.Object({
      project: Type.Optional(
        Type.String({
          description:
            'Project name, or "*" for all projects. Defaults to caller\'s project.',
        }),
      ),
      include_explicit: Type.Optional(
        Type.Boolean({
          description:
            "Include agents launched with --explicit. Default false.",
        }),
      ),
    }),
    async execute(_callId, params) {
      const includeExp = params.include_explicit === true;
      const projects =
        params.project === "*"
          ? listProjects()
          : params.project
            ? [params.project]
            : allProjects();

      const seen = new Set<string>();
      const collected: { entry: RegistryEntry; project: string }[] = [];
      for (const proj of projects) {
        for (const entry of readAllRegistryEntries(proj)) {
          if (entry.explicit && !includeExp) continue;
          if (identity && entry.session_id === identity.session_id) continue;
          if (seen.has(entry.session_id)) continue;
          seen.add(entry.session_id);
          collected.push({ entry, project: proj });
        }
      }

      // Ping each candidate in parallel; include ALL entries, annotate with alive status.
      // Never filter by ping — a slow or starting peer shouldn't be hidden from the LLM.
      const pongs = await Promise.allSettled(
        collected.map((c) => pingPeer(c.entry.endpoint)),
      );

      const agents = collected.map((c, i) => {
        const r = pongs[i];
        const pong = r.status === "fulfilled" ? r.value : null;
        return {
          name: c.entry.name,
          session_id: c.entry.session_id,
          purpose: c.entry.purpose,
          model: c.entry.model,
          cwd: c.entry.cwd,
          project: c.project,
          alive: pong != null,
          context_used_pct: pong ? pong.context_used_pct : null,
          color: c.entry.color,
        };
      });

      const lines =
        agents.length === 0
          ? "No peer agents found."
          : agents
              .map((a) => {
                const ctxStr =
                  a.context_used_pct != null
                    ? ` ${a.context_used_pct}%`
                    : " ?%";
                const live = a.alive ? "●" : "✗";
                return `${live} @${a.name} (${a.model})${ctxStr}${a.purpose ? ` — ${a.purpose}` : ""}`;
              })
              .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `${agents.length} peer(s):\n${lines}`,
          },
        ],
        details: { agents, project: params.project ?? null },
      };
    },
    renderCall(args, theme) {
      const proj = (args as any).project;
      const filter = proj ? ` ${proj}` : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("coms_list")) +
          theme.fg("dim", filter),
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      const details = result.details as any;
      const agents: any[] = details?.agents ?? [];
      const header = theme.fg("accent", `${agents.length} peer(s)`);
      if (!options.expanded || agents.length === 0) {
        return new Text(header, 0, 0);
      }
      const rows = agents
        .map((a) => {
          const dot = a.alive
            ? theme.fg("success", "●")
            : theme.fg("error", "✗");
          const pct =
            a.context_used_pct != null ? `${a.context_used_pct}%` : "?%";
          return `${dot} ${theme.fg("accent", `@${a.name}`)} ${theme.fg("dim", a.model)} ${theme.fg("warning", pct)}`;
        })
        .join("\n");
      return new Text(header + "\n" + rows, 0, 0);
    },
  });

  pi.registerTool({
    name: "coms_send",
    label: "Coms Send",
    description:
      "Send a message to a peer agent. Fire-and-forget: returns once the receiver acks delivery. " +
      "The receiver is steered immediately and decides whether to reply via their own coms_send. " +
      "Throws if the receiver is unreachable.",
    parameters: Type.Object({
      target: Type.String({
        description:
          "Peer name (preferred, scoped to your project) or session_id (global).",
      }),
      prompt: Type.String({ description: "The message to send." }),
      conversation_id: Type.Optional(
        Type.String({
          description:
            "Optional thread id to help the receiver correlate this message to a prior exchange.",
        }),
      ),
    }),
    async execute(_callId, params) {
      if (!identity) {
        throw new Error("coms not initialised");
      }
      const target = resolveTarget(params.target);
      if (!target) {
        throw new Error(`coms: no live agent matching "${params.target}"`);
      }
      const hops = currentInbound ? currentInbound.hops + 1 : 0;
      if (hops >= MAX_HOPS) {
        throw new Error(`coms: hop limit reached (${hops} >= ${MAX_HOPS})`);
      }
      const msg_id = ulid();
      const env: PromptEnvelope = {
        type: "prompt",
        msg_id,
        sender_session: identity.session_id,
        sender_endpoint: identity.endpoint,
        sender_name: identity.name,
        sender_cwd: identity.cwd,
        hops,
        timestamp: nowIso(),
        prompt: params.prompt,
        conversation_id: params.conversation_id ?? null,
      };

      await sendEnvelope(target.endpoint, env);
      try {
        pi.appendEntry("coms-log", {
          event: "outbound_prompt",
          msg_id,
          target: target.name,
          hops,
        });
      } catch {
        /* best-effort */
      }

      return {
        content: [
          { type: "text" as const, text: `coms_send → ${target.name}` },
        ],
        details: {
          msg_id,
          target: target.name,
          target_session: target.session_id,
          hops,
        },
      };
    },
    renderCall(args, theme) {
      const tgt = (args as any).target ?? "?";
      const prompt = (args as any).prompt ?? "";
      const preview = prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt;
      return new Text(
        theme.fg("toolTitle", theme.bold("coms_send ")) +
          theme.fg("accent", tgt) +
          theme.fg("dim", " — ") +
          theme.fg("muted", preview),
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const d = result.details as any;
      if (!d) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "", 0, 0);
      }
      return new Text(
        theme.fg("success", "→ ") +
          theme.fg("accent", d.target) +
          theme.fg("dim", `  msg_id `) +
          theme.fg("warning", d.msg_id),
        0,
        0,
      );
    },
  });

  // ━━ agent_start: arm currentInbound for hop-count inheritance ━━━━━━━━━━━━━━
  // Reads hops directly from the coms-inbound message details.
  // Proactive (non-coms) turns set currentInbound = null so outbound
  // sends correctly originate at hops = 0.

  pi.on("agent_start", async (_event, ctx) => {
    if (!identity) return;
    agentRunning = true;
    broadcastStatus(true);
    updateSpinnerTimer();
    selectedIndex = -1;
    const initiator = findTurnInitiator(ctx.sessionManager.getBranch());
    if (
      initiator?.type === "custom_message" &&
      initiator.customType === "coms-inbound"
    ) {
      currentInbound = {
        msg_id: initiator.details?.msg_id ?? "",
        hops: initiator.details?.hops ?? 0,
      };
    } else {
      currentInbound = null;
    }
  });

  // (agent_end auto-reply removed — agents decide whether to reply via coms_send)

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!identity || !ctx.hasUI) return;
    try {
      ctx.ui.setWorkingVisible(false);
    } catch {
      /* ignore */
    }
  });

  pi.on("agent_end", async () => {
    if (!identity) return;
    agentRunning = false;
    broadcastStatus(false);
    updateSpinnerTimer();
    if (!firstTurnDone) {
      firstTurnDone = true;
      if (!identity.purpose) {
        void autoSetPurpose();
      }
    }
  });

  async function autoSetPurpose(): Promise<void> {
    if (!identity || !currentCtx) return;

    // Build a minimal prompt from the first user+assistant exchange.
    const branch = currentCtx.sessionManager.getBranch();
    const parts: string[] = [];
    for (const entry of branch) {
      if (entry.type !== "message" || !entry.message?.role) continue;
      const role: string = entry.message.role;
      if (role !== "user" && role !== "assistant") continue;
      const content = entry.message.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter((c: any) => c?.type === "text")
                .map((c: any) => c.text as string)
                .join(" ")
            : "";
      if (text.trim()) parts.push(`${role === "user" ? "User" : "Assistant"}: ${text.trim()}`);
      if (parts.length >= 2) break; // first user + first assistant reply is enough
    }
    if (parts.length === 0) return;

    const prompt =
      "Write a 4–7 word task label describing what is being worked on. " +
      "Use an imperative verb phrase (e.g. 'Refactor auth module', 'Debug login failure', 'Write tests for payment service'). " +
      "Output ONLY the label. No punctuation at the end. No preamble.\n\n" +
      parts.join("\n\n");

    // Try cheap models in preference order.
    const candidates = [
      { provider: "rakuten-gemini", id: "gemini-3.5-flash" },
      { provider: "rakuten-bedrock", id: "us.anthropic.claude-haiku-4-5-20251001-v1:0" },
      { provider: "amazon-bedrock", id: "us.anthropic.claude-haiku-4-5-20251001-v1:0" },
      { provider: "anthropic", id: "claude-haiku-4-5" },
    ];

    for (const { provider, id } of candidates) {
      const model = currentCtx.modelRegistry.find(provider, id);
      if (!model) continue;
      const auth = await currentCtx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth?.ok) continue;

      try {
        const response = await complete(
          model,
          {
            messages: [
              {
                role: "user" as const,
                content: [{ type: "text" as const, text: prompt }],
                timestamp: Date.now(),
              },
            ],
          },
          { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, maxTokens: 64 },
        );

        const sentence = response.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join(" ")
          .trim();

        if (!sentence) return;

        // Update identity + registry.
        identity.purpose = sentence;
        const ctx = currentCtx;
        const live: RegistryEntry = {
          session_id: identity.session_id,
          name: identity.name,
          purpose: sentence,
          model: ctx?.model?.name ?? ctx?.model?.id ?? identity.model,
          color: identity.color,
          pid: process.pid,
          endpoint: identity.endpoint,
          cwd: identity.cwd,
          started_at: nowIso(),
          explicit: identity.explicit,
          version: 1,
          context_used_pct: Math.round(ctx?.getContextUsage()?.percent ?? 0),
          heartbeat_at: nowIso(),
          tmux_session: identity.tmux_session,
          tmux_window: identity.tmux_window,
          tmux_pane: identity.tmux_pane,
        };
        for (const p of allProjects()) {
          try { writeRegistryAtomic(live, p); } catch { /* best-effort */ }
        }
        // Announce the updated card to peers.
        void broadcastStatus(false);
        host.requestRender();
      } catch {
        // best-effort — if it fails, no purpose is set
      }
      return; // tried at least one model
    }
  }

  // ━━ /coms slash command ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.registerCommand("coms", {
    description:
      "Force-refresh the coms pool widget (or filter with --all / --project <name> / --pools)",
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();
      if (trimmed.includes("--pools")) {
        try {
          ctx.ui.notify(`coms: pools · ${allProjects().join(", ")}`, "info");
        } catch {
          /* ignore */
        }
        return;
      }
      if (trimmed.includes("--all")) {
        includeExplicit = !includeExplicit;
        try {
          ctx.ui.notify(`coms: include_explicit = ${includeExplicit}`, "info");
        } catch {
          /* ignore */
        }
      }
      const projectMatch = trimmed.match(/--project\s+(\S+)/);
      if (projectMatch) {
        const p = projectMatch[1]!;
        if (!extraProjects.includes(p)) {
          extraProjects.push(p);
          // Also write our registry entry into the new pool so peers there can find us.
          if (identity) {
            const live: RegistryEntry = {
              session_id: identity.session_id,
              name: identity.name,
              purpose: identity.purpose,
              model: identity.model,
              color: identity.color,
              pid: process.pid,
              endpoint: identity.endpoint,
              cwd: identity.cwd,
              started_at: nowIso(),
              explicit: identity.explicit,
              version: 1,
            };
            try {
              writeRegistryAtomic(live, p);
            } catch {
              /* ignore */
            }
          }
        }
        try {
          const extra = extraProjects.filter((p) => p !== identity?.project);
          const suffix = extra.length > 0 ? ` [${extra.join(", ")}]` : "";
          ctx.ui.setStatus("coms", `@${identity?.name ?? ""}${suffix}`);
          ctx.ui.notify(
            `coms: joined project ${p} · pools: ${allProjects().join(", ")}`,
            "info",
          );
        } catch {
          /* ignore */
        }
      }
      if (IS_ROOT) await runCascadePing();
    },
  });

  // ━━ Clean shutdown ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  let shuttingDown = false;
  async function cleanShutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    // Cascade shutdown to subagents — kill the subs tmux session before any
    // await so this runs synchronously even under abrupt kill (SIGHUP/SIGTERM).
    if (identity) {
      try {
        spawnSync("tmux", ["kill-session", "-t", `${identity.name}-subs`]);
      } catch {
        /* no subs session — ignore */
      }
    }
    await broadcastStatus(false, true);
    if (pingTimer) {
      try {
        clearInterval(pingTimer);
      } catch {
        /* ignore */
      }
      pingTimer = null;
    }
    if (keepaliveTimer) {
      try {
        clearInterval(keepaliveTimer);
      } catch {
        /* ignore */
      }
      keepaliveTimer = null;
    }
    if (spinnerTimer) {
      try {
        clearInterval(spinnerTimer);
      } catch {
        /* ignore */
      }
      spinnerTimer = null;
    }
    if (server) {
      try {
        server.close();
      } catch {
        /* ignore */
      }
      server = null;
    }
    if (identity) {
      if (process.platform !== "win32") {
        try {
          fs.unlinkSync(identity.endpoint);
        } catch {
          /* ignore */
        }
      }
      try {
        for (const p of allProjects()) {
          try {
            removeRegistryEntry(p, identity.name);
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
      try {
        pi.appendEntry("coms-log", {
          event: "shutdown",
          session_id: identity.session_id,
        });
      } catch {
        /* best-effort */
      }
    }
    if (currentCtx?.hasUI) {
      try {
        currentCtx.ui.setWidget("coms-pool", undefined);
      } catch {
        /* ignore */
      }
      try {
        host.unregisterOwner("coms");
        uninstallEditorHost(currentCtx);
      } catch {
        /* ignore */
      }
      try {
        currentCtx.ui.setWorkingVisible(true);
      } catch {
        /* ignore */
      }
    }
    selectedIndex = -1;
  }

  pi.on("session_shutdown", async () => {
    await cleanShutdown();
  });
  (process as any).on("pi:agent_blocked", (blocked: boolean) => {
    agentBlocked = blocked;
    void broadcastStatus(agentRunning);
  });
  process.on("SIGINT", () => {
    void cleanShutdown();
  });
  process.on("SIGTERM", () => {
    void cleanShutdown();
  });
  // SIGHUP dropped — Pi prependListener's its own SIGHUP handler which awaits
  // session_shutdown (graceful path) or calls process.exit(129) via
  // emergencyTerminalExit (dead pty). Both paths are covered: session_shutdown
  // runs cleanShutdown, and process.exit triggers the exit listener above.
}
