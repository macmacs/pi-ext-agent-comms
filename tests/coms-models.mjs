// Harness for role lookup and per-machine model overrides.
//
// Drives the real scripts/role-resolve against scratch role folders and a
// scratch XDG settings file, then runs /coms-models (extensions/coms-models.ts)
// with a fake command context. Nothing on the real machine is touched.
//
//   node tests/coms-models.mjs
//
// Exit code 0 = every case passed.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const REPO = path.resolve(import.meta.dirname, "..");
const RESOLVE = path.join(REPO, "scripts", "role-resolve");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "coms-models-check-"));

let passed = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}
function include(name, text, needle) {
  check(name, String(text).includes(needle), `missing ${JSON.stringify(needle)} in:\n${text}`);
}
function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function role(name, model) {
  return `---\nname: ${name}\n${model ? `model: ${model}\n` : ""}---\nbody of ${name}\n`;
}

const xdg = path.join(ROOT, "xdg");
const userRoles = path.join(xdg, "just", "coms-roles");
const proj = path.join(ROOT, "proj");
const projRoles = path.join(proj, ".pi", "coms", "roles");
const settings = path.join(xdg, "just", "coms.env");

// Clean env: no setting var from the real shell may leak in.
const env = { ...process.env, HOME: path.join(ROOT, "nohome"), XDG_CONFIG_HOME: xdg };
for (const k of Object.keys(env)) {
  if (k.startsWith("PI_COMS_MODEL_") || k === "PI_COMS_ROLES_DIR" || k === "PI_COMS_REPO") delete env[k];
}
Object.assign(process.env, { HOME: env.HOME, XDG_CONFIG_HOME: xdg });
for (const k of Object.keys(process.env)) {
  if (k.startsWith("PI_COMS_MODEL_") || k === "PI_COMS_ROLES_DIR" || k === "PI_COMS_REPO") delete process.env[k];
}

function resolve(args, extra = {}) {
  return spawnSync(RESOLVE, args, { encoding: "utf8", env: { ...env, ...extra } });
}

// ── lookup order ────────────────────────────────────────────────────────────

console.log("\nrole-resolve: lookup");
writeFile(path.join(projRoles, "builder.md"), role("builder", "proj/model"));
writeFile(path.join(userRoles, "builder.md"), role("builder", "user/model"));
writeFile(path.join(userRoles, "scribe.md"), role("scribe", "user/scribe"));
writeFile(path.join(userRoles, "mine.md"), role("mine"));
writeFile(path.join(userRoles, "bad_name.md"), role("bad"));

let r = resolve(["path", "builder", proj]);
check("project beats user and shipped", r.stdout === path.join(projRoles, "builder.md"), r.stdout + r.stderr);
r = resolve(["path", "scribe", proj]);
check("user beats shipped", r.stdout === path.join(userRoles, "scribe.md"), r.stdout + r.stderr);
r = resolve(["path", "orchestrator", proj]);
check("shipped is the last resort", r.stdout === path.join(REPO, "roles", "orchestrator.md"), r.stdout + r.stderr);
r = resolve(["path", "nope", proj]);
check("missing role fails", r.status !== 0);
include("missing role names every folder", r.stderr, projRoles);
include("missing role names the user folder", r.stderr, userRoles);
r = resolve(["path", "a_b", proj]);
check("underscore name refused", r.status !== 0);
include("underscore name explains itself", r.stderr, "bad role name");
r = resolve(["path", "_common", proj]);
include("fragment refused", r.stderr, "shared fragment");
r = resolve(["path", "../x", proj]);
check("path traversal refused", r.status !== 0);

const moved = path.join(ROOT, "moved-roles");
writeFile(path.join(moved, "scribe.md"), role("scribe", "moved/scribe"));
r = resolve(["path", "scribe", proj], { PI_COMS_ROLES_DIR: moved });
check("PI_COMS_ROLES_DIR env moves the user folder", r.stdout === path.join(moved, "scribe.md"), r.stdout + r.stderr);
writeFile(settings, `PI_COMS_ROLES_DIR=${moved}\n`);
r = resolve(["path", "scribe", proj]);
check("PI_COMS_ROLES_DIR in coms.env moves the user folder", r.stdout === path.join(moved, "scribe.md"), r.stdout + r.stderr);
fs.rmSync(settings);

console.log("\nrole-resolve: _common.md");
r = resolve(["common", path.join(userRoles, "scribe.md")]);
check("no sibling falls back to shipped", r.stdout === path.join(REPO, "roles", "_common.md"), r.stdout);
writeFile(path.join(userRoles, "_common.md"), "local rules\n");
r = resolve(["common", path.join(userRoles, "scribe.md")]);
check("sibling _common wins", r.stdout === path.join(userRoles, "_common.md"), r.stdout);

console.log("\nrole-resolve: model precedence");
const secops = path.join(REPO, "roles", "secops-dev.md");
r = resolve(["model", "secops-dev", secops]);
check("frontmatter model", r.stdout === "litellm/claude-sonnet-5", r.stdout);
writeFile(settings, "# comment\nPI_COMS_MODEL_SECOPS_DEV=file/model\n");
r = resolve(["model", "secops-dev", secops]);
check("coms.env beats frontmatter", r.stdout === "file/model", r.stdout);
r = resolve(["model", "secops-dev", secops], { PI_COMS_MODEL_SECOPS_DEV: "env/model" });
check("env beats coms.env", r.stdout === "env/model", r.stdout);
r = resolve(["model", "mine", path.join(userRoles, "mine.md")]);
check("no model anywhere is empty", r.stdout === "" && r.status === 0, JSON.stringify(r.stdout));

console.log("\nrole-resolve: list");
r = resolve(["list", proj]);
const rows = Object.fromEntries(
  r.stdout.trim().split("\n").map((l) => {
    const [name, scope, p, model, source] = l.split("\t");
    return [name, { scope, p, model, source }];
  }),
);
check("list: project builder shadows the rest", rows.builder?.scope === "project" && rows.builder?.model === "proj/model", JSON.stringify(rows.builder));
check("list: user scribe", rows.scribe?.scope === "user", JSON.stringify(rows.scribe));
check("list: shipped roles still there", rows.orchestrator?.scope === "shipped");
check("list: coms.env source", rows["secops-dev"]?.model === "file/model" && rows["secops-dev"]?.source === "coms.env", JSON.stringify(rows["secops-dev"]));
check("list: role file source", rows.orchestrator?.source === "role");
check("list: no model has empty source", rows.mine?.model === "" && rows.mine?.source === "", JSON.stringify(rows.mine));
check("list: fragments hidden", !("_common" in rows));
check("list: bad names skipped", !("bad_name" in rows));
include("list: bad names warned", r.stderr, "bad_name.md");
check("list: each name once", r.stdout.trim().split("\n").filter((l) => l.startsWith("builder\t")).length === 1);

// ── /coms-models ────────────────────────────────────────────────────────────

console.log("\n/coms-models");
const models = await import(path.join(REPO, "extensions", "coms-models.ts"));

check("modelKey maps - to _", models.modelKey("secops-dev") === "PI_COMS_MODEL_SECOPS_DEV");
check("validRoleName refuses _", !models.validRoleName("a_b") && models.validRoleName("a-b"));
check("splitModel strips thinking", JSON.stringify(models.splitModel("litellm/claude-opus-5:xhigh")) === '{"provider":"litellm","id":"claude-opus-5"}');
check("splitModel keeps a non-thinking colon", models.splitModel("p/us.x:0")?.id === "us.x:0");
check("splitModel refuses a bare id", models.splitModel("claude") === null);

const apply = models.applySetting;
check("applySetting appends", apply("# c\n", "K", "v") === "# c\n\nK=v\n", JSON.stringify(apply("# c\n", "K", "v")));
check("applySetting replaces in place", apply("A=1\nK=old\nB=2\n", "K", "new") === "A=1\nK=new\nB=2\n");
check("applySetting drops duplicates", apply("K=1\nX=y\nK=2\n", "K", "3") === "K=3\nX=y\n");
check("applySetting keeps comments", apply("#K=commented\n", "K", "v") === "#K=commented\n\nK=v\n");
check("applySetting removes", apply("A=1\n K = x\nB=2\n", "K", null) === "A=1\nB=2\n");
check("applySetting remove of a missing key is a no-op", apply("A=1\n", "K", null) === "A=1\n");

function fakeCtx(known = () => true) {
  const notes = [];
  return {
    notes,
    cwd: proj,
    ui: { notify: (text, level) => notes.push({ text, level }) },
    modelRegistry: { find: (p, id) => (known(p, id) ? { provider: p, id } : undefined) },
  };
}

fs.rmSync(settings);
let ctx = fakeCtx();
await models.runComsModels("set scribe litellm/claude-sonnet-5", ctx, REPO);
let text = fs.readFileSync(settings, "utf8");
include("set creates coms.env from the template", text, "#PI_COMS_TEAM=team");
include("set writes the key", text, "PI_COMS_MODEL_SCRIBE=litellm/claude-sonnet-5");
include("set reports next launch", ctx.notes[0]?.text, "next launch");
check("set with a known model is info", ctx.notes[0]?.level === "info", JSON.stringify(ctx.notes));

r = resolve(["model", "scribe", path.join(userRoles, "scribe.md")]);
check("role-resolve sees the new override", r.stdout === "litellm/claude-sonnet-5", r.stdout);

ctx = fakeCtx(() => false);
await models.runComsModels("set scribe litellm/nope", ctx, REPO);
include("unknown model still written", fs.readFileSync(settings, "utf8"), "PI_COMS_MODEL_SCRIBE=litellm/nope");
check("unknown model replaced, not duplicated", fs.readFileSync(settings, "utf8").split("PI_COMS_MODEL_SCRIBE=").length === 2);
include("unknown model warns", ctx.notes[0]?.text, "does not know litellm/nope");
check("unknown model is a warning", ctx.notes[0]?.level === "warning");

ctx = fakeCtx();
await models.runComsModels("set ghost p/m", ctx, REPO);
include("unknown role warns", ctx.notes[0]?.text, "no role 'ghost'");

ctx = fakeCtx();
process.env.PI_COMS_MODEL_SCRIBE = "env/x";
await models.runComsModels("set scribe p/m", ctx, REPO);
delete process.env.PI_COMS_MODEL_SCRIBE;
include("env override warns", ctx.notes[0]?.text, "wins over coms.env");

ctx = fakeCtx();
await models.runComsModels("set a_b p/m", ctx, REPO);
check("bad role refused", ctx.notes[0]?.level === "error");
ctx = fakeCtx();
await models.runComsModels("set scribe", ctx, REPO);
check("missing model refused", ctx.notes[0]?.level === "error");

ctx = fakeCtx();
await models.runComsModels("", ctx, REPO);
const listed = ctx.notes[0]?.text ?? "";
include("list shows the settings path", listed, settings);
include("list shows the override", listed, "p/m");
include("list shows the source", listed, "coms.env");
include("list shows scope for local roles", listed, "builder [project]");
include("list shows pi default", listed, "(pi default)");

ctx = fakeCtx();
await models.runComsModels("unset scribe", ctx, REPO);
check("unset removes the key", !fs.readFileSync(settings, "utf8").includes("PI_COMS_MODEL_SCRIBE="));
include("unset reports", ctx.notes[0]?.text, "removed PI_COMS_MODEL_SCRIBE");

// Symlinked coms.env (dotfile managers): write through, keep the link.
const real = path.join(ROOT, "dotfiles", "coms.env");
writeFile(real, "PI_COMS_TEAM=x\n");
fs.rmSync(settings);
fs.symlinkSync(real, settings);
ctx = fakeCtx();
await models.runComsModels("set scribe p/linked", ctx, REPO);
check("symlink kept", fs.lstatSync(settings).isSymbolicLink());
include("symlink target updated", fs.readFileSync(real, "utf8"), "PI_COMS_MODEL_SCRIBE=p/linked");

console.log(`\n${passed} checks passed, ${failures.length} failed`);
console.log(`scratch: ${ROOT}`);
if (failures.length > 0) {
  console.log(`failures:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
