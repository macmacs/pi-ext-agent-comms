/**
 * Subagent Widget — spawn and manage subagents (tmux or headless)
 *
 * Each subagent is a full Pi instance. In tmux mode it runs as a TUI in a
 * detached tmux window. In headless mode it runs as `pi --mode rpc` with an
 * open stdin pipe as a keepalive, no TTY required (k8s / batch pipelines).
 *
 * Backend selection (subagent_create):
 *   PI_SUBAGENT_BACKEND=tmux     — force tmux (requires TMUX env; errors otherwise)
 *   PI_SUBAGENT_BACKEND=headless — force headless
 *   (unset)                      — tmux when TMUX present, headless otherwise
 *
 * Headless subagents always spawn headless children (TMUX is stripped from
 * their env and PI_SUBAGENT_BACKEND=headless is propagated).
 *
 * Usage: pi -e extensions/subagent-widget.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "fs";
import * as net from "node:net";
import * as crypto from "node:crypto";
import * as os from "os";
import * as path from "path";
import { pickSubagentName } from "./naming.ts";

const { execFile, spawn } = require("child_process") as typeof import("child_process");

// ── Backend selector ──────────────────────────────────────────────────────────

function resolveBackendMode(requestHeadless?: boolean): "tmux" | "headless" {
  const override = process.env.PI_SUBAGENT_BACKEND;
  // System-level env override takes highest priority.
  if (override === "tmux") {
    if (!process.env.TMUX)
      throw new Error(
        "PI_SUBAGENT_BACKEND=tmux requires a tmux session — unset the override or run inside tmux",
      );
    return "tmux";
  }
  if (override === "headless") return "headless";
  // Tool-level request.
  if (requestHeadless) return "headless";
  // Default: tmux when available, headless otherwise.
  return process.env.TMUX ? "tmux" : "headless";
}

// ── Coms socket injection ─────────────────────────────────────────────────────

// Sends the initial task to a freshly-spawned subagent via its coms unix socket.
// Works for both backends: coms.ts binds the socket *before* writing the registry
// file, so registry presence guarantees the socket is ready.
async function sendInitialTaskViaComs(
  comsName: string,
  comsProject: string,
  task: string,
  parentName: string,
): Promise<void> {
  const comsDir =
    process.env.PI_COMS_DIR || path.join(os.homedir(), ".pi", "coms");

  const subRegistryFile = path.join(
    comsDir,
    "projects",
    comsProject,
    "agents",
    `${comsName}.json`,
  );
  const subEntry = JSON.parse(fs.readFileSync(subRegistryFile, "utf-8"));
  const endpoint = subEntry.endpoint as string;

  // Best-effort: use parent's real identity as sender.
  let senderSession = crypto.randomBytes(8).toString("hex");
  let senderEndpoint = "";
  try {
    const parentRegistryFile = path.join(
      comsDir,
      "projects",
      parentName,
      "agents",
      `${parentName}.json`,
    );
    const parentEntry = JSON.parse(
      fs.readFileSync(parentRegistryFile, "utf-8"),
    );
    senderSession = parentEntry.session_id;
    senderEndpoint = parentEntry.endpoint;
  } catch {
    /* use generated fallbacks */
  }

  const envelope = {
    type: "prompt",
    msg_id: crypto.randomBytes(10).toString("hex"),
    sender_session: senderSession,
    sender_endpoint: senderEndpoint,
    sender_name: parentName,
    sender_cwd: process.cwd(),
    hops: 0,
    timestamp: new Date().toISOString(),
    prompt: task,
    conversation_id: null,
  };

  await new Promise<void>((resolve, reject) => {
    const sock = net.createConnection({ path: endpoint });
    let settled = false;
    let buf = "";
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
    const timer = setTimeout(
      () => fail(new Error("coms inject timeout")),
      5_000,
    );
    sock.once("error", fail);
    sock.once("connect", () => {
      try {
        sock.write(JSON.stringify(envelope) + "\n");
      } catch (err) {
        clearTimeout(timer);
        fail(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      sock.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf-8");
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          sock.end();
        } catch {
          /* ignore */
        }
        try {
          const resp = JSON.parse(buf.slice(0, nl));
          if (resp.type === "nack") reject(new Error(resp.error || "nack"));
          else resolve();
        } catch {
          reject(new Error("malformed response from coms socket"));
        }
      });
      sock.once("close", () => {
        if (!settled) fail(new Error("connection closed before ack"));
      });
    });
  });
}

// ── Tmux helpers ──────────────────────────────────────────────────────────────

function tmux(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("tmux", args, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

function currentTmuxSession(): Promise<string> {
  return tmux("display-message", "-p", "#S");
}

// ── Coms registry polling ─────────────────────────────────────────────────────

// Wait for the subagent's coms registry entry to appear — confirms coms
// session_start completed and the socket is bound.
async function waitForComsRegistry(
  comsName: string,
  project: string,
  timeoutMs = 15_000,
): Promise<boolean> {
  const comsDir =
    process.env.PI_COMS_DIR || path.join(os.homedir(), ".pi", "coms");
  const registryFile = path.join(
    comsDir,
    "projects",
    project,
    "agents",
    `${comsName}.json`,
  );
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise<void>((r) => setTimeout(r, 150));
    if (fs.existsSync(registryFile)) return true;
  }
  return false;
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Agent file discovery ──────────────────────────────────────────────────────

interface AgentDef {
  name: string;
  description: string;
  tools?: string;
  model?: string;
  filePath: string;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    if (key && val) result[key] = val;
  }
  return result;
}

function scanAgentDir(dir: string): AgentDef[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => {
        const filePath = path.join(dir, f);
        const content = fs.readFileSync(filePath, "utf8");
        const fm = parseFrontmatter(content);
        return {
          name: fm.name ?? f.slice(0, -3),
          description: fm.description ?? "",
          tools: fm.tools,
          model: fm.model,
          filePath,
        };
      });
  } catch {
    return [];
  }
}

function buildAgentsTable(defs: AgentDef[]): string {
  if (defs.length === 0) return "";
  let out =
    `## Available Specialist Agents\n\n` +
    `You have permission to spawn any of these autonomously — no need to ask first. ` +
    `Spawned subagents are persistent: their context window stays intact between messages, so you can ` +
    `send follow-up questions or additional tasks to the same agent via coms_send rather than spawning a new one. ` +
    `Prefer delegation when a task is self-contained, would consume significant context, ` +
    `or fits a specialist's profile — and treat spawned agents as long-lived collaborators rather than single-use workers.` +
    ` Use \`subagent_create(task: "...", agent: "<name>")\` to spawn and \`coms_send\` to continue the conversation.\n\n`;
  for (const d of defs)
    out += `- **${d.name}**: ${d.description}${d.model ? ` _(model: ${d.model})_` : ""}\n`;
  return out;
}

function findProjectAgentDir(): string | undefined {
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, ".pi", "agents");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function resolveAgentFile(name: string): string | undefined {
  const projectDir = findProjectAgentDir();
  if (projectDir) {
    const local = path.join(projectDir, `${name}.md`);
    if (fs.existsSync(local)) return local;
  }
  const global_ = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "agents",
    `${name}.md`,
  );
  if (fs.existsSync(global_)) return global_;
  return undefined;
}

// ── State ─────────────────────────────────────────────────────────────────────

interface SubState {
  id: number;
  task: string;
  comsName: string;
  sessionFile: string;
  startedAt: number;
  mode: "tmux" | "headless";
  // tmux only
  tmuxSession?: string;
  tmuxWindow?: string;
  // headless only
  pid?: number;
  logPath?: string;
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const agents: Map<number, SubState> = new Map();
  let nextId = 1;
  let agentDefs: AgentDef[] = [];
  let agentsTable = "";
  let scopedModelsNote = "";

  function makeSessionFile(id: number): string {
    const dir = path.join(
      os.homedir(),
      ".pi",
      "agent",
      "sessions",
      "subagents",
    );
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `subagent-${id}-${Date.now()}.jsonl`);
  }

  function makeLogFile(id: number): string {
    const dir = path.join(
      os.homedir(),
      ".pi",
      "agent",
      "sessions",
      "subagents",
    );
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `subagent-${id}-${Date.now()}.log`);
  }

  // ── Liveness ───────────────────────────────────────────────────────────────

  async function isAlive(state: SubState): Promise<boolean> {
    if (state.mode === "headless") {
      if (!state.pid) return false;
      try {
        process.kill(state.pid, 0);
        return true;
      } catch {
        return false;
      }
    }
    // tmux path
    try {
      const windows = await tmux(
        "list-windows",
        "-t",
        state.tmuxSession!,
        "-F",
        "#{window_name}",
      );
      return windows.split("\n").includes(state.tmuxWindow!);
    } catch {
      return false;
    }
  }

  // ── Cascade kill headless children ─────────────────────────────────────────

  function killHeadlessChildren(): void {
    for (const state of agents.values()) {
      if (state.mode === "headless" && state.pid) {
        try {
          process.kill(-state.pid, "SIGTERM");
        } catch {
          /* already dead */
        }
      }
    }
  }

  // Register on process exit so cascade fires even on abrupt termination.
  // POSIX only — process.kill(-pid) is not supported on Windows.
  if (process.platform !== "win32") {
    process.on("exit", killHeadlessChildren);
  }

  // ── Spawn ──────────────────────────────────────────────────────────────────

  async function spawnSubagent(
    task: string,
    purposeOverride: string | undefined,
    agentName: string | undefined,
    modelOverride: string | undefined,
    mode: "tmux" | "headless",
    ctx: any,
  ): Promise<SubState> {
    const id = nextId++;
    const sessionFile = makeSessionFile(id);
    const parentName = process.env.PI_COMS_NAME ?? "agent";

    // Collision-safe subagent name from parent's coms pool.
    const comsDir =
      process.env.PI_COMS_DIR || path.join(os.homedir(), ".pi", "coms");
    const poolDir = path.join(comsDir, "projects", parentName, "agents");
    const existingNames = new Set<string>();
    try {
      for (const f of fs.readdirSync(poolDir)) {
        if (f.endsWith(".json")) existingNames.add(f.slice(0, -5));
      }
    } catch {
      /* pool dir may not exist yet */
    }
    const comsName = pickSubagentName(parentName, existingNames);
    const comsProject = parentName;

    // Model: explicit > agent profile frontmatter > parent model.
    let profileModel: string | undefined;
    if (agentName) {
      const pf = resolveAgentFile(agentName);
      if (pf) profileModel = parseFrontmatter(fs.readFileSync(pf, "utf8")).model;
    }
    const model =
      modelOverride ??
      profileModel ??
      (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);

    const extDir = path.dirname(new URL(import.meta.url).pathname);
    const comsExt = path.join(extDir, "coms.ts");
    const widgetExt = path.join(extDir, "subagent-widget.ts");

    const purpose = (purposeOverride ?? task)
      .slice(0, 80)
      .replace(/\s+/g, " ")
      .trim();

    const taskWithReporting =
      task +
      `\n\nIMPORTANT: When you have completed this task, you MUST send your result back to the parent agent using the coms_send tool with target="${parentName}". Do not skip this — it is required even for simple or short tasks. Do not just reply in chat.`;

    if (mode === "headless") {
      // ── Headless: spawn pi --mode rpc with open stdin pipe ──────────────────
      const logPath = makeLogFile(id);

      const piArgs = [
        "-e", comsExt,
        "-e", widgetExt,
        "--mode", "rpc",
        "--cname", comsName,
        "--project", comsProject,
        "--session", sessionFile,
        "--purpose", purpose,
        ...(model ? ["--model", model] : []),
      ];

      // Strip TMUX from env and lock children to headless so the constraint
      // propagates down the tree without any per-level special casing.
      const childEnv: Record<string, string> = {
        ...(process.env as Record<string, string>),
      };
      delete childEnv.TMUX;
      delete childEnv.TMUX_PANE;
      childEnv.PI_SUBAGENT_BACKEND = "headless";
      childEnv.PI_PARENT_SESSION = parentName;
      childEnv.PI_COMS_PROJECT = comsProject;
      if (agentName) childEnv.PI_AGENT_PROFILE = agentName;

      const logFd = fs.openSync(logPath, "w");
      const child = spawn("pi", piArgs, {
        detached: true,
        stdio: ["pipe", logFd, logFd],
        env: childEnv,
      });
      fs.closeSync(logFd); // close our copy; child holds its own fd
      child.unref();

      const ready = await waitForComsRegistry(comsName, comsProject);
      if (!ready) {
        if (process.platform !== "win32" && child.pid) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            /* ignore */
          }
        }
        throw new Error(
          `subagent ${comsName} did not initialise within timeout — log: ${logPath}`,
        );
      }

      await sendInitialTaskViaComs(comsName, comsProject, taskWithReporting, parentName);

      const state: SubState = {
        id,
        task,
        comsName,
        sessionFile,
        startedAt: Date.now(),
        mode: "headless",
        pid: child.pid,
        logPath,
      };
      agents.set(id, state);
      return state;
    } else {
      // ── Tmux: spawn pi TUI in a detached tmux window ─────────────────────
      const piCmd = [
        "pi",
        "-e", shellQuote(comsExt),
        "-e", shellQuote(widgetExt),
        "--cname", shellQuote(comsName),
        "--project", shellQuote(comsProject),
        "--session", shellQuote(sessionFile),
        "--purpose", shellQuote(purpose),
        ...(model ? ["--model", shellQuote(model)] : []),
      ].join(" ");

      const parentSession = await currentTmuxSession();
      const subsSession = `${process.env.PI_COMS_NAME ?? parentSession}-subs`;
      const tmuxWindow = comsName;
      const envArgs = [
        "-e", `PI_PARENT_SESSION=${parentSession}`,
        "-e", `PI_COMS_PROJECT=${comsProject}`,
        ...(agentName ? ["-e", `PI_AGENT_PROFILE=${agentName}`] : []),
      ];

      try {
        await tmux(
          "new-session", "-d", "-s", subsSession, "-n", tmuxWindow,
          ...envArgs, piCmd,
        );
      } catch {
        await tmux(
          "new-window", "-t", subsSession, "-n", tmuxWindow,
          ...envArgs, piCmd,
        );
      }

      const ready = await waitForComsRegistry(comsName, comsProject);
      if (!ready)
        throw new Error(
          `subagent ${comsName} did not initialise within timeout`,
        );

      await sendInitialTaskViaComs(comsName, comsProject, taskWithReporting, parentName);

      const state: SubState = {
        id,
        task,
        comsName,
        sessionFile,
        startedAt: Date.now(),
        mode: "tmux",
        tmuxSession: subsSession,
        tmuxWindow,
      };
      agents.set(id, state);
      return state;
    }
  }

  // ── LLM tools ──────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "subagent_create",
    description:
      "Spawn a background subagent running a full Pi instance. In tmux environments the subagent runs as an interactive TUI; otherwise it runs headlessly. The subagent is automatically instructed to report results back to you via coms_send — do not repeat this in the task. Write the task as a natural prompt; it is delivered as the subagent's first user message. Returns the subagent ID and tmux session name. Backend mode is determined by the environment — do not try to control it.",
    parameters: Type.Object({
      task: Type.String({
        description: "The complete task description for the subagent to perform",
      }),
      purpose: Type.Optional(
        Type.String({
          description:
            "Short label (≤80 chars) shown in the coms pool widget. Defaults to the first 80 chars of task.",
        }),
      ),
      agent: Type.Optional(
        Type.String({
          description:
            "Name of a specialist agent profile to apply (stem of a .md file in .pi/agents/ or ~/.pi/agent/agents/). The file's full contents are appended to the subagent's system prompt.",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "Model to run the subagent on, as 'provider/id' (e.g. 'openrouter/google/gemini-3-flash-preview'). Overrides the agent profile's model and the parent's model. Use this to run cheaper workers on cheaper models.",
        }),
      ),
    }),
    execute: async (_callId, args, _signal, _onUpdate, ctx) => {
      let backendMode: "tmux" | "headless";
      try {
        backendMode = resolveBackendMode();
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: err instanceof Error ? err.message : String(err),
            },
          ],
        };
      }

      if (args.agent && !resolveAgentFile(args.agent)) {
        return {
          content: [
            {
              type: "text",
              text: `Agent profile "${args.agent}" not found in .pi/agents/ or ~/.pi/agent/agents/.`,
            },
          ],
        };
      }

      let state: SubState;
      try {
        state = await spawnSubagent(
          args.task,
          args.purpose,
          args.agent,
          args.model,
          backendMode,
          ctx,
        );
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to spawn subagent: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }

      const detail =
        state.mode === "tmux"
          ? `tmux: "${state.tmuxSession}"`
          : `headless pid=${state.pid} · log: "${state.logPath}"`;

      return {
        content: [
          {
            type: "text",
            text: `Subagent #${state.id} spawned  ·  ${detail}  ·  coms: "${state.comsName}"  ·  use coms_send target="${state.comsName}" to send it messages  ·  it will report back to you at "${process.env.PI_COMS_NAME}" when done. Do not sleep, poll, or wait for its reply — you'll be automatically resumed when it responds. Continue with other work or end your turn.`,
          },
        ],
      };
    },
  });

  pi.registerTool({
    name: "subagent_list",
    description: "List all active subagents with their IDs and session names.",
    parameters: Type.Object({}),
    execute: async () => {
      const alive: string[] = [];
      for (const s of agents.values()) {
        if (await isAlive(s)) {
          const detail =
            s.mode === "tmux"
              ? `tmux=${s.tmuxSession}`
              : `pid=${s.pid}`;
          alive.push(
            `#${s.id}  [${s.mode}]  coms=${s.comsName}  ${detail}  "${s.task}"`,
          );
        } else {
          agents.delete(s.id);
        }
      }
      if (alive.length === 0) {
        return { content: [{ type: "text", text: "No active subagents." }] };
      }
      return { content: [{ type: "text", text: alive.join("\n") }] };
    },
  });

  // ── Session lifecycle ──────────────────────────────────────────────────────

  pi.on("session_start", async (_event, _ctx) => {
    agents.clear();
    nextId = 1;

    // Scan agent profile dirs — project-local first, then global.
    // Deduplicate by name: project-local files shadow global ones.
    const localDefs = scanAgentDir(findProjectAgentDir() ?? "");
    const globalDefs = scanAgentDir(
      path.join(os.homedir(), ".pi", "agent", "agents"),
    );
    const seen = new Set(localDefs.map((d) => d.name));
    agentDefs = [...localDefs, ...globalDefs.filter((d) => !seen.has(d.name))];
    agentsTable = buildAgentsTable(agentDefs);

    // Read scoped/enabled models from settings.json for subagent spawning guidance.
    try {
      const settingsPath = path.join(
        os.homedir(),
        ".pi",
        "agent",
        "settings.json",
      );
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      const enabledModels: string[] = settings.enabledModels ?? [];
      if (enabledModels.length > 0) {
        const list = enabledModels.map((m: string) => `- ${m}`).join("\n");
        scopedModelsNote = `\n\n## Available Models for Subagents\nWhen spawning subagents and no agent profile specifies a model, choose only from this list:\n${list}`;
      }
    } catch {
      /* settings.json missing or malformed */
    }

    const ownComsName = process.env.PI_COMS_NAME;
    const isSubagent = !!process.env.PI_PARENT_SESSION;
    const projectArgIdx = process.argv.indexOf("--project");
    const projectArgVal =
      projectArgIdx >= 0 ? process.argv[projectArgIdx + 1] : undefined;
    const parentComsName =
      isSubagent && projectArgVal && projectArgVal !== "default"
        ? projectArgVal
        : undefined;

    const agentProfileName = process.env.PI_AGENT_PROFILE;
    let agentProfileBody: string | undefined;
    if (agentProfileName) {
      const profilePath = resolveAgentFile(agentProfileName);
      if (profilePath) {
        const raw = fs.readFileSync(profilePath, "utf8");
        agentProfileBody = raw.replace(/^---[\s\S]*?\n---\n?/, "").trimStart();
      }
    }

    pi.on("before_agent_start", async (event) => {
      let sp = event.systemPrompt;
      if (ownComsName) {
        sp += `\n\nYour coms name is "${ownComsName}".`;
      }
      if (isSubagent) {
        sp += ` You are a subagent. When you have completed your task, you MUST send your result back to your parent agent using the coms_send tool with target="${parentComsName}". Do not finish without doing this.`;
      }
      if (!isSubagent) {
        sp += `\n\n## Directory Exploration & Recon\n\nWhen you are asked to explore, scan, or map out directories, search across the codebase, or do any broad recon (finding files, grepping, understanding structure), prefer spawning a subagent to do it rather than exploring directly. Work from the subagent's reported findings. This keeps large directory listings and file contents out of your own context window. If a suitable specialist agent (such as a scout/recon profile) is listed below, delegate to it.`;
      }
      if (agentProfileBody) {
        sp += `\n\n## Agent Profile: ${agentProfileName}\n\n${agentProfileBody}`;
      }
      if (agentsTable) {
        sp += `\n\n${agentsTable}`;
      }
      if (scopedModelsNote) {
        sp += scopedModelsNote;
      }
      return { systemPrompt: sp };
    });
  });

  pi.on("session_shutdown", async () => {
    killHeadlessChildren();
  });
}
