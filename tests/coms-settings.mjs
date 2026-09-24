// Manual-check harness for durable coms settings (ticket 10).
//
// First drives the real scripts/coms-setting against scratch XDG dirs (parsing,
// precedence, edge cases). Then builds a scratch package copy with a global
// shim and a stub `pi` on PATH, and runs the real recipes (`role`,
// `backoffice`, `lean`, `team`) from an unrelated directory, so the whole
// resolution chain is exercised without launching anything.
//
//   node tests/coms-settings.mjs
//
// Exit code 0 = every case passed.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const REPO = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(REPO, "scripts", "coms-setting");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "coms-settings-check-"));

let passed = 0;
const failures = [];

function report(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}
function check(name, cond, detail = "") {
  report(name, !!cond, detail);
}
function include(name, text, needle) {
  report(name, String(text).includes(needle), `missing ${JSON.stringify(needle)} in:\n${text}`);
}

let seq = 0;
function scratch(name) {
  const dir = path.join(ROOT, `${String(++seq).padStart(2, "0")}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mode) fs.chmodSync(file, mode);
}

/** Environment with every setting var removed, so cases cannot leak into each other. */
function baseEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of [
    "PI_COMS_TEAM",
    "PI_BACKOFFICE_DIR",
    "PI_LEAN_EXCLUDE",
    "PI_COMS_REPO",
    "XDG_CONFIG_HOME",
    "PI_COMS_ROLES_DIR",
  ]) {
    delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith("PI_COMS_MODEL_")) delete env[key];
  }
  return { ...env, ...extra };
}

function runHelper(xdg, args, env = {}) {
  return spawnSync(SCRIPT, args, {
    encoding: "utf8",
    env: baseEnv({
      HOME: path.join(ROOT, "nohome"),
      ...(xdg === null ? {} : { XDG_CONFIG_HOME: xdg }),
      ...env,
    }),
  });
}

// ── helper unit cases ───────────────────────────────────────────────────────

console.log("\nhelper: parsing and precedence");
const unit = scratch("unit");
const unitXdg = path.join(unit, "xdg");
writeFile(
  path.join(unitXdg, "just", "coms.env"),
  [
    "# a comment",
    "",
    "PI_COMS_TEAM=from-file",
    "PI_BACKOFFICE_DIR = /tmp/bo",
    'PI_LEAN_EXCLUDE="quoted,list"',
    "PI_COMS_LAST=one",
    "PI_COMS_LAST=two",
    "PI_COMS_EMPTY=",
    "   PI_COMS_SPACED=indented",
  ].join("\n") + "\n",
);

const plain = runHelper(unitXdg, ["PI_COMS_TEAM", "team"]);
check("file value wins over the default", plain.stdout === "from-file", JSON.stringify(plain.stdout));
check("prints no trailing newline", !plain.stdout.endsWith("\n"), JSON.stringify(plain.stdout));
check("exit 0", plain.status === 0, plain.status);

check(
  "spaces around = are trimmed",
  runHelper(unitXdg, ["PI_BACKOFFICE_DIR", "x"]).stdout === "/tmp/bo",
);
check(
  "double quotes are stripped",
  runHelper(unitXdg, ["PI_LEAN_EXCLUDE", "x"]).stdout === "quoted,list",
);
check("last duplicate line wins", runHelper(unitXdg, ["PI_COMS_LAST", "x"]).stdout === "two");
check(
  "empty value falls back to the default",
  runHelper(unitXdg, ["PI_COMS_EMPTY", "fallback"]).stdout === "fallback",
);
check("leading whitespace is tolerated", runHelper(unitXdg, ["PI_COMS_SPACED", "x"]).stdout === "indented");
check("missing key falls back", runHelper(unitXdg, ["PI_COMS_ABSENT", "fallback"]).stdout === "fallback");

const commentedXdg = path.join(scratch("commented"), "xdg");
writeFile(path.join(commentedXdg, "just", "coms.env"), "#PI_COMS_TEAM=commented-out\n");
check(
  "commented-out setting is ignored",
  runHelper(commentedXdg, ["PI_COMS_TEAM", "team"]).stdout === "team",
);

const envWins = runHelper(unitXdg, ["PI_COMS_TEAM", "team"], { PI_COMS_TEAM: "from-env" });
check("environment beats the file", envWins.stdout === "from-env", JSON.stringify(envWins.stdout));

// Single quotes.
const quotedXdg = path.join(scratch("quotes"), "xdg");
writeFile(path.join(quotedXdg, "just", "coms.env"), "PI_COMS_TEAM='single'\n");
check("single quotes are stripped", runHelper(quotedXdg, ["PI_COMS_TEAM", "x"]).stdout === "single");

// CRLF.
const crlfXdg = path.join(scratch("crlf"), "xdg");
writeFile(path.join(crlfXdg, "just", "coms.env"), "PI_COMS_TEAM=windows\r\n");
check("CRLF is trimmed", runHelper(crlfXdg, ["PI_COMS_TEAM", "x"]).stdout === "windows");

// XDG handling: a relative XDG_CONFIG_HOME is ignored by just, so it is ignored here.
const home = scratch("home");
writeFile(path.join(home, ".config", "just", "coms.env"), "PI_COMS_TEAM=from-home\n");
const relXdg = runHelper("relative", ["PI_COMS_TEAM", "team"], { HOME: home });
check("relative XDG falls back to $HOME/.config", relXdg.stdout === "from-home", JSON.stringify(relXdg.stdout));
const emptyXdg = runHelper("", ["PI_COMS_TEAM", "team"], { HOME: home });
check("empty XDG falls back to $HOME/.config", emptyXdg.stdout === "from-home");

const badKey = runHelper(unitXdg, ["BAD KEY", "x"]);
check("bad key exits 2", badKey.status === 2, badKey.status);
include("bad key explains itself", badKey.stderr, "bad key");

// ── recipes through just -g ─────────────────────────────────────────────────

console.log("\nrecipes: environment > project .env > settings file > fallback");
const pkg = scratch("pkg");
fs.mkdirSync(path.join(pkg, "extensions"), { recursive: true });
fs.copyFileSync(path.join(REPO, "justfile"), path.join(pkg, "justfile"));
fs.cpSync(path.join(REPO, "roles"), path.join(pkg, "roles"), { recursive: true });
fs.cpSync(path.join(REPO, "scripts"), path.join(pkg, "scripts"), { recursive: true });
// The tmux launcher would build a real session; print its args instead.
writeFile(path.join(pkg, "scripts", "coms-team"), "#!/usr/bin/env bash\necho \"COMSTEAM $*\"\n", 0o755);

const bin = scratch("bin");
writeFile(path.join(bin, "pi"), "#!/usr/bin/env bash\necho \"STUB-PI pwd=$PWD args=$*\"\n", 0o755);

function shimFor(xdg, root) {
  writeFile(
    path.join(xdg, "just", "justfile"),
    ["# Managed by pi-ext-agent-comms. Generated by /coms-setup; do not edit.", "# coms-setup-shim v1", `import ${JSON.stringify(path.join(root, "justfile"))}`, ""].join("\n"),
  );
}

// just 1.58 on macOS ignores XDG_CONFIG_HOME for `-g` and reads
// $HOME/.config/just/justfile, so a scratch XDG dir alone would silently run
// the real global shim. Every recipe case gets a scratch HOME whose .config IS
// the XDG dir, so both lookups land on the scratch shim.
function xdgHome(name) {
  const dir = path.join(scratch(name), ".config");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function justG(xdg, cwd, args, env = {}) {
  return spawnSync("just", ["-g", ...args], {
    encoding: "utf8",
    cwd,
    env: baseEnv({
      HOME: path.dirname(xdg),
      XDG_CONFIG_HOME: xdg,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      ...env,
    }),
  });
}

const xdg = xdgHome("xdg");
shimFor(xdg, pkg);
const bo = scratch("backoffice-dir");
writeFile(path.join(bo, ".keep"), "");
writeFile(
  path.join(xdg, "just", "coms.env"),
  ["PI_COMS_TEAM=from-file", `PI_BACKOFFICE_DIR=${bo}`, "PI_LEAN_EXCLUDE=from-file-a,from-file-b"].join("\n") + "\n",
);
const proj = scratch("proj");

const roleFile = justG(xdg, proj, ["role", "builder"]);
check("role runs", roleFile.status === 0, roleFile.stderr.slice(0, 300));
include("role: settings file value", roleFile.stdout, "--project from-file");

const roleEnv = justG(xdg, proj, ["role", "builder"], { PI_COMS_TEAM: "from-env" });
include("role: environment beats the file", roleEnv.stdout, "--project from-env");

writeFile(path.join(proj, ".env"), "PI_COMS_TEAM=from-project\n");
const roleProject = justG(xdg, proj, ["role", "builder"]);
include("role: project .env beats the file", roleProject.stdout, "--project from-project");
fs.unlinkSync(path.join(proj, ".env"));

const xdgEmpty = xdgHome("xdg-empty");
shimFor(xdgEmpty, pkg);
const roleFallback = justG(xdgEmpty, proj, ["role", "builder"]);
include("role: missing file falls back", roleFallback.stdout, "--project team");

const backoffice = justG(xdg, proj, ["backoffice"]);
check("backoffice runs", backoffice.status === 0, backoffice.stderr.slice(0, 300));
include("backoffice: settings file dir", backoffice.stdout, `pwd=${bo}`);
include("backoffice: settings file team", backoffice.stdout, "--project from-file");

writeFile(path.join(xdg, "just", "coms.env"), ["PI_COMS_TEAM=from-file", "PI_BACKOFFICE_DIR=/nonexistent/xyz"].join("\n") + "\n");
const backofficeMissing = justG(xdg, proj, ["backoffice"]);
check("backoffice: bad dir fails", backofficeMissing.status !== 0, backofficeMissing.status);
include("backoffice: bad dir names the settings file", backofficeMissing.stderr, "coms.env settings file");
writeFile(
  path.join(xdg, "just", "coms.env"),
  ["PI_COMS_TEAM=from-file", `PI_BACKOFFICE_DIR=${bo}`, "PI_LEAN_EXCLUDE=from-file-a,from-file-b"].join("\n") + "\n",
);

const lean = justG(xdg, proj, ["lean"]);
check("lean runs", lean.status === 0, lean.stderr.slice(0, 300));
include("lean: settings file list", lean.stdout, "--exclude-tools from-file-a,from-file-b");
const leanFallback = justG(xdgEmpty, proj, ["lean"]);
include("lean: missing file falls back", leanFallback.stdout, "--exclude-tools ctx_purge,");

const team = justG(xdg, proj, ["team", "orchestrator"]);
check("team runs", team.status === 0, team.stderr.slice(0, 300));
include("team: settings file pool", team.stdout, "--pool from-file");
const teamEnv = justG(xdg, proj, ["team", "orchestrator"], { PI_COMS_TEAM: "from-env" });
include("team: environment beats the file", teamEnv.stdout, "--pool from-env");
const teamFallback = justG(xdgEmpty, proj, ["team", "orchestrator"]);
include("team: missing file falls back", teamFallback.stdout, "--pool team");

// ── role lookup and model overrides through the recipes ────────────────────

console.log("\nrecipes: local roles and model overrides");
const rolesXdg = xdgHome("xdg-roles");
shimFor(rolesXdg, pkg);
const rolesProj = scratch("roles-proj");
const roleMd = (name, model) => `---\nname: ${name}\n${model ? `model: ${model}\n` : ""}---\nbody\n`;

const shippedModel = justG(rolesXdg, rolesProj, ["role", "builder"]);
include("role: shipped frontmatter model", shippedModel.stdout, "--model litellm/claude-opus-5");
include("role: shipped role file", shippedModel.stdout, `--role ${path.join(pkg, "roles", "builder.md")}`);

writeFile(path.join(rolesXdg, "just", "coms.env"), "PI_COMS_MODEL_BUILDER=file/override\nPI_COMS_MODEL_SECOPS_DEV=file/secops\n");
include("role: coms.env model beats frontmatter", justG(rolesXdg, rolesProj, ["role", "builder"]).stdout, "--model file/override");
include("role: dash role key", justG(rolesXdg, rolesProj, ["role", "secops-dev"]).stdout, "--model file/secops");
include(
  "role: env model beats coms.env",
  justG(rolesXdg, rolesProj, ["role", "builder"], { PI_COMS_MODEL_BUILDER: "env/override" }).stdout,
  "--model env/override",
);
const cliModel = justG(rolesXdg, rolesProj, ["role", "builder", "--model", "cli/m"]);
check("role: --model on the CLI wins", cliModel.stdout.includes("--model cli/m") && !cliModel.stdout.includes("file/override"), cliModel.stdout);

writeFile(path.join(rolesXdg, "just", "coms-roles", "mine.md"), roleMd("mine", "user/mine"));
const userRole = justG(rolesXdg, rolesProj, ["role", "mine"]);
check("role: user role runs", userRole.status === 0, userRole.stderr.slice(0, 300));
include("role: user role file", userRole.stdout, `--role ${path.join(rolesXdg, "just", "coms-roles", "mine.md")}`);
include("role: user role model", userRole.stdout, "--model user/mine");

writeFile(path.join(rolesProj, ".pi", "coms", "roles", "mine.md"), roleMd("mine", "proj/mine"));
include("role: project role beats user role", justG(rolesXdg, rolesProj, ["role", "mine"]).stdout, "--model proj/mine");

const missingRole = justG(rolesXdg, rolesProj, ["role", "ghost"]);
check("role: missing role fails", missingRole.status !== 0);
include("role: missing role names the folders", missingRole.stderr, "not found in");
const badRole = justG(rolesXdg, rolesProj, ["role", "a_b"]);
include("role: underscore name refused", badRole.stderr, "bad role name");

const boProj = scratch("bo-roles");
writeFile(path.join(boProj, ".pi", "coms", "roles", "backoffice.md"), roleMd("backoffice", "bo/local"));
writeFile(path.join(rolesXdg, "just", "coms.env"), `PI_BACKOFFICE_DIR=${boProj}\n`);
const boLocal = justG(rolesXdg, rolesProj, ["backoffice"]);
check("backoffice: local role runs", boLocal.status === 0, boLocal.stderr.slice(0, 300));
include("backoffice: role from the backoffice dir", boLocal.stdout, `--role ${path.join(boProj, ".pi", "coms", "roles", "backoffice.md")}`);
include("backoffice: its model", boLocal.stdout, "--model bo/local");
writeFile(path.join(rolesXdg, "just", "coms.env"), `PI_BACKOFFICE_DIR=${boProj}\nPI_COMS_MODEL_BACKOFFICE=file/bo\n`);
include("backoffice: coms.env model override", justG(rolesXdg, rolesProj, ["backoffice"]).stdout, "--model file/bo");

// The real tmux launcher, stopped right after validation: tmux is stubbed.
const teamBin = scratch("team-bin");
writeFile(path.join(teamBin, "tmux"), "#!/usr/bin/env bash\necho TMUX-STUB >&2; exit 0\n", 0o755);
const runTeam = (roles) =>
  spawnSync(path.join(REPO, "scripts", "coms-team"), ["--repo", REPO, "--pool", "p", "--dir", rolesProj, ...roles], {
    encoding: "utf8",
    env: baseEnv({ XDG_CONFIG_HOME: rolesXdg, PATH: `${teamBin}${path.delimiter}${process.env.PATH}` }),
  });
const teamOk = runTeam(["builder", "mine"]);
check("coms-team: local role passes validation", teamOk.status === 0 && teamOk.stderr.includes("TMUX-STUB"), teamOk.stderr);
const teamBad = runTeam(["builder", "ghost"]);
check("coms-team: missing role fails before tmux", teamBad.status !== 0 && !teamBad.stderr.includes("TMUX-STUB"), teamBad.stderr);
include("coms-team: lists local roles as available", teamBad.stderr, "mine");

console.log(`\n${passed} checks passed, ${failures.length} failed`);
console.log(`scratch: ${ROOT}`);
if (failures.length > 0) {
  console.log(`failures:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
