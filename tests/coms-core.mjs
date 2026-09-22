// Unit harness for the core coms.ts helpers (ticket 13).
//
// Imports extensions/coms.ts directly with PI_COMS_DIR pointed at a scratch
// dir (COMS_DIR is captured at import), then exercises the pure helpers: ids,
// formatting, frontmatter/role parsing, turn-initiator scan and registry I/O.
// No pi session, no sockets, nothing real touched.
//
//   node tests/coms-core.mjs
//
// Exit code 0 = every case passed.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = path.resolve(import.meta.dirname, "..");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "coms-core-check-"));
process.env.PI_COMS_DIR = ROOT;

const coms = await import(pathToFileURL(path.join(REPO, "extensions/coms.ts")).href);

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

// ━━ ids, colors, formatting ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const id = coms.ulid();
check("ulid: 26 Crockford chars", /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id), id);
check("ulid: unique across calls", coms.ulid() !== coms.ulid());

check("isValidHex: accepts lower and upper", coms.isValidHex("#36f9f6") && coms.isValidHex("#36F9F6"));
check("isValidHex: rejects missing #", !coms.isValidHex("36F9F6"));
check("isValidHex: rejects short and long", !coms.isValidHex("#36F9F") && !coms.isValidHex("#36F9F6A"));
check("isValidHex: rejects non-hex", !coms.isValidHex("#36F9FZ"));

const color = coms.fallbackColor("session-a");
check("fallbackColor: stable for one id", color === coms.fallbackColor("session-a"));
check("fallbackColor: comes from the palette", coms.FALLBACK_PALETTE.includes(color), color);
check("fallbackColor: palette holds valid hex", coms.FALLBACK_PALETTE.every((c) => coms.isValidHex(c)));

check("compactTokens: below 1000 is exact", coms.compactTokens(0) === "0" && coms.compactTokens(999) === "999");
check("compactTokens: thousands", coms.compactTokens(1234) === "1.2k");
check("compactTokens: millions", coms.compactTokens(2_500_000) === "2.5M");
check(
  "compactTokens: invalid is ?",
  coms.compactTokens(-1) === "?" && coms.compactTokens(Number.NaN) === "?" && coms.compactTokens(Infinity) === "?",
);

check("idleMsSince: running is unknown", coms.idleMsSince(new Date().toISOString(), true) === null);
check(
  "idleMsSince: missing timestamp is unknown",
  coms.idleMsSince(undefined, false) === null && coms.idleMsSince(null, false) === null,
);
check("idleMsSince: garbage is unknown", coms.idleMsSince("not-a-date", false) === null);
const idle = coms.idleMsSince(new Date(Date.now() - 5000).toISOString(), false);
check("idleMsSince: past yields a number", typeof idle === "number" && idle >= 4000 && idle < 60_000, String(idle));
check("idleMsSince: future clamps to 0", coms.idleMsSince(new Date(Date.now() + 60_000).toISOString(), false) === 0);

check("formatIdle: null is ?", coms.formatIdle(null) === "?");
check("formatIdle: seconds", coms.formatIdle(30_000) === "30s");
check("formatIdle: minutes", coms.formatIdle(125_000) === "2m");
check("formatIdle: hours", coms.formatIdle(5_400_000) === "1.5h");

check(
  "abbreviateModel: vendor + claude prefixes",
  coms.abbreviateModel("anthropic.claude-sonnet-4-5") === "sonnet-4-5",
  coms.abbreviateModel("anthropic.claude-sonnet-4-5"),
);
check(
  "abbreviateModel: routing prefix first",
  coms.abbreviateModel("us.anthropic.claude-3-5-sonnet") === "3-5-sonnet",
  coms.abbreviateModel("us.anthropic.claude-3-5-sonnet"),
);
check("abbreviateModel: long names keep the tail", coms.abbreviateModel("abcdefghijklmnopqrstuvwxyz") === "ghijklmnopqrstuvwxyz");
check("abbreviateModel: empty stays empty", coms.abbreviateModel("") === "");

// ━━ frontmatter ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const fm = coms.parseFrontmatter(`---\nname: dusk\ndescription: "a: b"\ncolor: '#36F9F6'\n---\nbody line\n`);
check(
  "parseFrontmatter: keys, quotes, inner colon",
  fm.name === "dusk" && fm.description === "a: b" && fm.color === "#36F9F6",
  JSON.stringify(fm),
);
check("parseFrontmatter: body is the rest", fm.body === "body line\n", JSON.stringify(fm.body));
const noFm = coms.parseFrontmatter("just text");
check("parseFrontmatter: no fences returns raw body", noFm.body === "just text" && noFm.name === undefined);
const emptyFm = coms.parseFrontmatter("---\n---\nbody");
check(
  "parseFrontmatter: empty fences are not a match",
  emptyFm.body === "---\n---\nbody" && emptyFm.name === undefined,
  JSON.stringify(emptyFm.body),
);
const halfFm = coms.parseFrontmatter("---\nname: x\nbody");
check(
  "parseFrontmatter: unclosed fence returns raw",
  halfFm.body === "---\nname: x\nbody" && halfFm.name === undefined,
  JSON.stringify(halfFm.body),
);
const spacedFm = coms.parseFrontmatter("---\n  name : spaced \n---\nX");
check("parseFrontmatter: trims keys", spacedFm.name === "spaced" && spacedFm.body === "X", JSON.stringify(spacedFm));

// ━━ registry I/O ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const LIVE = process.pid;
const DEAD = 2147483647; // above Linux pid_max, so kill(pid, 0) is ESRCH

function entry(name, pid, extra = {}) {
  return {
    session_id: `sess-${name}`,
    name,
    purpose: "check",
    model: "check-model",
    color: "#36F9F6",
    pid,
    endpoint: path.join(ROOT, "sockets", `${name}.sock`),
    cwd: ROOT,
    started_at: new Date().toISOString(),
    explicit: false,
    version: 1,
    ...extra,
  };
}

const fileA = coms.writeRegistryAtomic(entry("alpha", LIVE), "proj-a");
check(
  "registry: write returns the file path",
  fileA === path.join(ROOT, "projects", "proj-a", "agents", "alpha.json"),
  fileA,
);
check("registry: file exists", fs.existsSync(fileA));
const readBack = coms.readAllRegistryEntries("proj-a");
check(
  "registry: round trip",
  readBack.length === 1 && readBack[0].name === "alpha" && readBack[0].session_id === "sess-alpha",
  JSON.stringify(readBack),
);
check("registry: missing project dir is empty", coms.readAllRegistryEntries("no-such-project").length === 0);

const agentsA = path.join(ROOT, "projects", "proj-a", "agents");
fs.writeFileSync(path.join(agentsA, "broken.json"), "{not json");
fs.writeFileSync(path.join(agentsA, "nosession.json"), JSON.stringify({ name: "x" }));
fs.writeFileSync(path.join(agentsA, "notes.txt"), "ignore me");
fs.writeFileSync(path.join(agentsA, "notafile.json"), "");
fs.rmSync(path.join(agentsA, "notafile.json"));
fs.mkdirSync(path.join(agentsA, "adir.json"));
const afterSkip = coms.readAllRegistryEntries("proj-a");
check(
  "registry: skips malformed, sessionless, non-json, directories",
  afterSkip.length === 1 && afterSkip[0].name === "alpha",
  String(afterSkip.length),
);

coms.writeRegistryAtomic(entry("dead", DEAD), "proj-a");
coms.writeRegistryAtomic(entry("live", LIVE), "proj-a");
const pruned = coms.pruneDeadEntries("proj-a");
check(
  "pruneDeadEntries: keeps live, drops dead",
  pruned.some((e) => e.name === "live") && !pruned.some((e) => e.name === "dead"),
  pruned.map((e) => e.name).join(","),
);
check("pruneDeadEntries: dead file removed from disk", !fs.existsSync(path.join(agentsA, "dead.json")));

check("resolveUniqueName: free name unchanged", coms.resolveUniqueName("proj-a", "fresh") === "fresh");
check("resolveUniqueName: live collision gets 2", coms.resolveUniqueName("proj-a", "live") === "live2");
coms.writeRegistryAtomic(entry("live2", LIVE), "proj-a");
check("resolveUniqueName: second collision gets 3", coms.resolveUniqueName("proj-a", "live") === "live3");
coms.writeRegistryAtomic(entry("dead2", DEAD), "proj-b");
check("resolveUniqueName: dead entries do not collide", coms.resolveUniqueName("proj-b", "dead2") === "dead2");

coms.writeRegistryAtomic(entry("mine", LIVE), "proj-c");
coms.writeRegistryAtomic(entry("other", DEAD), "proj-c");
coms.pruneEntriesOwnedByPid(LIVE);
const leftC = coms.readAllRegistryEntries("proj-c").map((e) => e.name);
check("pruneEntriesOwnedByPid: removes only our pid", !leftC.includes("mine") && leftC.includes("other"), leftC.join(","));
coms.writeRegistryAtomic(entry("across-a", LIVE), "proj-x");
coms.writeRegistryAtomic(entry("across-b", LIVE), "proj-y");
const across = coms.readAllRegistryEntriesAcrossProjects();
check(
  "readAllRegistryEntriesAcrossProjects: spans projects",
  across.some((e) => e.name === "across-a") && across.some((e) => e.name === "across-b"),
  across.map((e) => e.name).join(","),
);

coms.writeRegistryAtomic(entry("dead-all", DEAD), "proj-d");
coms.writeRegistryAtomic(entry("live-all", LIVE), "proj-d");
const allPruned = coms.pruneDeadEntriesAllProjects();
check(
  "pruneDeadEntriesAllProjects: drops dead across projects",
  !allPruned.some((e) => e.name === "dead-all") && allPruned.some((e) => e.name === "live-all"),
);
check(
  "pruneDeadEntriesAllProjects: dead file removed",
  !fs.existsSync(path.join(ROOT, "projects", "proj-d", "agents", "dead-all.json")),
);

coms.removeRegistryEntry("proj-a", "live2");
check("removeRegistryEntry: removes", !fs.existsSync(path.join(agentsA, "live2.json")));
let removeThrew = false;
try {
  coms.removeRegistryEntry("proj-a", "not-there");
} catch {
  removeThrew = true;
}
check("removeRegistryEntry: missing name does not throw", !removeThrew);

// ━━ role files ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const roleDir = fs.mkdtempSync(path.join(ROOT, "role-"));
const rolePath = path.join(roleDir, "builder.md");
fs.writeFileSync(rolePath, `---\nname: builder\ndescription: builds\ncolor: "#72F1B8"\n---\n  do the thing  \n`);
fs.writeFileSync(path.join(roleDir, "_common.md"), `---\nname: common\n---\n  be kind  \n`);
const commonPath = path.join(roleDir, "_common.md");
const otherPath = path.join(roleDir, "other.md");
fs.writeFileSync(otherPath, "no frontmatter here\n");

check("findRoleFilePath: --role spaced form", coms.findRoleFilePath(["--role", rolePath]) === rolePath);
check("findRoleFilePath: --role= form", coms.findRoleFilePath([`--role=${rolePath}`]) === rolePath);
check(
  "findRoleFilePath: falls back to --append-system-prompt",
  coms.findRoleFilePath(["--append-system-prompt", otherPath]) === otherPath,
);
check(
  "findRoleFilePath: --role wins over fallback",
  coms.findRoleFilePath(["--append-system-prompt", otherPath, "--role", rolePath]) === rolePath,
);
check("findRoleFilePath: missing file is null", coms.findRoleFilePath(["--role", path.join(roleDir, "nope.md")]) === null);
check("findRoleFilePath: non-md is null", coms.findRoleFilePath(["--role", path.join(roleDir, "role.txt")]) === null);

check(
  "roleFileIsComsOwned: true for --role and --role=",
  coms.roleFileIsComsOwned(["--role", rolePath]) && coms.roleFileIsComsOwned([`--role=${rolePath}`]),
);
check("roleFileIsComsOwned: false for fallback", !coms.roleFileIsComsOwned(["--append-system-prompt", otherPath]));

const fromArgv = coms.readFrontmatterFromArgv(["--role", rolePath]);
check(
  "readFrontmatterFromArgv: reads identity",
  fromArgv.name === "builder" && fromArgv.description === "builds" && fromArgv.color === "#72F1B8",
  JSON.stringify(fromArgv),
);
const fallbackFm = coms.readFrontmatterFromArgv(["--append-system-prompt", otherPath]);
check(
  "readFrontmatterFromArgv: fallback has no identity",
  fallbackFm.name === undefined && fallbackFm.description === undefined && fallbackFm.color === undefined,
  JSON.stringify(fallbackFm),
);

const parts = coms.readRoleParts(["--role", rolePath]);
check("readRoleParts: body and common trimmed", parts.body === "do the thing" && parts.common === "be kind", JSON.stringify(parts));
const noOwn = coms.readRoleParts(["--append-system-prompt", otherPath]);
check("readRoleParts: fallback leaves both empty", noOwn.body === "" && noOwn.common === "");
fs.rmSync(commonPath);
const solo = coms.readRoleParts(["--role", rolePath]);
check("readRoleParts: no _common gives body only", solo.body === "do the thing" && solo.common === "");

// ━━ turn initiator ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

check("findTurnInitiator: empty branch is null", coms.findTurnInitiator([]) === null);
const init = { type: "message", message: { role: "user" } };
check(
  "findTurnInitiator: user message is the initiator",
  coms.findTurnInitiator([init, { type: "assistant" }, { type: "toolResult", message: { role: "user" } }]) === init,
);
const custom = { type: "custom_message", customType: "coms" };
check("findTurnInitiator: nearest custom message wins", coms.findTurnInitiator([init, custom]) === custom);
check(
  "findTurnInitiator: assistant and toolResult are skipped",
  coms.findTurnInitiator([{ type: "assistant" }, { type: "toolResult", message: { role: "user" } }]) === null,
);

// ━━ peer selector keys ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const KEY = { ctrlN: "\x0e", ctrlP: "\x10", ctrlX: "\x18", esc: "\x1b", enter: "\r" };
const keyState = (o = {}) => ({ leader: false, autocomplete: false, selected: -1, rows: 3, ...o });

check("poolKeyAction: ctrl+p passes through with no selection", coms.poolKeyAction(KEY.ctrlP, keyState()) === null);
check("poolKeyAction: ctrl+n passes through with no selection", coms.poolKeyAction(KEY.ctrlN, keyState()) === null);
check(
  "poolKeyAction: autocomplete owns the keys",
  coms.poolKeyAction(KEY.ctrlP, keyState({ selected: 1, autocomplete: true })) === null,
);
check("poolKeyAction: ctrl+p moves up while selected", coms.poolKeyAction(KEY.ctrlP, keyState({ selected: 2 }))?.index === 1);
check("poolKeyAction: ctrl+p at the first row clears", coms.poolKeyAction(KEY.ctrlP, keyState({ selected: 0 }))?.index === -1);
check("poolKeyAction: ctrl+n wraps past the last row", coms.poolKeyAction(KEY.ctrlN, keyState({ selected: 2 }))?.index === -1);
check(
  "poolKeyAction: enter navigates only when selected",
  coms.poolKeyAction(KEY.enter, keyState({ selected: 1 }))?.kind === "navigate" &&
    coms.poolKeyAction(KEY.enter, keyState()) === null,
);
check(
  "poolKeyAction: escape clears only when selected",
  coms.poolKeyAction(KEY.esc, keyState({ selected: 1 }))?.kind === "clear" && coms.poolKeyAction(KEY.esc, keyState()) === null,
);
check(
  "poolKeyAction: x closes only when selected",
  coms.poolKeyAction("x", keyState({ selected: 0 }))?.kind === "close" && coms.poolKeyAction("x", keyState()) === null,
);
check("poolKeyAction: ctrl+x enters the leader", coms.poolKeyAction(KEY.ctrlX, keyState())?.kind === "leader_enter");
check("poolKeyAction: leader consumes the next key", coms.poolKeyAction("n", keyState({ leader: true }))?.kind === "leader_key");
check("poolKeyAction: leader escape is flagged", coms.poolKeyAction(KEY.esc, keyState({ leader: true }))?.escape === true);
check(
  "poolLeaderSelection: starts at the first or last row",
  coms.poolLeaderSelection("n", -1, 3) === 0 && coms.poolLeaderSelection("p", -1, 3) === 2,
);
check(
  "poolLeaderSelection: wraps to cleared",
  coms.poolLeaderSelection("n", 2, 3) === -1 && coms.poolLeaderSelection("p", 0, 3) === -1,
);
check(
  "poolLeaderSelection: empty pool or other key is a no-op",
  coms.poolLeaderSelection("n", -1, 0) === null && coms.poolLeaderSelection("h", 0, 3) === null,
);

// ━━ summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

console.log(`\n${passed} checks passed, ${failures.length} failed`);
console.log(`scratch: ${ROOT}`);
if (failures.length > 0) {
  console.log(`failures:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
