// Real-pi integration check for /coms-setup (ticket 06).
//
// Boots `pi --mode rpc` with a scratch agent dir in which this checkout is
// installed as a local-path package, dispatches `/coms-setup` as an RPC
// prompt (extension commands execute without an LLM turn), and checks:
//
//   - provenance under the real loader (coms-setup.ts's entry, by path)
//   - the notify report
//   - the shim on disk in a scratch XDG_CONFIG_HOME
//   - `just -g --list` from an unrelated directory
//
// Nothing on the real machine is touched. Usage:
//
//   node tests/coms-setup-realpi.mjs
//
// Exit code 0 = every check passed.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const REPO = path.resolve(import.meta.dirname, "..");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "coms-setup-realpi-"));
const AGENT = path.join(ROOT, "agent");
const XDG = path.join(ROOT, "xdg");
const CWD = path.join(ROOT, "unrelated-cwd");
const PROBE_OUT = path.join(ROOT, "commands.json");
const PROBE_TS = path.join(AGENT, "extensions", "00-probe.ts");

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

fs.mkdirSync(PROBE_TS.substring(0, PROBE_TS.lastIndexOf("/")), { recursive: true });
fs.mkdirSync(CWD, { recursive: true });
fs.writeFileSync(
  path.join(AGENT, "settings.json"),
  JSON.stringify({ packages: [{ source: REPO }] }, null, 2) + "\n",
);
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
    "          pi.getCommands().map((c) => ({ name: c.name, sourceInfo: (c as any).sourceInfo })),",
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

async function driveRpc() {
  return await new Promise((resolve) => {
    const child = spawn("pi", ["--mode", "rpc"], {
      cwd: CWD,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: AGENT,
        XDG_CONFIG_HOME: XDG,
        PI_PROBE_OUT: PROBE_OUT,
      },
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
    const timer = setTimeout(finish, 40000);
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
}

console.log(`/coms-setup real-pi check (scratch ${ROOT})`);
const { stdout, stderr, exitCode } = await driveRpc();

const notifies = stdout
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
if (stderr.trim()) console.log("\n--- pi stderr ---\n" + stderr.trim());

check("pi exited", exitCode !== null, `exitCode=${exitCode}`);
check(
  "dispatched command produced a notify",
  notifies.length > 0,
  `stdout lines: ${stdout.length}, stderr: ${stderr.slice(0, 400)}`,
);
include("report says wired", report, `wired ${path.join(XDG, "just", "justfile")} -> ${REPO}`);
include("report says package install", report, `loaded as a package install (${REPO}, scope user)`);
include("report tells the user what to run", report, "just -g --list");

// Provenance as the real loader sees it.
check("probe wrote commands.json", fs.existsSync(PROBE_OUT), PROBE_OUT);
let entry;
if (fs.existsSync(PROBE_OUT)) {
  const commands = JSON.parse(fs.readFileSync(PROBE_OUT, "utf8"));
  entry = commands.find((c) => c.name === "coms-setup");
}
check("coms-setup is registered", !!entry, JSON.stringify(entry));
if (entry) {
  check("origin is package", entry.sourceInfo?.origin === "package", entry.sourceInfo?.origin);
  check("scope is user", entry.sourceInfo?.scope === "user", entry.sourceInfo?.scope);
  check(
    "entry path is this checkout",
    path.resolve(entry.sourceInfo?.path ?? "") === path.join(REPO, "extensions", "coms.ts"),
    entry.sourceInfo?.path,
  );
  check("baseDir is the package root", entry.sourceInfo?.baseDir === REPO, entry.sourceInfo?.baseDir);
}

// The shim on disk, and just reading it from an unrelated directory.
const shim = path.join(XDG, "just", "justfile");
check("shim written", fs.existsSync(shim), shim);
if (fs.existsSync(shim)) {
  const text = fs.readFileSync(shim, "utf8");
  include("shim has the marker", text, "# coms-setup-shim v1");
  include("shim imports the package", text, `import ${JSON.stringify(path.join(REPO, "justfile"))}`);
}
const settings = path.join(XDG, "just", "coms.env");
check("settings file written", fs.existsSync(settings), settings);
if (fs.existsSync(settings)) {
  include("report says settings created", report, `settings: created ${settings}`);
  include("settings template is seeded", fs.readFileSync(settings, "utf8"), "#PI_COMS_TEAM=team");
}
const list = spawnSync("just", ["-g", "--list"], {
  encoding: "utf8",
  cwd: CWD,
  env: { ...process.env, XDG_CONFIG_HOME: XDG },
});
check("just -g --list from an unrelated dir", list.status === 0, list.stderr);
include("list shows the recipes", list.stdout ?? "", "role-team");
const evalRes = spawnSync("just", ["-g", "--no-dotenv", "--evaluate", "repo"], {
  encoding: "utf8",
  cwd: CWD,
  env: { ...process.env, XDG_CONFIG_HOME: XDG },
});
check("just -g --evaluate repo == package", evalRes.stdout === REPO, JSON.stringify(evalRes.stdout));

console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`failures:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
