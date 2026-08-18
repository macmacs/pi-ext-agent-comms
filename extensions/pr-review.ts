/**
 * PR Review — Autonomous multi-model peer review via coms
 *
 * For each review aspect found in .claude/agents/, spawns two Pi agents
 * (Claude Sonnet + GPT-5.4) as peers in tmux panes. They communicate directly
 * via coms.ts, explore the diff and codebase autonomously, discuss findings,
 * fact-check each other, and write agreed conclusions to findings files.
 * A synthesis step compiles all findings into a final review document.
 *
 * Before pairs kick off, a dedicated context agent runs first: it follows
 * Jira/Confluence links from the PR description, reads the diff, and writes
 * CONTEXT.md so every reviewer starts with the same picture.
 *
 * Usage:
 *   pi -e extensions/coms.ts -e extensions/pr-review.ts \
 *      --cname pr-orchestrator --project pr-review
 *
 * Then: review_pr({ ticket: "4876", agents_root: "/path/to/airflow-dags-v2" })
 *
 * Environment:
 *   BITBUCKET_BEARER_TOKEN  — for PR description fetch (optional but recommended)
 *   PR_REVIEW_MODEL_A       — override Agent A model
 *   PR_REVIEW_MODEL_B       — override Agent B model
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const execFileAsync = promisify(execFile);

// ── Config ────────────────────────────────────────────────────────────────────

const MODEL_A = process.env.PR_REVIEW_MODEL_A ?? "rakuten-bedrock/us.anthropic.claude-sonnet-4-6";
const MODEL_B = process.env.PR_REVIEW_MODEL_B ?? "rakuten-codex/gpt-5.4";
const COMS_PROJECT = "pr-review";
const COMS_DIR = path.join(os.homedir(), ".pi", "coms");

const PAIR_REGISTER_TIMEOUT_MS = 120_000;  // 2 min for Pi to start + coms register
const PAIR_REVIEW_TIMEOUT_MS   = 45 * 60_000; // 45 min hard cap
const POLL_INTERVAL_MS         = 4_000;

// ── Types ─────────────────────────────────────────────────────────────────────

type MergeState = "merged" | "base-only" | "repo-only";

interface AspectDef {
  short:            string;
  displayName:      string;
  file:             string;
  systemPromptBody: string;
  mergeState:       MergeState;
}

type PairPhase =
  | "pending"
  | "spawning"
  | "registering"
  | "discussing"
  | "done"
  | "error";

interface PairState {
  aspect:       AspectDef;
  phase:        PairPhase;
  errorMsg?:    string;
  startedAt?:   number;
  durationMs?:  number;
  findingsFile: string;
  sentinelFile: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function stripFrontmatter(raw: string): string {
  const m = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return m ? m[1].trim() : raw.trim();
}

function parseFrontmatterFields(raw: string): Record<string, string> {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return {};
  const fields: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return fields;
}

// ── Aspect scanning ───────────────────────────────────────────────────────────

// Read all *-agent.md files from a directory into a map of filename → raw content.
// Returns an empty map if the directory doesn't exist.
function readAgentFiles(dir: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!fs.existsSync(dir)) return result;
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith("-agent.md")) continue;
    result.set(file, fs.readFileSync(path.join(dir, file), "utf-8"));
  }
  return result;
}

// Parse the allowed-tools frontmatter field into an array of trimmed strings.
// Handles both comma-separated and YAML-list forms (though we write comma-sep).
function parseAllowedTools(value: string | undefined): string[] {
  if (!value) return [];
  // Strip surrounding brackets if present (YAML inline sequence)
  const stripped = value.replace(/^\[|\]$/g, "").trim();
  return stripped.split(",").map(s => s.trim()).filter(Boolean);
}

function scanAspects(projectRoot: string, extensionsDir: string): AspectDef[] {
  // ── Layer 1: agnostic agents shipped alongside this extension ────────────
  const agnosticDir = path.join(extensionsDir, "agents");
  const agnosticFiles = readAgentFiles(agnosticDir);

  // ── Layer 2: repo agents — try the exact path first, then subdirectories ─
  // This lets agents_root be a parent dir (e.g. /pr-review/master) and still
  // find agents in a child like airflow-dags-v2/.claude/agents/.
  const candidates = [projectRoot];
  try {
    for (const entry of fs.readdirSync(projectRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(projectRoot, entry.name));
    }
  } catch { /* projectRoot may not exist */ }

  let repoFiles = new Map<string, string>();
  for (const root of candidates) {
    const agentDir = path.join(root, ".claude", "agents");
    const found = readAgentFiles(agentDir);
    if (found.size > 0) { repoFiles = found; break; }
  }

  // ── Build union of all filenames seen ────────────────────────────────────
  const allFiles = new Set([...agnosticFiles.keys(), ...repoFiles.keys()]);
  if (allFiles.size === 0) return [];

  const aspects: AspectDef[] = [];

  for (const file of [...allFiles].sort()) {
    const hasAgnostic = agnosticFiles.has(file);
    const hasRepo     = repoFiles.has(file);

    const mergeState: MergeState = hasAgnostic && hasRepo
      ? "merged"
      : hasAgnostic
      ? "base-only"
      : "repo-only";

    if (mergeState === "repo-only") {
      // Repo-only: exact existing behaviour
      const raw    = repoFiles.get(file)!;
      const fields = parseFrontmatterFields(raw);
      if (!fields.name) continue;
      aspects.push({
        short:            file.replace(/-agent\.md$/, ""),
        displayName:      fields.description || fields.name,
        file,
        systemPromptBody: stripFrontmatter(raw),
        mergeState,
      });
      continue;
    }

    if (mergeState === "base-only") {
      // Agnostic-only: same structure, no repo supplement
      const raw    = agnosticFiles.get(file)!;
      const fields = parseFrontmatterFields(raw);
      if (!fields.name) continue;
      aspects.push({
        short:            file.replace(/-agent\.md$/, ""),
        displayName:      fields.description || fields.name,
        file,
        systemPromptBody: stripFrontmatter(raw),
        mergeState,
      });
      continue;
    }

    // ── merged ────────────────────────────────────────────────────────────
    const agnosticRaw = agnosticFiles.get(file)!;
    const repoRaw     = repoFiles.get(file)!;
    const agnosticF   = parseFrontmatterFields(agnosticRaw);
    const repoF       = parseFrontmatterFields(repoRaw);

    // Validate name field consistency
    if (agnosticF.name && repoF.name && agnosticF.name !== repoF.name) {
      throw new Error(
        `Aspect merge conflict: agnostic "${agnosticF.name}" vs repo "${repoF.name}" in ${file}. ` +
        `The "name" frontmatter field must match.`,
      );
    }

    // Merge frontmatter fields
    const name        = repoF.name        || agnosticF.name        || "";
    const description = repoF.description || agnosticF.description || "";
    const model       = repoF.model       || agnosticF.model       || "";

    // allowed-tools: union of both layers
    const agnosticTools = parseAllowedTools(agnosticF["allowed-tools"]);
    const repoTools     = parseAllowedTools(repoF["allowed-tools"]);
    const mergedTools   = [...new Set([...agnosticTools, ...repoTools])];

    // Body: agnostic first, then separator + repo body
    const agnosticBody = stripFrontmatter(agnosticRaw);
    const repoBody     = stripFrontmatter(repoRaw);
    const mergedBody   = repoBody
      ? `${agnosticBody}\n\n---\n\n## Codebase-Specific Context\n\n${repoBody}`
      : agnosticBody;

    if (!name) continue;

    aspects.push({
      short:            file.replace(/-agent\.md$/, ""),
      displayName:      description || name,
      file,
      systemPromptBody: mergedBody,
      mergeState,
    });
  }

  return aspects;
}

// ── PR context gathering ──────────────────────────────────────────────────────

// Collect the bare minimum mechanically — fast API calls only.
// The context agent uses this as a starting point.
async function fetchPRSeed(workdir: string): Promise<string> {
  const token = process.env.BITBUCKET_BEARER_TOKEN;
  const parts: string[] = [];

  // Branch
  const { stdout: branchOut } = await execFileAsync("git", ["-C", workdir, "branch", "--show-current"]);
  const branch = branchOut.trim();
  parts.push(`**Branch:** ${branch}`);

  // Commit log
  try {
    const { stdout: logOut } = await execFileAsync("git", [
      "-C", workdir, "log", "development..HEAD", "--oneline", "--no-merges",
    ]);
    if (logOut.trim()) parts.push("", "## Commits (development..HEAD)", "```", logOut.trim(), "```");
  } catch { /* best-effort */ }

  // Changed files with diff stat
  try {
    const { stdout: statOut } = await execFileAsync("git", [
      "-C", workdir, "diff", "development...HEAD", "--stat", "--stat-width=120",
    ]);
    if (statOut.trim()) parts.push("", "## Diff stat", "```", statOut.trim(), "```");
  } catch { /* best-effort */ }

  // Remote URL -> parse Bitbucket coords
  const { stdout: remoteOut } = await execFileAsync("git", ["-C", workdir, "remote", "get-url", "origin"]);
  const remoteUrl = remoteOut.trim();

  // PR description via Bitbucket REST
  let prDescription = "";
  if (token) {
    // Try HTTPS first: https://host/scm/PROJECT/repo
    let m = remoteUrl.match(/https?:\/\/([^/]+)\/scm\/([^/]+)\/([^/.]+)/);
    // Fall back to SSH: ssh://git@host:port/PROJECT/repo.git
    if (!m) {
      const s = remoteUrl.match(/ssh:\/\/[^@]+@([^:/]+)(?::\d+)?\/([^/]+)\/([^/.]+)/);
      if (s) m = s;
    }
    if (m) {
      const [, bbHost, project, repo] = m;
      const encodedBranch = encodeURIComponent(branch);
      try {
        const resp = await fetch(
          `https://${bbHost}/rest/api/1.0/projects/${project.toUpperCase()}/repos/${repo}/pull-requests` +
          `?at=refs/heads/${encodedBranch}&state=OPEN&direction=OUTGOING&limit=1`,
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(10_000),
          },
        );
        const data: any = await resp.json();
        prDescription = data?.values?.[0]?.description ?? "";
      } catch { /* best-effort */ }
    }
  }

  if (prDescription) {
    parts.push("", "## PR Description", prDescription);
  } else {
    parts.push("", "## PR Description", "*(no PR description found — BITBUCKET_BEARER_TOKEN may not be set)*");
  }

  return parts.join("\n");
}

// Spawn a dedicated context-gathering subagent before review pairs kick off.
// It receives a PR seed (branch, diff stat, PR description) and uses its own
// tool access to follow Jira/Confluence links, read child pages, etc.
// Writes CONTEXT.md + a sentinel file when done.
async function runContextAgent(opts: {
  workdir:     string;
  outdir:      string;
  model:       string;
  onProgress?: (msg: string) => void;
}): Promise<string> {
  const { workdir, outdir, model, onProgress } = opts;
  const contextFile  = path.join(outdir, "CONTEXT.md");
  const sentinelFile = path.join(outdir, ".context-done");

  // Use /tmp so logging works regardless of whether outdir exists yet
  const logFile = path.join(os.tmpdir(), "pr-review-context.log");
  const log = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try { fs.appendFileSync(logFile, line); } catch { /* ignore */ }
    onProgress?.(msg);
  };

  // Truncate log from any previous run
  try { fs.writeFileSync(logFile, ""); } catch { /* ignore */ }

  log(`runContextAgent start — workdir=${workdir} outdir=${outdir} model=${model}`);

  log("fetchPRSeed: start");
  const seed = await fetchPRSeed(workdir);
  log(`fetchPRSeed: done (${seed.length} chars)`);

  // Ensure outdir exists before writing prompt/context files
  fs.mkdirSync(outdir, { recursive: true });

  const promptFile = path.join(outdir, "context-agent-prompt.txt");
  const prompt = [
    "You are gathering context for a code review. Produce a thorough CONTEXT.md that",
    "reviewer agents will read before they start their analysis.",
    "",
    `Write the file to: ${contextFile}`,
    "",
    "When done, signal completion:",
    `  bash: echo done > ${sentinelFile}`,
    "",
    "---",
    "",
    "## What to include",
    "",
    "1. PR summary -- what the change is trying to do, in plain terms.",
    "2. Jira ticket -- fetch with `jira get-issue <KEY>` (outputs JSON). Include summary,",
    "   description, and acceptance criteria. Follow linked tickets if relevant.",
    "3. Specification -- fetch with `confluence get-page <PAGE_ID>` (writes XML to",
    "   /tmp/confluence/<id>/page.xml). Read child pages if they add useful detail",
    "   (data models, API contracts, etc.) using `confluence get-page-children <ID>`.",
    "4. Test Evidence page -- the PR description follows a standard template with a",
    "   'Test Evidence :' field containing a Confluence URL. Extract the page ID from",
    "   that URL (the numeric segment after /pages/) and include it verbatim in",
    "   CONTEXT.md under a '## Test Evidence' section, like this:",
    "     ## Test Evidence",
    "     Page ID: 6537611678",
    "   If the field is blank or absent, write: Page ID: none",
    "   Do not fetch the test page itself -- a dedicated reviewer agent will do that.",
    "5. Diff overview -- run `git diff development...HEAD --stat` and",
    `   \`git log development..HEAD --oneline\` in ${workdir}.`,
    "6. Key design decisions -- constraints, non-obvious choices, out-of-scope items",
    "   from Jira/Confluence that reviewers should know.",
    "",
    "Keep it factual. Don't pad. Reviewers will use this to calibrate their analysis.",
    "",
    "---",
    "",
    "## Seed data (mechanically gathered -- use as a starting point)",
    "",
    seed,
    "",
    "---",
    "",
    "Tools available:",
    "  jira get-issue <KEY>",
    "  confluence get-page <PAGE_ID>",
    "  confluence get-page-children <PAGE_ID>",
    `  git -C ${workdir} <command>`,
  ].join("\n");

  fs.writeFileSync(promptFile, prompt);
  log(`Prompt written to: ${promptFile}`);
  log(`Spawning: pi --no-extensions -p --mode json --model ${model} @${promptFile}`);

  const CONTEXT_TIMEOUT_MS = 10 * 60_000; // 10 min hard cap

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      "pi",
      ["--no-extensions", "-p", "--mode", "json", "--model", model, `@${promptFile}`],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
    );

    log(`PID: ${proc.pid}`);

    const timer = setTimeout(() => {
      log("TIMEOUT — killing context agent");
      proc.kill("SIGTERM");
      resolve();
    }, CONTEXT_TIMEOUT_MS);

    // Drain stderr to log file
    proc.stderr!.setEncoding("utf-8");
    proc.stderr!.on("data", (chunk: string) => {
      try { fs.appendFileSync(logFile, chunk); } catch { /* ignore */ }
    });

    let buf = "";
    proc.stdout!.setEncoding("utf-8");
    proc.stdout!.on("data", (chunk: string) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "message_update") {
            const ae = ev.assistantMessageEvent;
            if (ae?.type === "toolcall_start") {
              const name = ae.partial?.content?.[0]?.name ?? "tool";
              log(`  ${name}(...)`);
            } else if (ae?.type === "text_delta" && ae.delta) {
              const firstLine = ae.delta.split("\n")[0].trim();
              if (firstLine) log(`  ${firstLine.slice(0, 80)}`);
            }
          } else if (ev.type === "agent_end") {
            log(`  agent_end (willRetry=${ev.willRetry})`);
          }
        } catch { /* ignore */ }
      }
    });

    // Poll for sentinel — don't wait for the process to exit cleanly.
    // Pi subprocesses sometimes linger after completing their work.
    const sentinelPoller = setInterval(() => {
      if (fs.existsSync(sentinelFile) || fs.existsSync(contextFile)) {
        log(`Sentinel/context found — killing subprocess and resolving`);
        clearInterval(sentinelPoller);
        clearTimeout(timer);
        try { proc.kill("SIGTERM"); } catch { /* ignore */ }
        resolve();
      }
    }, 2_000);

    proc.on("close", (code: number | null) => {
      clearInterval(sentinelPoller);
      clearTimeout(timer);
      log(`Process closed (code=${code})`);
      resolve(); // resolve regardless — use fallback below if no context file
    });
    proc.on("error", (err) => {
      clearInterval(sentinelPoller);
      clearTimeout(timer);
      log(`Process error: ${err.message}`);
      resolve(); // non-fatal — fallback to seed
    });
  });

  if (!fs.existsSync(contextFile)) {
    // Fallback: write the seed so pairs are never left with nothing
    fs.writeFileSync(contextFile, `# PR Context\n\nGenerated: ${new Date().toISOString()}\n\n${seed}`);
  }

  // Append repo-specific additional context if present.
  // Walk up from workdir to find .claude/review-context.md — handles the case
  // where workdir is a worktree subdirectory and the file lives in a parent repo root.
  let reviewContextFile: string | null = null;
  let searchDir = workdir;
  while (true) {
    const candidate = path.join(searchDir, ".claude", "review-context.md");
    if (fs.existsSync(candidate)) { reviewContextFile = candidate; break; }
    const parent = path.dirname(searchDir);
    if (parent === searchDir) break; // filesystem root
    searchDir = parent;
  }
  if (reviewContextFile) {
    const extra = fs.readFileSync(reviewContextFile, "utf-8").trim();
    if (extra) {
      log(`Appending review-context.md to CONTEXT.md`);
      fs.appendFileSync(contextFile, `\n\n---\n\n## Additional Context\n\n${extra}\n`);
    }
  }

  return contextFile;
}

// ── System prompt construction ────────────────────────────────────────────────

const FINDINGS_TEMPLATE = `\
# {ASPECT} Findings

**Pair:** {MODEL_A_LABEL} (A) x {MODEL_B_LABEL} (B)
**Status:** CONSENSUS | AGREE_TO_DISAGREE

---

## Findings

<!-- One block per finding. Remove this comment when writing. -->

### N. Short title

**File:** \`path/to/file.py:line\` (or N/A)
**Severity:** BLOCKER | MAJOR | MINOR | INFO
**Agreed by:** Both | A only | B only

Description of the issue -- the what and the why. Plain prose.

**Suggested fix:** What to change.

---

## Disagreements

<!-- Fill only if Status is AGREE_TO_DISAGREE. Remove if unused. -->

### Topic

**A:** A's position.
**B:** B's position.
**Evidence examined:** What files/lines each checked.
**Unresolved because:** The root of the disagreement.

---

## Notes

Anything contextually useful that doesn't rise to a finding.`;

function buildSystemPrompt(opts: {
  aspect:       AspectDef;
  isInitiator:  boolean;
  peerCname:    string;
  workdir:      string;
  contextFile:  string;
  findingsFile: string;
  sentinelFile: string;
  modelLabel:   string;
}): string {
  const {
    aspect, isInitiator, peerCname,
    workdir, contextFile,
    findingsFile, sentinelFile, modelLabel,
  } = opts;

  const modelALabel = MODEL_A.split("/").pop()!;
  const modelBLabel = MODEL_B.split("/").pop()!;
  const filledTemplate = FINDINGS_TEMPLATE
    .replace("{ASPECT}", aspect.displayName)
    .replace("{MODEL_A_LABEL}", modelALabel)
    .replace("{MODEL_B_LABEL}", modelBLabel);

  const startupSection = isInitiator
    ? `\
## Your role in this pair

You are the **driver** (Agent A). You own the conversation and the findings file.

1. Read the context file at \`${contextFile}\`
2. Investigate the diff and codebase for your aspect.
3. Send your findings to your partner with \`coms_send({ target: "${peerCname}", prompt: "...", conversation_id: "${aspect.short}" })\`
   Your turn ends after sending. Your partner's reply arrives as a new coms-steered turn —
   no explicit await needed; just send and stop. When the reply turn fires, evaluate it,
   investigate further if warranted, and send your next message the same way.
4. Challenge their claims. Ask follow-up questions. Send as many rounds as you need.
5. When you're satisfied -- consensus or documented disagreement -- write the findings
   file and sentinel (below). Do not send another message to your partner; that closes the loop.

Don't use \`coms_list\` with \`project="*"\` -- your project is isolated to this pair.`
    : `\
## Your role in this pair

You are the **analyst** (Agent B). You respond to your partner's messages; you never initiate contact.

**Start immediately — don't wait.** As soon as you begin, proactively investigate the diff
and codebase for your aspect and form your own preliminary findings. Read the context file
at \`${contextFile}\` first, then dig into the code with your tools. The goal is to be
*primed*: by the time your partner contacts you, you should already understand the change
and have your own opinions ready, rather than starting from scratch.

**How the conversation works:** your partner sends you a message via coms. This triggers a
new turn for you. You weigh their points against the investigation you already did, dig
further where needed, then reply by calling:

\`coms_send({ target: "${peerCname}", prompt: "...", conversation_id: "${aspect.short}" })\`

Your reply is delivered when you call \`coms_send\` — it does not happen automatically.

**Do not initiate contact.** Only reply to messages your partner sends you.
**Do not write the findings file** — that is Agent A's responsibility.
**Do not use \`coms_list\`** — you only need to know your partner's name: \`${peerCname}\`.

For each message you receive:
1. Read it carefully against what you already found in your own investigation.
2. Investigate further where the message raises something you haven't checked, using
   \`bash\`, \`read\`, \`grep\`, \`find\`.
3. Call \`coms_send\` to send your analysis back to \`${peerCname}\`.

If no further messages arrive after you reply, the conversation is complete — Agent A has
written the findings. You can stop.`;

  return `\
## Your review specialisation

${aspect.systemPromptBody}

---

## Collaboration rules

You're one half of a two-model review pair. Your partner is a different AI model.

- Investigate claims before accepting them. Read the code yourself.
- Use your tools freely: \`bash\`, \`read\`, \`grep\`, \`find\`. Run git commands, check history.
- Push back when you disagree. Be specific -- quote the file and line.
- Update your position when evidence warrants it. Don't cave just to agree.
- If you can't reach consensus after genuine effort: document the disagreement clearly.

---

## What to review

Working directory: \`${workdir}\`
Branch range: \`development...HEAD\`

Start with:
\`\`\`bash
git -C ${workdir} diff development...HEAD --name-only
\`\`\`

Then explore the diff and surrounding codebase as needed.

---

## Context

A context file with the PR description, Jira ticket, specification, diff stat, and
commit log has been prepared at:

\`${contextFile}\`

Read it before you start investigating.

---

## Writing findings

This is handled by **Agent A (the driver)** when the conversation is done.
Agent B does not write findings -- just keep responding to messages.

Agent A: when you're satisfied with the analysis (consensus or documented disagreement),
write to:

\`${findingsFile}\`

Use this exact template:

${filledTemplate}

Then create the sentinel to signal completion:

\`\`\`bash
echo done > ${sentinelFile}
\`\`\`

${startupSection}
`.trim();
}

// ── coms registry polling ─────────────────────────────────────────────────────

function isAgentRegistered(cname: string, project: string): boolean {
  const f = path.join(COMS_DIR, "projects", project, "agents", `${cname}.json`);
  try {
    const entry = JSON.parse(fs.readFileSync(f, "utf-8"));
    process.kill(entry.pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForAgents(cnames: string[], project: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(cnames);
  while (pending.size > 0) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for agents to register: ${[...pending].join(", ")}`);
    }
    await sleep(2_000);
    for (const c of [...pending]) {
      if (isAgentRegistered(c, project)) pending.delete(c);
    }
  }
}

// ── tmux helpers ──────────────────────────────────────────────────────────────

function spawnPairInTmux(opts: {
  aspect:        AspectDef;
  systemPromptA: string;
  systemPromptB: string;
  comsExtPath:   string;
  tmpDir:        string;
  initialMsgA:   string;
  initialMsgB:   string;
}): { windowName: string; pairProject: string } {
  const { aspect, systemPromptA, systemPromptB, comsExtPath, tmpDir, initialMsgA, initialMsgB } = opts;
  const windowName = `pr-${aspect.short}`;

  const spA = path.join(tmpDir, `${aspect.short}-A.md`);
  const spB = path.join(tmpDir, `${aspect.short}-B.md`);
  fs.writeFileSync(spA, systemPromptA);
  fs.writeFileSync(spB, systemPromptB);

  // Escape for embedding inside single quotes in a shell command string.
  // cmdA/cmdB are shell strings that tmux hands to the user's shell --
  // internal quoting is real shell quoting, not JS string escaping.
  const shEsc = (s: string) => s.replace(/'/g, `'\\''`);

  // Each pair gets its own coms project so coms_list only shows their partner,
  // not agents from other aspect pairs running concurrently.
  const pairProject = `pr-review-${aspect.short}`;

  const cmdA =
    `pi -e '${shEsc(comsExtPath)}'` +
    ` --cname '${shEsc(`pair-${aspect.short}-A`)}'` +
    ` --project '${shEsc(pairProject)}'` +
    ` --model '${shEsc(MODEL_A)}'` +
    ` --append-system-prompt '${shEsc(spA)}'` +
    ` '${shEsc(initialMsgA)}'`;

  const cmdB =
    `pi -e '${shEsc(comsExtPath)}'` +
    ` --cname '${shEsc(`pair-${aspect.short}-B`)}'` +
    ` --project '${shEsc(pairProject)}'` +
    ` --model '${shEsc(MODEL_B)}'` +
    ` --append-system-prompt '${shEsc(spB)}'` +
    ` '${shEsc(initialMsgB)}'`;

  // Use execFileSync with array args -- no shell involved at the outer level,
  // so the quoted shell strings inside cmdA/cmdB survive intact.
  execFileSync("tmux", ["new-window", "-n", windowName, cmdA], { stdio: "ignore" });
  // new-window makes the new window current; split it immediately without -t.
  // Specifying -t name.0 doesn't work in tmux -- it can't find pane index that way.
  execFileSync("tmux", ["split-window", "-h", cmdB], { stdio: "ignore" });

  return { windowName, pairProject };
}

// ── Synthesis ─────────────────────────────────────────────────────────────────

async function runSynthesis(opts: {
  findingsDir:    string;
  outputFile:     string;
  contextSummary: string;
  model:          string;
}): Promise<void> {
  const { findingsDir, outputFile, contextSummary, model } = opts;

  const findingsFiles = fs
    .readdirSync(findingsDir)
    .filter(f => f.endsWith("-findings.md"))
    .sort();

  const findingsSections = findingsFiles.map(f => {
    const content = fs.readFileSync(path.join(findingsDir, f), "utf-8");
    const aspect = f.replace("-findings.md", "").toUpperCase();
    return `## ${aspect}\n\n${content}`;
  });

  const synthesisPrompt = `\
You are the final synthesis agent for a peer code review. Multiple reviewer pairs have
completed their analysis and written findings files below. Compile them into a single
final review document.

---

${findingsSections.join("\n\n---\n\n")}

---

## PR Context

${contextSummary}

---

## Output

Respond with ONLY the final review document as your message -- the complete markdown and
nothing else. No preamble, no confirmation, no explanation, and do NOT wrap it in a code
fence. You have no file-writing tools; your message body *is* the review. It will be saved
verbatim.

Use this structure:

# PR Review Findings

**Reviewed:** {ISO timestamp}
**Aspects covered:** N
**Findings:** N total (N blockers, N major, N minor, N info)

---

## Blockers

### [ASPECT] Title

**File:** \`path:line\`

Description. **Fix:** what to do.

---

## Major

...

## Minor

...

## Informational

...

## Disagreements

### [ASPECT] Topic

What Agent A thought. What Agent B thought. Why they couldn't resolve it.

---

Rules:
- Where findings overlap across aspects, keep the most specific one and note the overlap.
- Keep descriptions concise -- plain prose, no padding.
- Within each severity section, order alphabetically by aspect.
- Preserve every AGREE_TO_DISAGREE case in the Disagreements section.
- If no findings at a given severity, omit that section.
`.trim();

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      "pi",
      ["--mode", "json", "-p", "--no-extensions", "--model", model, synthesisPrompt],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
    );

    const textChunks: string[] = [];
    let buf = "";

    proc.stdout!.setEncoding("utf-8");
    proc.stdout!.on("data", (chunk: string) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "message_update") {
            const d = ev.assistantMessageEvent;
            if (d?.type === "text_delta") textChunks.push(d.delta ?? "");
          }
        } catch { /* ignore */ }
      }
    });

    proc.on("close", (code: number | null) => {
      let output = textChunks.join("").trim();
      // Defensive: if the model wrapped the whole document in a code fence despite
      // being told not to, unwrap it.
      const fenceM = output.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
      if (fenceM) output = fenceM[1].trim();
      fs.writeFileSync(outputFile, output);
      if (code === 0 || textChunks.length > 0) resolve();
      else reject(new Error(`Synthesis subprocess exited with code ${code}`));
    });

    proc.on("error", reject);
  });
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function(pi: ExtensionAPI) {
  let widgetCtx: any;
  const pairs: Map<string, PairState> = new Map();

  // ── Widget ───────────────────────────────────────────────────────────────

  function updateWidget() {
    if (!widgetCtx?.hasUI) return;
    widgetCtx.ui.setWidget("pr-review", (_tui: any, theme: any) => ({
      render(width: number): string[] {
        const all = [...pairs.values()];
        if (all.length === 0) return [];

        const done   = all.filter(p => p.phase === "done").length;
        const active = all.filter(p => p.phase === "discussing").length;
        const header =
          theme.fg("accent", theme.bold(" PR Review ")) +
          theme.fg("dim", `  ${done}/${all.length} done`) +
          (active > 0 ? theme.fg("accent", `  ${active} discussing`) : "");

        const lines: string[] = ["", ` ${header}`, ""];

        for (const pair of all) {
          const { phase, aspect, errorMsg, startedAt, durationMs } = pair;
          let icon: string, color: string, detail: string;

          switch (phase) {
            case "pending":
              icon = "o"; color = "dim"; detail = "pending"; break;
            case "spawning":
              icon = "o"; color = "muted"; detail = "spawning..."; break;
            case "registering":
              icon = "o"; color = "muted"; detail = "agents registering..."; break;
            case "discussing":
              icon = "*"; color = "accent";
              detail = `discussing  ${Math.round((Date.now() - startedAt!) / 1000)}s`;
              break;
            case "done":
              icon = "v"; color = "success";
              detail = `done  ${Math.round((durationMs ?? 0) / 1000)}s`;
              break;
            case "error":
              icon = "x"; color = "error"; detail = errorMsg ?? "error"; break;
          }

          const name = aspect.displayName.slice(0, 24).padEnd(24);
          const mergeTag =
            aspect.mergeState === "merged"    ? theme.fg("dim", "(m)") :
            aspect.mergeState === "base-only" ? theme.fg("dim", "(b)") :
                                                theme.fg("dim", "(r)");
          lines.push(
            truncateToWidth(
              ` ${theme.fg(color, icon)} ${theme.fg("muted", name)} ${mergeTag}  ${theme.fg(color, detail)}`,
              width,
            ),
          );
        }
        lines.push("");
        return lines;
      },
      invalidate() {},
    }), { placement: "belowEditor" });
  }

  // ── Tool ─────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "review_pr",
    label: "Review PR",
    description:
      "Run an autonomous multi-model peer review of the current PR. " +
      "First runs a context agent (reads Jira, Confluence, diff). " +
      "Then spawns N aspect pairs in tmux (Claude Sonnet 4-6 vs GPT-5.4). " +
      "Each pair investigates the diff independently, debates findings via coms, " +
      "and writes agreed conclusions. Produces a final consolidated review document.",
    parameters: Type.Object({
      ticket: Type.String({
        description: "Worktree subdirectory name (e.g. 4876). Must exist under cwd.",
      }),
      agents_root: Type.Optional(Type.String({
        description: "Directory containing .claude/agents/ with reviewer agent .md files. Defaults to cwd.",
      })),
      reviews_root: Type.Optional(Type.String({
        description: "Output directory root. Defaults to {agents_root}/reviews.",
      })),
      aspects: Type.Optional(Type.Array(Type.String(), {
        description: "Limit to specific aspects, e.g. [\"dry\",\"srp\"]. Omit to run all.",
      })),
    }),

    async execute(_callId, params, signal, onUpdate, ctx) {
      widgetCtx = ctx;
      pairs.clear();
      updateWidget();

      const cwd = ctx.cwd;
      const workdir = path.join(cwd, params.ticket);
      if (!fs.existsSync(workdir)) {
        throw new Error(`Worktree not found: ${workdir}`);
      }

      const agentsRoot  = params.agents_root ?? cwd;
      // Default reviews root: sibling of the worktree, not inside agents_root.
      // e.g. if workdir is /pr-review/4876/gcp-composer, reviews land at /pr-review/reviews/
      const reviewsRoot = params.reviews_root ?? path.join(path.dirname(path.dirname(workdir)), "reviews");
      const { stdout: headOut } = await execFileAsync("git", ["-C", workdir, "rev-parse", "HEAD"]);
      const headHash = headOut.trim().slice(0, 12);
      const outdir      = path.join(reviewsRoot, params.ticket, headHash);
      const findingsDir = path.join(outdir, "findings");
      const sentinelDir = path.join(outdir, ".done");
      const tmpDir      = path.join(os.tmpdir(), "pr-review", `${params.ticket}-${headHash}`);

      fs.mkdirSync(findingsDir, { recursive: true });
      fs.mkdirSync(sentinelDir, { recursive: true });
      fs.mkdirSync(tmpDir, { recursive: true });

      ctx.ui.setStatus("pr-review", `PR Review: ${params.ticket}`);
      onUpdate?.({ content: [{ type: "text", text: `Output: ${outdir}` }], details: { phase: "init", outdir } });

      const synthModel = ctx.model
        ? `${ctx.model.provider}/${ctx.model.id}`
        : MODEL_A;

      // ── Context agent ─────────────────────────────────────────────────────
      // Runs before any review pairs. Follows Jira/Confluence links, reads the
      // diff, and writes CONTEXT.md so every reviewer starts with the same picture.
      ctx.ui.setStatus("pr-review", `Gathering context: ${params.ticket}`);
      onUpdate?.({
        content: [{ type: "text", text: "Gathering PR context (Jira, Confluence, git log)..." }],
        details: { phase: "context" },
      });

      let contextFile: string;
      try {
        contextFile = await runContextAgent({
          workdir,
          outdir,
          model: synthModel,
          onProgress: (msg) => onUpdate?.({
            content: [{ type: "text", text: `  -> ${msg}` }],
            details: { phase: "context_progress" },
          }),
        });
      } catch (e: any) {
        throw new Error(`Context agent failed: ${e?.message ?? e}`);
      }
      onUpdate?.({
        content: [{ type: "text", text: `Context ready: ${contextFile}` }],
        details: { phase: "context_done", contextFile },
      });
      ctx.ui.setStatus("pr-review", `PR Review: ${params.ticket}`);

      // Locate extensions dir (same dir as this file — used for agnostic agents + coms.ts)
      const extensionsDir = path.dirname(new URL(import.meta.url).pathname);

      // Discover aspects (two-layer: agnostic agents + repo agents)
      let aspects = scanAspects(agentsRoot, extensionsDir);
      if (params.aspects?.length) {
        aspects = aspects.filter(a => params.aspects!.includes(a.short));
      }
      if (aspects.length === 0) {
        throw new Error(
          `No reviewer agents found in ${agentsRoot}/.claude/agents/. ` +
          `Pass agents_root pointing to the repo that has the agent definitions.`,
        );
      }

      onUpdate?.({
        content: [{ type: "text", text: `Found ${aspects.length} review aspects: ${aspects.map(a => a.short).join(", ")}` }],
        details: { phase: "aspects", aspects: aspects.map(a => a.short) },
      });

      // Log merge states for each aspect
      for (const a of aspects) {
        const stateLabel =
          a.mergeState === "merged"    ? "merged (base + repo supplement)" :
          a.mergeState === "base-only" ? "base-only" :
                                         "repo-only";
        onUpdate?.({
          content: [{ type: "text", text: `[${a.short}] ${stateLabel}` }],
          details: { phase: "aspect_merge_state", aspect: a.short, mergeState: a.mergeState },
        });
      }

      // Locate coms.ts (must be in same dir as this extension)
      const comsExtPath = path.join(extensionsDir, "coms.ts");
      if (!fs.existsSync(comsExtPath)) {
        throw new Error(`coms.ts not found at ${comsExtPath}. Load both: pi -e coms.ts -e pr-review.ts`);
      }

      // Initialise pair states
      for (const aspect of aspects) {
        pairs.set(aspect.short, {
          aspect,
          phase:        "pending",
          findingsFile: path.join(findingsDir, `${aspect.short}-findings.md`),
          sentinelFile: path.join(sentinelDir, aspect.short),
        });
      }
      updateWidget();

      // Spawn all pairs
      for (const [short, state] of pairs) {
        const { aspect, findingsFile, sentinelFile } = state;
        const cnameA = `pair-${aspect.short}-A`;
        const cnameB = `pair-${aspect.short}-B`;

        state.phase = "spawning";
        updateWidget();

        const systemPromptA = buildSystemPrompt({
          aspect, isInitiator: true, peerCname: cnameB,
          workdir, contextFile, findingsFile, sentinelFile,
          modelLabel: MODEL_A.split("/").pop()!,
        });
        const systemPromptB = buildSystemPrompt({
          aspect, isInitiator: false, peerCname: cnameA,
          workdir, contextFile, findingsFile, sentinelFile,
          modelLabel: MODEL_B.split("/").pop()!,
        });

        const initialMsgA =
          `Start the ${aspect.displayName} review. Read CONTEXT.md first, then investigate the diff. When ready, send your findings to your partner and begin the back-and-forth.`;
        const initialMsgB =
          `You are an analyst for the ${aspect.displayName} review. Start now: read CONTEXT.md, then investigate the diff and codebase yourself to form your own preliminary findings -- don't wait for your partner. When your partner contacts you, investigate further as needed and reply via coms_send.`;

        let pairProject: string;
        try {
          ({ pairProject } = spawnPairInTmux({
            aspect, systemPromptA, systemPromptB,
            comsExtPath, tmpDir, initialMsgA, initialMsgB,
          }));
        } catch (e: any) {
          state.phase    = "error";
          state.errorMsg = `spawn failed: ${e?.message ?? e}`;
          updateWidget();
          continue;
        }

        state.phase = "registering";
        updateWidget();
        onUpdate?.({
          content: [{ type: "text", text: `[${short}] Waiting for agents to register on coms...` }],
          details: { phase: "registering", aspect: short },
        });

        try {
          await waitForAgents([cnameA, cnameB], pairProject, PAIR_REGISTER_TIMEOUT_MS);
        } catch (e: any) {
          state.phase    = "error";
          state.errorMsg = `registration timeout`;
          updateWidget();
          continue;
        }

        state.phase     = "discussing";
        state.startedAt = Date.now();
        updateWidget();
        onUpdate?.({
          content: [{ type: "text", text: `[${short}] Both agents registered -- discussion underway.` }],
          details: { phase: "discussing", aspect: short },
        });
      }

      // Poll for completions
      const pending  = new Set([...pairs.keys()].filter(k => pairs.get(k)!.phase === "discussing"));
      const deadline = Date.now() + PAIR_REVIEW_TIMEOUT_MS;

      const ticker = setInterval(() => updateWidget(), 5_000);

      while (pending.size > 0) {
        if (signal?.aborted) { clearInterval(ticker); break; }

        if (Date.now() > deadline) {
          for (const short of pending) {
            const state = pairs.get(short)!;
            state.phase    = "error";
            state.errorMsg = "timeout";
          }
          updateWidget();
          break;
        }

        await sleep(POLL_INTERVAL_MS);

        for (const short of [...pending]) {
          const state = pairs.get(short)!;
          if (fs.existsSync(state.sentinelFile)) {
            state.phase      = "done";
            state.durationMs = Date.now() - (state.startedAt ?? Date.now());
            pending.delete(short);
            updateWidget();
            onUpdate?.({
              content: [{ type: "text", text: `[${short}] Findings written.` }],
              details: { phase: "pair_done", aspect: short },
            });
          }
        }
      }

      clearInterval(ticker);

      const doneCount = [...pairs.values()].filter(p => p.phase === "done").length;
      if (doneCount === 0) {
        return {
          content: [{ type: "text", text: "No pairs completed. Check tmux windows for errors." }],
          details: { phase: "error", outdir },
        };
      }

      // Synthesize
      onUpdate?.({
        content: [{ type: "text", text: `Synthesizing ${doneCount} findings files...` }],
        details: { phase: "synthesis" },
      });

      const finalFile = path.join(outdir, "REVIEW.md");
      try {
        await runSynthesis({
          findingsDir,
          outputFile: finalFile,
          contextSummary: fs.readFileSync(contextFile, "utf-8"),
          model: synthModel,
        });
      } catch (e: any) {
        ctx.ui.notify(`Synthesis failed: ${e?.message ?? e}`, "error");
      }

      ctx.ui.setStatus("pr-review", `Review done: ${params.ticket} (${doneCount} aspects)`);
      updateWidget();

      return {
        content: [{
          type: "text",
          text: `Review complete.\n\nFindings: ${findingsDir}\nSummary:  ${finalFile}`,
        }],
        details: { phase: "complete", outdir, finalFile, doneCount },
      };
    },

    renderCall(args, theme) {
      const ticket = (args as any).ticket ?? "?";
      const aspects = (args as any).aspects;
      const detail  = aspects?.length ? ` [${aspects.join(", ")}]` : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("review_pr ")) +
        theme.fg("accent", ticket) +
        theme.fg("dim", detail),
        0, 0,
      );
    },

    renderResult(result, _options, theme) {
      const d = result.details as any;
      if (!d) return new Text("", 0, 0);
      if (d.phase === "complete") {
        return new Text(
          theme.fg("success", "v ") +
          theme.fg("muted", `${d.doneCount} aspects  `) +
          theme.fg("dim", d.finalFile ?? ""),
          0, 0,
        );
      }
      if (d.phase === "error") return new Text(theme.fg("error", "x review failed"), 0, 0);
      return new Text(theme.fg("dim", d.phase ?? "..."), 0, 0);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    widgetCtx = ctx;
  });
}
