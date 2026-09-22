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
} from "@earendil-works/pi-coding-agent";
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
} from "@earendil-works/pi-tui";
import type {
  AutocompleteItem,
  AutocompleteProvider,
} from "@earendil-works/pi-tui";
import { spawnSync } from "node:child_process";
import { Type } from "typebox";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { pickLevelOneName } from "./naming.ts";
import { registerComsSetup } from "./coms-setup.ts";
import { complete } from "@earendil-works/pi-ai/compat";

// ━━ Constants ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const COMS_DIR =
  process.env.PI_COMS_DIR || path.join(os.homedir(), ".pi", "coms");
const MAX_HOPS = Number(process.env.PI_COMS_MAX_HOPS) || 5;
const MAX_RELAY_DEPTH = 5; // max hops a status event propagates up the agent tree
const PING_INTERVAL_MS = Number(process.env.PI_COMS_PING_INTERVAL_MS) || 10_000;
const KEEPALIVE_INTERVAL_MS = 30_000;
const TREE_PING_HOP_TIMEOUT_MS = 3_000;
// All sendEnvelope users expect a prompt ack (prompt/ping/tree_ping/respawn),
// so a wedged peer that never acks must not hang the calling tool forever.
const SEND_TIMEOUT_MS = 15_000;
const TREE_PING_MAX_DEPTH = 5;
const STALE_TIMEOUT_MS = PING_INTERVAL_MS * 3; // evict after 3 missed cascade cycles
// Anthropic's prompt cache TTL. A session idle longer than this has a cold
// cache anyway, so respawning it costs nothing in cache terms and shedding the
// stale context is pure win. Drives the idle/stale reporting in coms_list and
// the orchestrator's cold-respawn decisions.
const CACHE_TTL_MS =
  Number(process.env.PI_COMS_CACHE_TTL_MS) || 5 * 60_000;
const IS_ROOT = !process.env.PI_PARENT_SESSION;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const LINE_CAP_BYTES = 64 * 1024;

// Sigil that addresses a peer agent, e.g. `%oracle`. NOT `@`: that belongs to
// pi's built-in path completion and stealing it broke `@some/path`. `%` has no
// meaning in paths, globs, shells or markdown, so the two never collide.
const PEER_SIGIL = "%";
// Matches `%<token>` at line start or after whitespace only, so `100%done` and
// URL escapes like `%20` never trigger the peer dropdown.
const PEER_TOKEN = /(?:^|\s)%([^\s%]*)$/;
// Leading sigil the tools tolerate on a target name. `@` stays accepted for
// back-compat with older transcripts and habits.
const PEER_SIGIL_PREFIX = /^[%@]/;

export const FALLBACK_PALETTE = [
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

type EnvelopeType =
  | "prompt"
  | "ping"
  | "tree_ping"
  | "respawn_request"
  | "respawn_cold";

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

interface RespawnRequestEnvelope extends Envelope {
  type: "respawn_request";
  reason?: string | null;
  sender_name: string;
  sender_cwd: string;
  conversation_id?: string | null;
}

// Cold respawn: the sender DECIDES, the receiving extension executes without
// ever waking the LLM. Deliberately not a "request" like the above - no message
// is delivered to the peer and no turn is triggered, so the peer never pays to
// reheat the stale context it is about to discard. The note is seeded as stored
// context for whenever the peer is next prompted.
interface RespawnColdEnvelope extends Envelope {
  type: "respawn_cold";
  note?: string | null;
  reason?: string | null;
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
  // When the peer's last turn ended, so callers can compute idle time from the
  // LIVE peer rather than the registry snapshot (which only refreshes on the
  // keepalive tick). Optional: an older peer simply omits it.
  last_turn_end_at?: string | null;
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
  respawning?: boolean;
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
  // When this agent's last turn ENDED. Absent means "no turn has ended yet"
  // (fresh or cold-respawned session), which reads as fully idle. Optional so
  // entries written by an older coms build still parse; every reader treats a
  // missing value as unknown rather than zero.
  last_turn_end_at?: string;
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
export function findTurnInitiator(branch: any[]): any | null {
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

export function ulid(): string {
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

export function isValidHex(hex: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(hex);
}

/** 1234 -> "1.2k", 1_050_000 -> "1.0M". Used for the context token label. */
export function compactTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fallbackColor(sessionId: string): string {
  const h = crypto
    .createHash("sha256")
    .update(sessionId)
    .digest("hex")
    .slice(0, 8);
  return FALLBACK_PALETTE[Number(BigInt("0x" + h)) % FALLBACK_PALETTE.length];
}

export function parseFrontmatter(raw: string): {
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

// Milliseconds since the agent's last turn ended, or null when that is unknown
// (a peer running an older coms build that never writes the field) or
// meaningless (the agent is mid-turn, so it is not idle at all). Returning null
// rather than 0 keeps "unknown" and "just finished" distinguishable, so a caller
// never mistakes a silent older peer for a fresh one.
export function idleMsSince(
  lastTurnEndAt: string | null | undefined,
  running: boolean,
): number | null {
  if (running) return null;
  if (!lastTurnEndAt) return null;
  const t = Date.parse(lastTurnEndAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Date.now() - t);
}

// Compact idle rendering for LLM consumption: this is re-read on every poll, so
// it stays short and unit-suffixed rather than spelling out durations.
export function formatIdle(ms: number | null): string {
  if (ms == null) return "?";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function abbreviateModel(model: string, maxLen = 20): string {
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

export function writeRegistryAtomic(entry: RegistryEntry, project: string): string {
  const dir = projectAgentsDir(project);
  fs.mkdirSync(dir, { recursive: true });
  const final = registryFilePath(project, entry.name);
  const tmp = `${final}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
  fs.renameSync(tmp, final);
  return final;
}

export function readAllRegistryEntries(project: string): RegistryEntry[] {
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

export function readAllRegistryEntriesAcrossProjects(): RegistryEntry[] {
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

export function removeRegistryEntry(project: string, name: string): void {
  try {
    fs.unlinkSync(registryFilePath(project, name));
  } catch {
    // best-effort
  }
}

export function pruneDeadEntries(project: string): RegistryEntry[] {
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

export function resolveUniqueName(project: string, desiredName: string): string {
  // Returns a name that doesn't collide with any LIVE registered agent.
  // pruneDeadEntries auto-removes ESRCH entries; we only care about live ones.
  const liveEntries = pruneDeadEntries(project);
  const liveNames = new Set(liveEntries.map((e) => e.name));
  if (!liveNames.has(desiredName)) return desiredName;
  let n = 2;
  while (liveNames.has(`${desiredName}${n}`)) n++;
  return `${desiredName}${n}`;
}

export function pruneDeadEntriesAllProjects(): RegistryEntry[] {
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

// Respawn: the outgoing session skips registry removal (its entry must survive
// the shutdown/start gap), so on session_start the previous entry is still on
// disk and shares our pid. Prune pid-owned entries before name resolution or we
// collide with our own past self. Safe because a pid identifies exactly one
// process: entries matching ours are stale copies of us, never live peers.
export function pruneEntriesOwnedByPid(pid: number): void {
  const root = path.join(COMS_DIR, "projects");
  let projects: string[];
  try {
    projects = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const p of projects) {
    try {
      if (!fs.statSync(path.join(root, p)).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const entry of readAllRegistryEntries(p)) {
      if (entry.pid === pid) removeRegistryEntry(p, entry.name);
    }
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

export function sendEnvelope(
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
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      reject(err);
    };
    // A peer that accepts the connection but never acks would otherwise hang
    // the calling tool forever (e.g. coms_request_respawn to a wedged agent).
    const timer = setTimeout(
      () => fail(new Error(`coms: no ack from peer within ${SEND_TIMEOUT_MS}ms`)),
      SEND_TIMEOUT_MS,
    );
    try {
      (timer as any).unref?.();
    } catch {
      /* ignore */
    }
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
        clearTimeout(timer);
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

// ━━ Role file discovery ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function findRoleFilePath(argv: string[]): string | null {
  // --role is the supported way in: coms owns the file end to end, reads the
  // frontmatter for identity, and injects the body itself at the TAIL of the
  // system prompt (see buildComsPrompt). --system-prompt and
  // --append-system-prompt are kept as a fallback for older launchers, but they
  // put the role text in the MIDDLE of the prompt, where everything pi appends
  // afterwards (AGENTS.md, skills, cwd) outranks it by recency.
  const scan = (flag: string): string | null => {
    for (let i = 0; i < argv.length; i++) {
      const hit =
        argv[i] === flag && i + 1 < argv.length
          ? argv[i + 1]
          : argv[i].startsWith(`${flag}=`)
            ? argv[i].slice(flag.length + 1)
            : null;
      if (hit && hit.endsWith(".md")) {
        try {
          if (fs.existsSync(hit) && fs.statSync(hit).isFile()) return hit;
        } catch {
          // fall through
        }
      }
    }
    return null;
  };
  return (
    scan("--role") ?? scan("--system-prompt") ?? scan("--append-system-prompt")
  );
}

/** True when the role file arrived via --role, so coms owns injecting its body. */
export function roleFileIsComsOwned(argv: string[]): boolean {
  return argv.some((a) => a === "--role" || a.startsWith("--role="));
}

export function readFrontmatterFromArgv(argv: string[]): {
  name?: string;
  description?: string;
  color?: string;
} {
  const p = findRoleFilePath(argv);
  if (!p) return {};
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const { name, description, color } = parseFrontmatter(raw);
    return { name, description, color };
  } catch {
    return {};
  }
}

/**
 * Role identity + shared team rules, read once at session start.
 *
 * `_common.md` is looked up as a sibling of the role file rather than passed as
 * a second --append-system-prompt: two appends land the style rule mid-prompt
 * and split it across two blocks, and pi joins them ahead of the AGENTS.md
 * context files that repeat the same rule in different words.
 */
export function readRoleParts(argv: string[]): { body: string; common: string } {
  const p = findRoleFilePath(argv);
  if (!p || !roleFileIsComsOwned(argv)) return { body: "", common: "" };
  let body = "";
  let common = "";
  try {
    body = parseFrontmatter(fs.readFileSync(p, "utf-8")).body.trim();
  } catch {
    /* role file unreadable — fall back to hygiene-only prompt */
  }
  try {
    const sibling = path.join(path.dirname(p), "_common.md");
    if (fs.existsSync(sibling)) {
      common = parseFrontmatter(fs.readFileSync(sibling, "utf-8")).body.trim();
    }
  } catch {
    /* no shared rules — role body alone is still valid */
  }
  return { body, common };
}

// ━━ Peer selector keys ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// The pool widget is always visible, but its keys are only coms's while a row
// is selected or the C-x leader is armed. Otherwise Ctrl+N / Ctrl+P must reach
// pi: Ctrl+P is the global "next model" binding and Ctrl+N toggles the named
// filter in selectors. Exported so the tests can drive the decision without a
// TUI.

export type PoolKeyAction =
  | { kind: "leader_enter" }
  | { kind: "leader_key"; data: string; escape: boolean }
  | { kind: "select"; index: number }
  | { kind: "navigate"; index: number }
  | { kind: "clear" }
  | { kind: "close"; index: number };

/** Decide what one editor key does for the pool selector. null = pass through. */
export function poolKeyAction(
  data: string,
  state: {
    leader: boolean;
    autocomplete: boolean;
    selected: number;
    rows: number;
  },
): PoolKeyAction | null {
  if (state.leader) {
    return { kind: "leader_key", data, escape: matchesKey(data, Key.escape) };
  }
  if (matchesKey(data, Key.ctrl("x"))) return { kind: "leader_enter" };
  // Let the autocomplete dropdown own C-n/C-p/enter/esc while open.
  if (state.autocomplete) return null;
  const sel = state.selected;
  // Ctrl+N / Ctrl+P stay pi's until a row is selected: Ctrl+P is the global
  // "next model" binding and Ctrl+N toggles the named filter in selectors.
  // The selection starts with the C-x leader (n/p).
  if (matchesKey(data, Key.ctrl("n")) && sel >= 0) {
    return { kind: "select", index: sel >= state.rows - 1 ? -1 : sel + 1 };
  }
  if (matchesKey(data, Key.ctrl("p")) && sel >= 0) {
    return { kind: "select", index: sel - 1 };
  }
  if (matchesKey(data, Key.enter) && sel >= 0 && sel < state.rows) {
    return { kind: "navigate", index: sel };
  }
  if (matchesKey(data, Key.escape) && sel >= 0) return { kind: "clear" };
  if (data === "x" && sel >= 0) return { kind: "close", index: sel };
  return null;
}

// Selection step for the C-x leader (n/p). Returns the new index, or null when
// the key is not a selection step or the pool is empty. -1 clears the selection.
export function poolLeaderSelection(
  data: string,
  selected: number,
  rows: number,
): number | null {
  if (rows === 0) return null;
  if (data === "n") {
    return selected === -1 ? 0 : selected >= rows - 1 ? -1 : selected + 1;
  }
  if (data === "p") {
    return selected === -1 ? rows - 1 : selected === 0 ? -1 : selected - 1;
  }
  return null;
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
  pi.registerFlag("role", {
    description:
      "Path to a role .md file. coms reads identity from its frontmatter and injects its body (plus a sibling _common.md) at the END of the system prompt. Prefer this over --append-system-prompt, which lands the role text mid-prompt.",
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
    started_at: string;
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
  // When this agent's last turn ended. null until the first turn completes, so a
  // fresh or cold-respawned session reports as fully idle rather than busy.
  let lastTurnEndAt: string | null = null;
  let spinnerFrame = 0;
  let spinnerTimer: NodeJS.Timeout | null = null;
  const host = getEditorHost();
  let leaderActive = false;
  // Set by the /coms-respawn command before ctx.newSession; read by
  // cleanShutdown to broadcast a respawning status and skip registry removal.
  let respawning = false;
  // Stash between the coms_respawn tool and the /coms-respawn command it queues.
  // `cold` selects the turn-free path: seed the note as stored context and send
  // no prompt, so the fresh session idles at zero API cost until real work
  // arrives. Warm (the default) fires a kickoff turn to continue immediately.
  let pendingRespawn: {
    note?: string;
    conversation_id?: string;
    cold?: boolean;
  } | null = null;
  // True while a /coms-respawn follow-up is queued but not yet consumed, so a
  // second coms_respawn call in the same session updates the note instead of
  // stacking a duplicate respawn.
  let respawnFollowUpQueued = false;
  // Thread id from the most recent inbound respawn_request, so a respawn that
  // answers a peer's request can carry the conversation id into the kickoff.
  let lastRespawnRequestConversationId: string | null = null;

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
  // extra rides along in the ack so a caller can distinguish "queued" from a
  // guardrail skip without a second round trip.
  function ackOk(
    socket: net.Socket,
    msg_id: string,
    extra?: Record<string, unknown>,
  ): void {
    try {
      socket.write(
        JSON.stringify({ type: "ack", msg_id, ...(extra ?? {}) }) + "\n",
      );
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

  function handleRespawnRequest(
    socket: net.Socket,
    env: RespawnRequestEnvelope,
  ): void {
    // 1. Hop limit check
    if (typeof env.hops !== "number" || env.hops >= MAX_HOPS) {
      nack(socket, env.msg_id, "hops exceeded");
      return;
    }

    // Stash the conversation thread so coms_respawn can carry it into the
    // fresh session's kickoff.
    lastRespawnRequestConversationId = env.conversation_id ?? null;

    // Steer the receiver immediately; the receiver decides. Message-not-command:
    // nothing is forced — the target agent chooses whether to call coms_respawn.
    try {
      pi.sendMessage(
        {
          customType: "coms-inbound",
          content: `[coms · from ${env.sender_name}]\n\nPeer ${env.sender_name} requests that you respawn.${env.reason ? ` Reason: ${env.reason}` : ""} If you agree, call coms_respawn with a note.`,
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
        event: "inbound_respawn_request",
        msg_id: env.msg_id,
        sender: env.sender_name,
        hops: env.hops,
      });
    } catch {
      // best-effort
    }
  }

  // Cold respawn: execute, do not ask. The sender has already decided; waking
  // the LLM to confirm would re-send the entire stale context at full uncached
  // price only to discard it, which is exactly the cost this path exists to
  // avoid. So no message is delivered and no turn is triggered: we queue the
  // /coms-respawn command with cold semantics and ack the result.
  function handleRespawnCold(
    socket: net.Socket,
    env: RespawnColdEnvelope,
  ): void {
    if (typeof env.hops !== "number" || env.hops >= MAX_HOPS) {
      nack(socket, env.msg_id, "hops exceeded");
      return;
    }

    // Guardrail: work in flight must never be discarded. A busy or blocked peer
    // is a clean no-op, not an error, so the caller can poll a pool and act on
    // whoever is idle without special-casing the rest.
    const effective = recomputeEffective();
    if (effective.running || agentRunning) {
      ackOk(socket, env.msg_id, { skipped: "running" });
      return;
    }
    if (effective.blocked) {
      ackOk(socket, env.msg_id, { skipped: "blocked" });
      return;
    }
    // An already-queued respawn would otherwise stack a second replacement.
    if (respawnFollowUpQueued || pendingRespawn) {
      ackOk(socket, env.msg_id, { skipped: "already_queued" });
      return;
    }

    pendingRespawn = {
      note: env.note ?? undefined,
      conversation_id: env.conversation_id ?? undefined,
      cold: true,
    };

    // expandPromptTemplates routes this to the registered command handler
    // instead of the model, so the queued message is consumed by /coms-respawn
    // and never becomes an LLM request. followUp (not steer) so it lands only
    // once the peer is settled; since the peer is idle by the guardrail above,
    // that is immediately, and no turn is triggered because pi dispatches the
    // extension command during expansion rather than prompting the model.
    try {
      pi.sendUserMessage("/coms-respawn", {
        deliverAs: "followUp",
        expandPromptTemplates: true,
      });
      respawnFollowUpQueued = true;
    } catch (err) {
      pendingRespawn = null;
      nack(socket, env.msg_id, "internal error");
      return;
    }

    ackOk(socket, env.msg_id, { queued: true });
    try {
      pi.appendEntry("coms-log", {
        event: "inbound_respawn_cold",
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
      // Live idle marker: lets the asker compute idle time from the peer itself
      // instead of the registry snapshot, which only refreshes on keepalive.
      last_turn_end_at: lastTurnEndAt,
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
              false,
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
      (existing as any).respawning = msg.respawning === true;
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
        respawning: msg.respawning === true,
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
        msg.respawning === true,
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
    respawning: boolean,
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
        respawning: respawning || undefined,
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
    respawning = false,
  ): Promise<void> {
    if (!identity) return Promise.resolve();
    const entries = readAllDisplayEntries();
    // Broadcast effective (cascaded) status so the parent sees the subtree state.
    const effective =
      closing || respawning
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
        respawning: respawning || undefined,
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
      agentRunning ||
      [...peerCards.values()].some(
        (c) => c.is_running || (c as any).respawning === true,
      );
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
        } else if (parsed.type === "respawn_request") {
          handleRespawnRequest(socket, parsed as RespawnRequestEnvelope);
        } else if (parsed.type === "respawn_cold") {
          handleRespawnCold(socket, parsed as RespawnColdEnvelope);
        } else if (parsed.type === "status") {
          handleStatus(socket, parsed as unknown as StatusMessage);
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

    // Respawn leaves our previous-session entry on disk (cleanShutdown skips
    // removal). Same pid identifies it as ours; prune before name resolution
    // or we collide with our own past self.
    pruneEntriesOwnedByPid(process.pid);

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
      started_at: nowIso(),
      registryFiles,
      tmux_session: tmuxSession,
      tmux_window: tmuxWindow,
      tmux_pane: tmuxPane,
    };
    includeExplicit = false;
    firstTurnDone = false;
    respawning = false;
    pendingRespawn = null;
    respawnFollowUpQueued = false;
    lastRespawnRequestConversationId = null;
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
        const base = `${PEER_SIGIL}${identity.name}${suffix}`;
        try {
          currentCtx.ui.setStatus("coms", active ? `${base} [C-x]` : base);
        } catch {
          /* ignore */
        }
      };
      function stepPoolSelection(dir: "n" | "p"): void {
        const next = poolLeaderSelection(dir, selectedIndex, buildPoolRows().length);
        if (next === null) return;
        selectedIndex = next;
        host.requestRender();
      }
      const leaderBindings = new Map<string, () => void>([
        ["h", toggleWidget],
        ["n", () => stepPoolSelection("n")],
        ["p", () => stepPoolSelection("p")],
      ]);

      // Bottom-left: working spinner.
      // Bottom-right: @name ─ model ─ thinking ─ used/window tokens.
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
        get: () => `${PEER_SIGIL}${agentLabel()}`,
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
          if (!ctx.model?.reasoning) return null;
          const level = ctx.thinkingLevel ?? "off";
          return level === "off" ? null : level;
        },
      });
      host.registerSegment({
        owner: "coms",
        zone: "bottom_right",
        order: 3,
        get: () => {
          const usage = ctx.getContextUsage();
          if (!usage) return null;
          const used = usage.tokens != null ? compactTokens(usage.tokens) : "?";
          const window = usage.contextWindow;
          return window > 0 ? `${used}/${compactTokens(window)}` : used;
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
          const rows = buildPoolRows();
          const action = poolKeyAction(data, {
            leader: leaderActive,
            autocomplete: api.isShowingAutocomplete(),
            selected: selectedIndex,
            rows: rows.length,
          });
          if (!action) return false;
          switch (action.kind) {
            case "leader_enter":
              leaderActive = true;
              setLeaderStatus(true);
              host.requestRender();
              break;
            case "leader_key":
              leaderActive = false;
              setLeaderStatus(false);
              if (!action.escape) leaderBindings.get(action.data)?.();
              host.requestRender();
              break;
            case "select":
              selectedIndex = action.index;
              host.requestRender();
              break;
            case "navigate": {
              const n = rows[action.index]?.name;
              if (n) navigateToAgent(n);
              selectedIndex = -1;
              host.requestRender();
              break;
            }
            case "clear":
              selectedIndex = -1;
              host.requestRender();
              break;
            case "close": {
              const n = rows[action.index]?.name;
              if (n) closeAgent(n);
              selectedIndex = -1;
              host.requestRender();
              break;
            }
          }
          return true;
        },
      });

      ctx.ui.setStatus("coms", `${PEER_SIGIL}${name}${poolSuffix}`);

      // %-mention completion for peer agents across ALL pools.
      //
      // Deliberately NOT layered on `@`: `@` belongs to pi's built-in path
      // completion and hijacking it made short path tokens unusable (`@src`
      // fuzzy-matched the agent `scribe` and won the pre-selection). `%` has no
      // meaning in paths, globs, shells or markdown, so the two never collide.
      //
      // Only fires at line start or after whitespace, so `100%done` and URL
      // escapes like `%20` stay quiet.
      ctx.ui.addAutocompleteProvider((current: AutocompleteProvider) => ({
        triggerCharacters: [PEER_SIGIL],
        async getSuggestions(lines, cursorLine, cursorCol, options) {
          const line = lines[cursorLine] ?? "";
          const m = line.slice(0, cursorCol).match(PEER_TOKEN);
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
              value: `${PEER_SIGIL}${e.name}`,
              label: `${PEER_SIGIL}${e.name}`,
              description: `${relIcon(e.name)} ${prettyPath(e.cwd)}${e.purpose ? ` · ${e.purpose}` : ""}`,
            }));

          if (options.signal.aborted || agentItems.length === 0) return null;
          return { prefix: `${PEER_SIGIL}${token}`, items: agentItems };
        },
        applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
          // Own insertion for peer mentions: the built-in path logic would not
          // append the trailing space, and it must never see a `%` prefix.
          if (prefix.startsWith(PEER_SIGIL)) {
            const currentLine = lines[cursorLine] ?? "";
            const before = currentLine.slice(0, cursorCol - prefix.length);
            const after = currentLine.slice(cursorCol);
            // Add a separating space only if the text after the cursor does not
            // already start with one, so completing mid-sentence does not
            // produce "%oracle  about it".
            const gap = /^\s/.test(after) ? "" : " ";
            const nextLines = [...lines];
            nextLines[cursorLine] = `${before}${item.value}${gap}${after}`;
            return {
              lines: nextLines,
              cursorLine,
              cursorCol: before.length + item.value.length + gap.length,
            };
          }
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
          started_at: identity.started_at,
          explicit: identity.explicit,
          version: 1,
          context_used_pct: Math.round(ctx?.getContextUsage()?.percent ?? 0),
          heartbeat_at: nowIso(),
          is_running: agentRunning,
          last_turn_end_at: lastTurnEndAt ?? undefined,
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
      last_turn_end_at: lastTurnEndAt,
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
    respawning: boolean;
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
        respawning: (card as any).respawning === true,
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
        respawning: false,
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
        : r.respawning
          ? theme.fg(
              "warning",
              SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!,
            )
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
    // Tolerate a leading sigil — the mention UI and coms_list surface names as
    // "%name", and models tend to pass that form straight into target. "@name"
    // stays accepted for back-compat.
    target = target.replace(PEER_SIGIL_PREFIX, "");
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
        // Prefer the live pong (current) over the registry snapshot (only as
        // fresh as the last keepalive tick). Both may be absent on an older
        // peer, in which case idle is simply unknown and reported as such.
        const lastEnd =
          pong?.last_turn_end_at ?? c.entry.last_turn_end_at ?? null;
        const running = pong?.is_running ?? c.entry.is_running ?? false;
        const idleMs = idleMsSince(lastEnd, running);
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
          running,
          blocked: pong?.is_blocked ?? false,
          idle_ms: idleMs,
          // Precomputed so the reader does not have to know the TTL: past this
          // point the prompt cache is cold anyway and a cold respawn is free.
          cache_cold: idleMs != null ? idleMs >= CACHE_TTL_MS : false,
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
                const state = a.running
                  ? " running"
                  : a.blocked
                    ? " blocked"
                    : ` idle ${formatIdle(a.idle_ms)}${a.cache_cold ? " (cache cold)" : ""}`;
                return `${live} ${PEER_SIGIL}${a.name} (${a.model})${ctxStr}${state}${a.purpose ? ` — ${a.purpose}` : ""}`;
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
          const state = a.running
            ? theme.fg("success", "running")
            : a.blocked
              ? theme.fg("warning", "blocked")
              : theme.fg(
                  a.cache_cold ? "warning" : "dim",
                  `idle ${formatIdle(a.idle_ms ?? null)}`,
                );
          return `${dot} ${theme.fg("accent", `${PEER_SIGIL}${a.name}`)} ${theme.fg("dim", a.model)} ${theme.fg("warning", pct)} ${state}`;
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

  // ━━ coms_respawn / coms_request_respawn ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Tools can't drive session replacement directly (tools get ExtensionContext,
  // not ExtensionCommandContext). coms_respawn queues the /coms-respawn command
  // as a follow-up user message; the command handler does the real work.

  pi.registerTool({
    name: "coms_respawn",
    label: "Coms Respawn",
    description:
      "Respawn your own agent session: shed stale context by starting a fresh session in-process. " +
      "Your identity (role file) carries over via pi's system-prompt regeneration. " +
      "Queues the /coms-respawn command as a follow-up; takes effect once the current turn settles. " +
      "Set cold:true when you have no work in flight: the fresh session is seeded with your note as " +
      "stored context and fires NO turn, so it idles at zero cost until real work arrives. Leave it " +
      "unset to continue working immediately in the fresh session.",
    parameters: Type.Object({
      note: Type.Optional(
        Type.String({
          description:
            "Kickoff note for your fresh session (what you're continuing). Defaults to a generic continue-work note.",
        }),
      ),
      cold: Type.Optional(
        Type.Boolean({
          description:
            "Respawn without firing a turn: seed the note as stored context and idle. Use between tasks; do not use when work is in flight.",
        }),
      ),
    }),
    async execute(_callId, params) {
      if (!identity) {
        throw new Error("coms not initialised");
      }
      pendingRespawn = {
        note: params.note || undefined,
        conversation_id: lastRespawnRequestConversationId ?? undefined,
        cold: params.cold === true,
      };
      lastRespawnRequestConversationId = null;
      // One respawn per session: a second call updates the pending note
      // instead of stacking a duplicate follow-up (which would respawn twice).
      const queuedNow = !respawnFollowUpQueued;
      if (queuedNow) {
        pi.sendUserMessage("/coms-respawn", {
          deliverAs: "followUp",
          expandPromptTemplates: true,
        });
        respawnFollowUpQueued = true;
      }
      return {
        content: [
          {
            type: "text" as const,
            text: queuedNow
              ? "Queued /coms-respawn as a follow-up. Your session will be replaced with a fresh one once the current turn settles."
              : "coms_respawn already queued — note updated. It takes effect once the current turn settles.",
          },
        ],
        details: {
          note: params.note ?? null,
          cold: params.cold === true,
          conversation_id: pendingRespawn.conversation_id ?? null,
        },
      };
    },
    renderCall(args, theme) {
      const note = (args as any).note ?? "";
      const preview = note.length > 60 ? note.slice(0, 57) + "..." : note;
      return new Text(
        theme.fg("toolTitle", theme.bold("coms_respawn")) +
          (preview
            ? theme.fg("dim", " — ") + theme.fg("muted", preview)
            : ""),
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const t = result.content[0];
      return new Text(
        theme.fg("success", "↻ ") + (t?.type === "text" ? t.text : ""),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "coms_request_respawn",
    label: "Coms Request Respawn",
    description:
      "Ask a peer agent to respawn its session (shed stale context). The peer sees the request " +
      "as a message and decides for itself; nothing is forced. Ack-on-delivery like coms_send. " +
      "conversation_id is auto-filled with your session id so the peer's fresh session can " +
      "correlate the exchange. Throws if the peer is unreachable.",
    parameters: Type.Object({
      to: Type.String({
        description:
          "Peer name (preferred, scoped to your project) or session_id (global).",
      }),
      reason: Type.Optional(
        Type.String({
          description: "Why the peer should respawn (shown to the peer).",
        }),
      ),
    }),
    async execute(_callId, params) {
      if (!identity) {
        throw new Error("coms not initialised");
      }
      const target = resolveTarget(params.to);
      if (!target) {
        throw new Error(`coms: no live agent matching "${params.to}"`);
      }
      const hops = currentInbound ? currentInbound.hops + 1 : 0;
      if (hops >= MAX_HOPS) {
        throw new Error(`coms: hop limit reached (${hops} >= ${MAX_HOPS})`);
      }
      const msg_id = ulid();
      const env: RespawnRequestEnvelope = {
        type: "respawn_request",
        msg_id,
        sender_session: identity.session_id,
        sender_endpoint: identity.endpoint,
        sender_name: identity.name,
        sender_cwd: identity.cwd,
        hops,
        timestamp: nowIso(),
        reason: params.reason ?? null,
        // Auto-filled: the sender's session id is the stable end of the
        // exchange (the receiver's session is about to be replaced), so it
        // threads the conversation across the receiver's respawn.
        conversation_id: identity.session_id,
      };

      await sendEnvelope(target.endpoint, env);
      try {
        pi.appendEntry("coms-log", {
          event: "outbound_respawn_request",
          msg_id,
          target: target.name,
          hops,
        });
      } catch {
        /* best-effort */
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `coms_request_respawn → ${target.name}`,
          },
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
      const tgt = (args as any).to ?? "?";
      const reason = (args as any).reason ?? "";
      const preview = reason.length > 60 ? reason.slice(0, 57) + "..." : reason;
      return new Text(
        theme.fg("toolTitle", theme.bold("coms_request_respawn ")) +
          theme.fg("accent", tgt) +
          (preview
            ? theme.fg("dim", " — ") + theme.fg("muted", preview)
            : ""),
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
        theme.fg("success", "↻ ") +
          theme.fg("accent", d.target) +
          theme.fg("dim", `  msg_id `) +
          theme.fg("warning", d.msg_id),
        0,
        0,
      );
    },
  });

  // ━━ coms_cold_respawn ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Sibling of coms_request_respawn with deliberately different semantics: this
  // one DECIDES rather than asks. The peer retains no veto because a veto needs
  // a turn to exercise, and that turn would re-send the whole stale context at
  // uncached price - the exact cost this tool exists to avoid. The peer's
  // interests are protected structurally instead: it is skipped whenever work is
  // in flight (running, blocked, or already respawning).

  pi.registerTool({
    name: "coms_cold_respawn",
    label: "Coms Cold Respawn",
    description:
      "Replace an IDLE peer's session with a fresh one without costing it a turn. Unlike " +
      "coms_request_respawn, the peer is not asked and never wakes: no message is delivered, no LLM " +
      "call is made, and it does not reheat the context it is about to discard. Your note is seeded " +
      "as stored context for whenever it is next prompted. A peer that is running, blocked, or " +
      "already respawning is SKIPPED, not errored - check the result. Use this to recycle stale " +
      "peers between tasks (see idle time in coms_list).",
    parameters: Type.Object({
      to: Type.String({
        description:
          "Peer name (preferred, scoped to your project) or session_id (global).",
      }),
      note: Type.Optional(
        Type.String({
          description:
            "Note seeded into the peer's fresh session as stored context (what it should know / pick up next).",
        }),
      ),
      reason: Type.Optional(
        Type.String({
          description: "Why it is being recycled (for the audit log).",
        }),
      ),
    }),
    async execute(_callId, params) {
      if (!identity) {
        throw new Error("coms not initialised");
      }
      const target = resolveTarget(params.to);
      if (!target) {
        throw new Error(`coms: no live agent matching "${params.to}"`);
      }
      if (target.session_id === identity.session_id) {
        throw new Error(
          "coms: use coms_respawn with cold:true to respawn your own session",
        );
      }
      const hops = currentInbound ? currentInbound.hops + 1 : 0;
      if (hops >= MAX_HOPS) {
        throw new Error(`coms: hop limit reached (${hops} >= ${MAX_HOPS})`);
      }
      const msg_id = ulid();
      const env: RespawnColdEnvelope = {
        type: "respawn_cold",
        msg_id,
        sender_session: identity.session_id,
        sender_endpoint: identity.endpoint,
        sender_name: identity.name,
        sender_cwd: identity.cwd,
        hops,
        timestamp: nowIso(),
        note: params.note ?? null,
        reason: params.reason ?? null,
        conversation_id: identity.session_id,
      };

      const resp = await sendEnvelope(target.endpoint, env);
      // The ack carries the outcome: the receiver's guardrails run before it
      // replies, so a skip is known here without polling.
      const skipped =
        resp && typeof (resp as any).skipped === "string"
          ? ((resp as any).skipped as string)
          : null;
      try {
        pi.appendEntry("coms-log", {
          event: "outbound_respawn_cold",
          msg_id,
          target: target.name,
          skipped,
          hops,
        });
      } catch {
        /* best-effort */
      }

      const text = skipped
        ? `coms_cold_respawn → ${target.name}: skipped (${skipped}), session left intact`
        : `coms_cold_respawn → ${target.name}: queued, no turn fired`;
      return {
        content: [{ type: "text" as const, text }],
        details: {
          msg_id,
          target: target.name,
          target_session: target.session_id,
          skipped,
          hops,
        },
      };
    },
    renderCall(args, theme) {
      const tgt = (args as any).to ?? "?";
      const reason = (args as any).reason ?? "";
      const preview = reason.length > 60 ? reason.slice(0, 57) + "..." : reason;
      return new Text(
        theme.fg("toolTitle", theme.bold("coms_cold_respawn ")) +
          theme.fg("accent", tgt) +
          (preview
            ? theme.fg("dim", " — ") + theme.fg("muted", preview)
            : ""),
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
      if (d.skipped) {
        return new Text(
          theme.fg("warning", "⊘ ") +
            theme.fg("accent", d.target) +
            theme.fg("dim", `  skipped: ${d.skipped}`),
          0,
          0,
        );
      }
      return new Text(
        theme.fg("success", "❄ ") +
          theme.fg("accent", d.target) +
          theme.fg("dim", "  cold, no turn"),
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

  // ━━ The coms prompt (single tail block) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ONE block, appended LAST, holding everything that defines this agent: who
  // it is, how it writes, who its teammates are, and how it manages its own
  // session.
  //
  // Why a single tail block and not --append-system-prompt files:
  //   pi assembles the prompt as base + tool guidelines + appendSystemPrompt +
  //   AGENTS.md context files + skills + cwd. Anything passed with
  //   --append-system-prompt therefore sits in the MIDDLE, outranked by recency
  //   by ~5k chars of AGENTS.md and skill listings that follow it, and dwarfed
  //   by ~13k chars of dense tool guidelines ahead of it. Splitting identity
  //   and shared rules across two appends made it two soft hints instead of one
  //   rule. before_agent_start runs after the whole prompt is built, so what we
  //   return here is genuinely last.
  //
  // Returned from before_agent_start, which chains per turn and is NOT stored
  // in the session, so it cannot accumulate across turns the way an injected
  // message would.
  const CACHE_TTL_MIN = Math.round(CACHE_TTL_MS / 60_000);
  // Read once per session, not once per turn: the role file does not change
  // under a live agent, and a per-turn read would be disk I/O on the hot path.
  const roleParts = readRoleParts(process.argv);

  function sessionHygieneSection(): string {
    const isOrchestrator = /orchestrator/i.test(identity?.name ?? "");
    const lines = [
      "## Session hygiene",
      "",
      "- One task per session. Do not carry a session across unrelated tasks.",
      `- The prompt cache TTL is ${CACHE_TTL_MIN} minutes. A session idle much longer than that has a cold cache already, so there is nothing left to preserve.`,
      "- Respawning while IDLE is free. Respawning after a prompt has landed costs a full context reheat, so never respawn as the first act of a turn: finish the turn, then respawn.",
    ];
    if (isOrchestrator) {
      lines.push(
        "- Watch peer idle time in coms_list and cold-respawn stale peers between tasks with coms_cold_respawn. It costs them no turn. Busy peers are skipped automatically.",
      );
    } else {
      lines.push(
        "- Finish or hand off in-flight work before respawning. Never respawn mid-edit or while holding uncommitted work nobody has reported.",
        "- Use coms_respawn with cold:true between tasks: it seeds your note and idles at zero cost.",
      );
    }
    return lines.join("\n");
  }

  function buildComsPrompt(): string {
    const name = identity?.name ?? "this agent";
    const sections = [
      "# You are a coms agent",
      "",
      "Everything below overrides anything above it that conflicts with it,",
      "including the tool guidelines and the project context files. The tool",
      "guidelines tell you HOW to call a tool; they are not an example of how to",
      "write. Write the way this section says, every time, to the human and to",
      "your teammates.",
      "",
      `Your name in this team is \`${name}\`.`,
    ];
    if (roleParts.body) sections.push("", "## Your role", "", roleParts.body);
    if (roleParts.common) sections.push("", roleParts.common);
    sections.push("", sessionHygieneSection());
    return sections.join("\n");
  }

  pi.on("before_agent_start", async (event, ctx) => {
    if (!identity) return;
    if (ctx.hasUI) {
      try {
        ctx.ui.setWorkingVisible(false);
      } catch {
        /* ignore */
      }
    }
    // Chain onto the prompt as it stands for this handler, so other extensions'
    // changes are preserved.
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildComsPrompt()}`,
    };
  });

  pi.on("agent_end", async () => {
    if (!identity) return;
    agentRunning = false;
    // Recorded here rather than on a timer: agent_end is the moment the context
    // stops changing, which is exactly when the prompt cache starts going cold.
    lastTurnEndAt = nowIso();
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
      const content =
        "content" in entry.message ? entry.message.content : undefined;
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
          started_at: identity.started_at,
          explicit: identity.explicit,
          version: 1,
          context_used_pct: Math.round(ctx?.getContextUsage()?.percent ?? 0),
          heartbeat_at: nowIso(),
          is_running: agentRunning,
          last_turn_end_at: lastTurnEndAt ?? undefined,
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
              started_at: identity.started_at,
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
          ctx.ui.setStatus(
            "coms",
            `${PEER_SIGIL}${identity?.name ?? ""}${suffix}`,
          );
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

  // ━━ /coms-respawn command ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Queued by the coms_respawn tool. Only the command context (not the tool
  // context) can drive session replacement, so the real work lives here.
  pi.registerCommand("coms-respawn", {
    description:
      "Respawn this agent's session in-process: fresh context, same identity (role file)",
    handler: async (_args, ctx) => {
      if (!identity) return;
      // This command was queued by coms_respawn; clear the queue marker so a
      // later coms_respawn call in this session queues a fresh follow-up.
      respawnFollowUpQueued = false;
      const pending = pendingRespawn;
      try {
        await ctx.waitForIdle();
      } catch {
        // Agent never settled — re-queue the follow-up so the respawn retries
        // once this turn settles; respawning now would race the active turn.
        pendingRespawn = pending;
        try {
          pi.sendUserMessage("/coms-respawn", {
            deliverAs: "followUp",
            expandPromptTemplates: true,
          });
          respawnFollowUpQueued = true;
        } catch {
          /* ignore */
        }
        try {
          ctx.ui.notify("coms: couldn't reach idle, respawn re-queued", "warning");
        } catch {
          /* ignore */
        }
        return;
      }
      pendingRespawn = null;

      // Cold vs warm is the whole point of this path. Warm fires a kickoff turn
      // so the peer continues immediately. Cold fires NOTHING: the note is
      // seeded via setup() as a stored user message, and with no withSession
      // callback there is no sendUserMessage and therefore no LLM request. The
      // fresh session sits idle at zero API cost, and the note is already in
      // context whenever someone next prompts it.
      const cold = pending?.cold === true;
      let kickoff: string;
      const conversationId = pending?.conversation_id;
      const continuation = conversationId
        ? `\n\nContinuing conversation ${conversationId}.`
        : "";
      if (pending?.note && pending.note.trim()) {
        kickoff = pending.note.trim() + continuation;
      } else if (cold) {
        kickoff =
          "Your session was replaced to shed stale context while you were idle. " +
          "No work is in flight. Await instructions." + continuation;
      } else {
        kickoff =
          "You respawned to shed stale context. Continue your current work." +
          continuation;
      }

      // Flag before newSession: cleanShutdown (session_shutdown) reads it to
      // broadcast a respawning status and keep the registry entry alive.
      respawning = true;
      const parentSession = ctx.sessionManager.getSessionFile();

      let cancelled = true;
      try {
        // Only plain data (strings) crosses into these callbacks: captured
        // pi/ctx/sessionManager objects are stale after replacement and throw.
        const result = await ctx.newSession({
          parentSession,
          setup: async (sm) => {
            // Stored, not sent: appendMessage writes the note into the fresh
            // session's history without dispatching a request. Used for cold
            // only; the warm path delivers the same text as a real prompt.
            if (cold) {
              sm.appendMessage({
                role: "user",
                content: [{ type: "text", text: kickoff }],
                timestamp: Date.now(),
              });
            }
          },
          // Omitted entirely when cold: any withSession callback that sends a
          // message would trigger the turn this path exists to avoid.
          ...(cold
            ? {}
            : {
                withSession: async (freshCtx) => {
                  await freshCtx.sendUserMessage(kickoff);
                },
              }),
        });
        cancelled = result.cancelled === true;
      } catch {
        cancelled = true;
      }

      if (cancelled) {
        respawning = false;
        try {
          await broadcastStatus(agentRunning);
        } catch {
          /* ignore */
        }
        try {
          ctx.ui.notify("coms: respawn cancelled", "warning");
        } catch {
          /* ignore */
        }
      }
    },
  });

  // ━━ /coms-setup slash command ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Wires the global justfile shim (see extensions/coms-setup.ts). Pass this
  // file's own URL: provenance matches the command entry that loaded it.
  registerComsSetup(pi, import.meta.url);

  // ━━ Clean shutdown ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  let shuttingDown = false;
  async function cleanShutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    // Respawn keeps the registry entry alive across the shutdown/start gap;
    // peers are told the transition is intentional (respawning), not a close.
    const isRespawn = respawning;
    // Cascade shutdown to subagents — kill the subs tmux session before any
    // await so this runs synchronously even under abrupt kill (SIGHUP/SIGTERM).
    if (identity) {
      try {
        spawnSync("tmux", ["kill-session", "-t", `${identity.name}-subs`]);
      } catch {
        /* no subs session — ignore */
      }
    }
    await broadcastStatus(false, !isRespawn, isRespawn);
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
      if (!isRespawn) {
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
      }
      try {
        pi.appendEntry("coms-log", {
          event: isRespawn ? "respawn" : "shutdown",
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
