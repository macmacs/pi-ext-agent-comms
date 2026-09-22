// Clean git-install check for ticket 09.
//
// Uses a scratch PI_CODING_AGENT_DIR + XDG_CONFIG_HOME, so nothing on the real
// machine is touched. In that scratch world it:
//
//   1. `pi install git:github.com/macmacs/pi-ext-agent-comms`
//   2. checks the settings entry is a plain string with no extensions filter,
//      and that the clone landed where pi looks for it, at the pushed commit
//   3. boots `pi --mode rpc`, records every registered tool + command through a
//      probe extension, and dispatches `/coms-setup` as an RPC prompt
//   4. checks the boot was clean, the coms tools are present, and the report
//      names the clone (not this checkout)
//   5. checks `just -g --list` and `just -g teams` work from an unrelated cwd
//
// Usage:
//
//   node tests/git-install.mjs
//
// Exit code 0 = every check passed.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const REPO = path.resolve(import.meta.dirname, "..");
const SOURCE = "git:github.com/macmacs/pi-ext-agent-comms";
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "coms-git-install-"));
const AGENT = path.join(ROOT, "agent");
const XDG = path.join(ROOT, "xdg");
const CWD = path.join(ROOT, "unrelated-cwd");
const PROBE_OUT = path.join(ROOT, "probe.json");
const PROBE_TS = path.join(AGENT, "extensions", "00-probe.ts");
const CLONE_DIR = path.join(AGENT, "git", "github.com", "macmacs", "pi-ext-agent-comms");

let passed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

function include(name, text, needle) {
  check(name, text.includes(needle), `missing ${JSON.stringify(needle)} in:\n${text}`);
}

const env = { ...process.env, PI_CODING_AGENT_DIR: AGENT, XDG_CONFIG_HOME: XDG };

// ── 1. install ───────────────────────────────────────────────────────────────
console.log(`git-install check (scratch ${ROOT})`);
fs.mkdirSync(path.join(AGENT, "extensions"), { recursive: true });
fs.mkdirSync(CWD, { recursive: true });

const install = spawnSync("pi", ["install", SOURCE], { encoding: "utf8", env, cwd: CWD });
console.log("\n--- pi install ---\n" + (install.stdout ?? "") + (install.stderr ?? ""));
check("pi install exit 0", install.status === 0, `status=${install.status}`);

let settings = null;
try {
  settings = JSON.parse(fs.readFileSync(path.join(AGENT, "settings.json"), "utf8"));
} catch (err) {
  check("settings.json readable", false, String(err));
}
const entry = settings?.packages?.find(
  (p) => (typeof p === "string" ? p : p?.source) === SOURCE,
);
check("settings has the git entry", !!entry, JSON.stringify(settings?.packages));
check("entry is a plain string", typeof entry === "string", JSON.stringify(entry));

check("clone exists where pi looks", fs.existsSync(CLONE_DIR), CLONE_DIR);
const localHead = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: REPO });
const cloneHead = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: CLONE_DIR });
check(
  "clone is at the pushed commit",
  localHead.stdout?.trim() === cloneHead.stdout?.trim(),
  `local=${localHead.stdout?.trim()} clone=${cloneHead.stdout?.trim()}`,
);

const list = spawnSync("pi", ["list"], { encoding: "utf8", env, cwd: CWD });
console.log("\n--- pi list ---\n" + (list.stdout ?? "") + (list.stderr ?? ""));
include("pi list shows the source", list.stdout ?? "", SOURCE);

// ── 2. boot + probe + /coms-setup ────────────────────────────────────────────
fs.writeFileSync(
  PROBE_TS,
  [
    'import * as fs from "node:fs";',
    'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
    "",
    "export default function (pi: ExtensionAPI) {",
    '  pi.on("session_start", async () => {',
    "    const out = process.env.PI_PROBE_OUT;",
    "    if (!out) return;",
    "    try {",
    "      fs.writeFileSync(",
    "        out,",
    "        JSON.stringify(",
    "          {",
    "            tools: pi.getAllTools().map((t) => t.name),",
    "            commands: pi.getCommands().map((c) => ({ name: c.name, sourceInfo: (c as any).sourceInfo })),",
    "          },",
    "          null,",
    "          2,",
    "        ),",
    "      );",
    "    } catch (err) {",
    "      fs.writeFileSync(out, `PROBE ERROR ${err}`);",
    "    }",
    "  });",
    "}",
    "",
  ].join("\n"),
);

const rpc = await new Promise((resolve) => {
  const child = spawn("pi", ["--mode", "rpc"], {
    cwd: CWD,
    env: { ...env, PI_PROBE_OUT: PROBE_OUT },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    child.kill("SIGTERM");
    setTimeout(() => resolve({ stdout, stderr, exitCode: child.exitCode }), 1500);
  };
  const timer = setTimeout(finish, 60000);
  child.stdout.on("data", (d) => {
    stdout += d.toString();
    if (stdout.includes('"method":"notify"')) finish();
  });
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });
  child.on("error", (err) => {
    stderr += `SPAWN ERROR ${err.message}`;
    finish();
  });
  child.stdin.write(
    JSON.stringify({ type: "prompt", message: "/coms-setup", id: "p1" }) + "\n",
  );
});

const notifies = rpc.stdout
  .split("\n")
  .filter((line) => line.includes('"method":"notify"'))
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { method: "notify", message: line };
    }
  });
const report = notifies.map((n) => n.message).join("\n");
console.log("\n--- report ---\n" + (report || "(no notify seen)"));
if (rpc.stderr.trim()) console.log("\n--- pi stderr ---\n" + rpc.stderr.trim());

check("pi booted (rpc session ran)", rpc.exitCode !== null, `exitCode=${rpc.exitCode}`);
check(
  "no boot error on stderr",
  !/Tool "coms_list" conflicts|duplicate|Error:|failed to load/i.test(rpc.stderr),
  rpc.stderr.slice(0, 400),
);

check("probe wrote probe.json", fs.existsSync(PROBE_OUT), PROBE_OUT);
if (fs.existsSync(PROBE_OUT)) {
  const probe = JSON.parse(fs.readFileSync(PROBE_OUT, "utf8"));
  const tools = probe.tools ?? [];
  for (const tool of [
    "coms_list",
    "coms_send",
    "coms_respawn",
    "coms_cold_respawn",
    "coms_request_respawn",
  ]) {
    check(`tool present: ${tool}`, tools.includes(tool), `tools=${tools.join(",")}`);
  }
  check("tool count is sane", tools.length > 5, `tools=${tools.join(",")}`);
  const cmd = (probe.commands ?? []).find((c) => c.name === "coms-setup");
  check("coms-setup is registered", !!cmd, JSON.stringify(cmd));
  if (cmd) {
    check("origin is package", cmd.sourceInfo?.origin === "package", cmd.sourceInfo?.origin);
    check("scope is user", cmd.sourceInfo?.scope === "user", cmd.sourceInfo?.scope);
    check("baseDir is the clone", cmd.sourceInfo?.baseDir === CLONE_DIR, cmd.sourceInfo?.baseDir);
    check(
      "entry path is inside the clone",
      path.resolve(cmd.sourceInfo?.path ?? "").startsWith(CLONE_DIR),
      cmd.sourceInfo?.path,
    );
  }
}

check("report says wired", report.includes(`wired ${path.join(XDG, "just", "justfile")}`), report);
include("report names the source as the package", report, `loaded as a package install (${SOURCE}, scope user)`);
include("report tells the user what to run", report, "just -g --list");
include("report says the shim resolves the clone", report, `wired ${path.join(XDG, "just", "justfile")} -> ${CLONE_DIR}`);
include("report warns typecheck needs npm install", report, "just typecheck");

// ── 3. the shim, from an unrelated directory ─────────────────────────────────
const shim = path.join(XDG, "just", "justfile");
check("shim written", fs.existsSync(shim), shim);
if (fs.existsSync(shim)) {
  const text = fs.readFileSync(shim, "utf8");
  include("shim has the marker", text, "# coms-setup-shim v1");
  include("shim imports the clone", text, `import ${JSON.stringify(path.join(CLONE_DIR, "justfile"))}`);
  check(
    "shim does not import the checkout",
    !text.includes(JSON.stringify(path.join(REPO, "justfile"))),
    text,
  );
}

const justEnv = { ...env };
const settingsPath = path.join(XDG, "just", "coms.env");
check("settings file written", fs.existsSync(settingsPath), settingsPath);
if (fs.existsSync(settingsPath)) {
  include("report says settings created", report, `settings: created ${settingsPath}`);
  include("settings template is seeded", fs.readFileSync(settingsPath, "utf8"), "#PI_COMS_TEAM=team");
}
const helperRes = spawnSync(path.join(CLONE_DIR, "scripts", "coms-setting"), ["PI_COMS_TEAM", "team"], {
  encoding: "utf8",
  env: justEnv,
});
check(
  "clone helper reads the seeded settings file",
  helperRes.stdout === "team",
  JSON.stringify({ stdout: helperRes.stdout, stderr: helperRes.stderr }),
);
const listRes = spawnSync("just", ["-g", "--list"], { encoding: "utf8", cwd: CWD, env: justEnv });
check("just -g --list from an unrelated dir", listRes.status === 0, listRes.stderr);
include("list shows the recipes", listRes.stdout ?? "", "role-team");

const evalRes = spawnSync("just", ["-g", "--no-dotenv", "--evaluate", "repo"], {
  encoding: "utf8",
  cwd: CWD,
  env: justEnv,
});
check(
  "just -g --evaluate repo == clone",
  evalRes.stdout?.trim() === CLONE_DIR,
  JSON.stringify(evalRes.stdout),
);

const teamsRes = spawnSync("just", ["-g", "teams"], { encoding: "utf8", cwd: CWD, env: justEnv });
console.log("\n--- just -g teams ---\n" + (teamsRes.stdout ?? "") + (teamsRes.stderr ?? ""));
check("just -g teams from an unrelated dir", teamsRes.status === 0, teamsRes.stderr);
check(
  "teams printed a pool line or an empty-pool note",
  /^\S+\s+\S/m.test(teamsRes.stdout ?? "") || (teamsRes.stdout ?? "").includes("no "),
  teamsRes.stdout,
);

console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`failures:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
