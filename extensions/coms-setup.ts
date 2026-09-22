/**
 * /coms-setup - wire the global justfile shim.
 *
 * This package's justfile carries all the coms recipes. To run them from any
 * directory (`just -g <recipe>`), just needs a global justfile that imports
 * the package justfile. /coms-setup writes that shim into
 * ${XDG_CONFIG_HOME:-$HOME/.config}/just/justfile and then proves the shim
 * resolves back to this package with `just -g --evaluate repo`.
 *
 * The shim is one import line plus an ownership marker:
 *
 *   # coms-setup-shim v1
 *   import "<package root>/justfile"
 *
 * The command also seeds the durable settings file the recipes read through
 * `scripts/coms-setting`, next to the shim:
 * `${XDG_CONFIG_HOME:-$HOME/.config}/just/coms.env`. It is written once with
 * commented examples and never overwritten, because it belongs to the user.
 *
 * The marker decides whether an existing file is ours. Two rules are not
 * negotiable:
 *
 * - A symlink is never followed. Writing through one would rewrite the file
 *   it points at. `force` replaces the link node itself (temp file + rename).
 * - A wrong repo root is never wired. `just -g --list` passes even when the
 *   imported justfile silently fell back to a hardcoded path, so verification
 *   compares `just -g --evaluate repo` against the package root.
 *
 * Registered from coms.ts, which passes its own entry URL so the provenance
 * lookup matches the command entry by file path.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SourceInfo,
} from "@earendil-works/pi-coding-agent";

// ━━ Constants ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Bumped whenever the generated shim text changes. */
const SHIM_VERSION = 1;
/** Durable settings file, next to the shim; read by scripts/coms-setting. */
const SETTINGS_FILE = "coms.env";
/** Ownership test: any known version counts as ours. */
const SHIM_MARKER_RE = /^# coms-setup-shim v([0-9]+)$/;
/** Imported recipes need the 1.42.4 import-scope fix. */
const MIN_JUST = [1, 42, 4] as const;
const INSTALL_RECIPE = "pi install git:github.com/macmacs/pi-ext-agent-comms";
/** A complete package has all of these next to its justfile. */
const REQUIRED_ENTRIES = ["justfile", "roles", "scripts"];

// ━━ Registration ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Register `/coms-setup`. `entryUrl` must be the extension entry's own
 * `import.meta.url`: provenance is found by matching that file path against
 * the registered command entries, and a helper module's URL would not match.
 */
export function registerComsSetup(pi: ExtensionAPI, entryUrl: string): void {
  pi.registerCommand("coms-setup", {
    description:
      "Wire the global justfile shim so `just -g <recipe>` works from this package",
    handler: async (args, ctx) => runComsSetup(pi, args ?? "", ctx, entryUrl),
  });
}

// ━━ Main ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export async function runComsSetup(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
  entryUrl: string,
): Promise<void> {
  const notify = (
    text: string,
    kind: "info" | "warning" | "error" = "info",
  ): void => {
    try {
      ctx.ui.notify(text, kind);
    } catch {
      /* no UI attached - the report has nowhere to go */
    }
  };
  const refuse = (text: string): void => notify(text, "error");

  const trimmedArgs = args.trim();
  const force = trimmedArgs
    .split(/\s+/)
    .some((a) => a === "force" || a === "--force" || a === "-f");
  // One timestamp per run, so the refusal message and the backup name agree.
  const stamp = utcStamp();
  const notes: string[] = [];

  // ── 1. How was this extension loaded? ──────────────────────────────────
  // Match by path, not by name: duplicate command names get numeric suffixes.
  const self = path.resolve(fileURLToPath(entryUrl));
  const entry = pi
    .getCommands()
    .find(
      (c) =>
        typeof c.sourceInfo?.path === "string" &&
        path.resolve(c.sourceInfo.path) === self,
    );
  if (!entry) {
    refuse(
      `/coms-setup: cannot tell how coms was loaded (no command entry for ${self}).\n` +
        `next: rerun /coms-setup from a normal pi session. If it keeps failing, report this.`,
    );
    return;
  }
  const info = entry.sourceInfo;
  if (info.origin !== "package") {
    refuse(
      `/coms-setup: coms was loaded with -e/--extension, not as a package, so there is no package root to wire.\n` +
        `next: ${INSTALL_RECIPE}, restart pi, then rerun /coms-setup.\n` +
        `A dev checkout works too, as long as it is installed: pi install /path/to/checkout`,
    );
    return;
  }
  // The manifest lists ./extensions/coms.ts, so the package root is always
  // one level above the entry file.
  const pkgRoot = path.dirname(path.dirname(self));
  if (info.baseDir && path.resolve(info.baseDir) !== pkgRoot) {
    notes.push(
      `note: the loader reports baseDir ${path.resolve(info.baseDir)}; using the extension's own package root ${pkgRoot}`,
    );
  }

  // ── 2. The package must be complete before anything is wired. ──────────
  const missing = REQUIRED_ENTRIES.filter(
    (name) => !fs.existsSync(path.join(pkgRoot, name)),
  );
  if (missing.length > 0) {
    refuse(
      `/coms-setup: incomplete package at ${pkgRoot} (missing ${missing.join(", ")}).\n` +
        `next: reinstall it (${INSTALL_RECIPE}) or fix the checkout, then rerun /coms-setup.`,
    );
    return;
  }

  // ── 3. just must be new enough for the shim + import design. ───────────
  let justVersion: string;
  try {
    justVersion = readJustVersion();
  } catch (err) {
    refuse(
      `/coms-setup: ${message(err)}\n` +
        `next: install or upgrade just (brew install just, cargo install just, apt install just), then rerun /coms-setup.`,
    );
    return;
  }

  // ── 4. Local TypeScript is nice-to-have: an installed package has none. ─
  const typecheckReady = fs.existsSync(
    path.join(pkgRoot, "node_modules", "typescript", "bin", "tsc"),
  );

  // ── 5. Where just looks for the global justfile. ───────────────────────
  const shimPath = globalJustfilePath();
  const shimDir = path.dirname(shimPath);

  // ── 6. Decide what to do with whatever is already there. ───────────────
  const existing = inspectTarget(shimPath);
  switch (existing.kind) {
    case "error":
      refuse(
        `/coms-setup: cannot inspect ${shimPath}: ${existing.message}\n` +
          `next: fix that path, then rerun /coms-setup.`,
      );
      return;
    case "directory":
      refuse(
        `/coms-setup: ${shimPath} is a directory; refusing to touch it even with force.\n` +
          `next: move it aside, then rerun /coms-setup.`,
      );
      return;
    case "symlink":
      if (!force) {
        refuse(
          `/coms-setup: ${shimPath} is a symlink to ${existing.target}; refusing to write through it, because that would rewrite the file it points at.\n` +
            `next: remove the link, or rerun /coms-setup force to replace just the link. The target file is left alone.`,
        );
        return;
      }
      notes.push(
        `replaced the symlink at ${shimPath} (was -> ${existing.target}); the target file was left untouched`,
      );
      break;
    case "foreign":
      if (!force) {
        refuse(
          `/coms-setup: ${shimPath} is a justfile this package did not write.\n` +
            `next: move it aside, or rerun /coms-setup force to back it up to ${shimPath}.bak-${stamp} first.\n` +
            `real path: ${safeRealpath(shimPath)}`,
        );
        return;
      }
      {
        const backupPath = uniqueBackupPath(shimPath, stamp);
        try {
          fs.copyFileSync(shimPath, backupPath);
        } catch (err) {
          refuse(
            `/coms-setup: could not back up ${shimPath} to ${backupPath}: ${message(err)}\n` +
              `next: make the directory writable, then rerun /coms-setup force.`,
          );
          return;
        }
        notes.push(`backed up the previous justfile to ${backupPath}`);
      }
      break;
    case "ours":
      if (existing.version > SHIM_VERSION) {
        refuse(
          `/coms-setup: ${shimPath} was written by a newer coms-setup (shim v${existing.version} > v${SHIM_VERSION}); this package is older than the shim.\n` +
            `next: update the package (pi update --extensions), then rerun /coms-setup.`,
        );
        return;
      }
      if (existing.version < SHIM_VERSION) {
        notes.push(
          `upgraded the shim from v${existing.version} to v${SHIM_VERSION}`,
        );
      }
      {
        const oldImport = parseShimImport(existing.content);
        if (oldImport) {
          const oldRoot = path.dirname(oldImport);
          if (path.resolve(oldRoot) !== pkgRoot) {
            notes.push(`repointed the shim from ${oldRoot} to ${pkgRoot}`);
          }
        }
      }
      break;
    case "absent":
      break;
  }

  // ── 7. Write the shim (temp file + rename, never through a symlink). ───
  try {
    fs.mkdirSync(shimDir, { recursive: true });
  } catch (err) {
    refuse(
      `/coms-setup: could not create ${shimDir}: ${message(err)}\n` +
        `next: fix that path, then rerun /coms-setup.`,
    );
    return;
  }
  try {
    writeAtomic(shimPath, shimText(pkgRoot));
  } catch (err) {
    refuse(
      `/coms-setup: could not write ${shimPath}: ${message(err)}\n` +
        `next: make it writable, then rerun /coms-setup.`,
    );
    return;
  }

  // ── 8. Seed the settings file; never overwrite it. ─────────────────────
  // The recipes read durable settings through scripts/coms-setting, and the
  // file lives next to the shim so both follow XDG_CONFIG_HOME. Only a
  // missing file is created: it is the user's file from then on.
  const settingsPath = path.join(shimDir, SETTINGS_FILE);
  let settingsLine: string;
  try {
    if (fs.existsSync(settingsPath)) {
      settingsLine = `settings: ${settingsPath}`;
    } else {
      writeAtomic(settingsPath, settingsTemplate());
      settingsLine = `settings: created ${settingsPath} (commented template; env vars still win)`;
    }
  } catch (err) {
    settingsLine = `settings: could not create ${settingsPath}: ${message(err)}`;
  }

  // ── 9. Prove the shim resolves back to this package. ───────────────────
  // --evaluate is the only check that catches the silent fallback: --list
  // passes even when `repo` came from the hardcoded $HOME path.
  const override = (process.env.PI_COMS_REPO ?? "").trim();
  const expected = override !== "" ? override : pkgRoot;
  const verify = spawnSync(
    "just",
    ["-g", "--no-dotenv", "--evaluate", "repo"],
    { cwd: pkgRoot, encoding: "utf8" },
  );
  if (verify.error) {
    refuse(
      `/coms-setup: wrote ${shimPath} but could not run just to check it: ${verify.error.message}\n` +
        `next: fix just, then rerun /coms-setup.`,
    );
    return;
  }
  if (verify.status !== 0) {
    refuse(
      `/coms-setup: wrote ${shimPath} but \`just -g --evaluate repo\` failed (exit ${verify.status}): ${(verify.stderr ?? "").trim() || "(no stderr)"}\n` +
        `next: fix the package justfile or the just install, then rerun /coms-setup.`,
    );
    return;
  }
  const got = (verify.stdout ?? "").replace(/\r?\n$/, "");
  if (path.resolve(got) !== path.resolve(expected)) {
    refuse(
      `/coms-setup: wrote ${shimPath} but it resolves the wrong repo root: got ${got || "(empty)"}, expected ${expected}.\n` +
        `next: rerun /coms-setup force; if it still fails, check ${path.join(pkgRoot, "justfile")}.`,
    );
    return;
  }

  // ── 10. The old settings filter for this package is stale now. ──────────
  const filterLine = await cleanStaleFilter(info, ctx, stamp);

  // ── 11. Report. ────────────────────────────────────────────────────────
  const lines = [
    `/coms-setup: wired ${shimPath} -> ${pkgRoot}  (coms-setup-shim v${SHIM_VERSION})`,
    `loaded as a package install (${info.source}, scope ${info.scope})`,
    `roles/ scripts/ ok; just ${justVersion} (>= ${MIN_JUST.join(".")})`,
    typecheckReady
      ? "just typecheck: ready"
      : "just typecheck: dev deps missing (npm install in the package)",
    settingsLine,
    ...notes,
  ];
  if (override !== "") {
    lines.push(`PI_COMS_REPO=${override} override is in effect`);
  }
  if (filterLine) lines.push(filterLine);
  lines.push(
    "run: just -g --list   (bare `just -g` has no default recipe: the shim holds only the import)",
  );
  notify(lines.join("\n"), "info");
}

// ━━ Target inspection ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

type Existing =
  | { kind: "absent" }
  | { kind: "ours"; version: number; content: string }
  | { kind: "foreign"; content: string }
  | { kind: "symlink"; target: string }
  | { kind: "directory" }
  | { kind: "error"; message: string };

/** lstat the shim: a symlink is a symlink, we never look through it. */
function inspectTarget(target: string): Existing {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (err: any) {
    if (err?.code === "ENOENT") return { kind: "absent" };
    return { kind: "error", message: message(err) };
  }
  if (stat.isSymbolicLink()) {
    let link = target;
    try {
      link = fs.readlinkSync(target);
    } catch {
      /* keep the path as the target description */
    }
    return { kind: "symlink", target: link };
  }
  if (stat.isDirectory()) return { kind: "directory" };
  if (!stat.isFile()) {
    return { kind: "error", message: "not a regular file, symlink or directory" };
  }
  let content: string;
  try {
    content = fs.readFileSync(target, "utf8");
  } catch (err) {
    return { kind: "error", message: message(err) };
  }
  const version = firstMarkerVersion(content);
  if (version === null) return { kind: "foreign", content };
  return { kind: "ours", version, content };
}

/** First line matching the ownership marker, or null when the file is foreign. */
function firstMarkerVersion(content: string): number | null {
  for (const line of content.split(/\r?\n/)) {
    const m = SHIM_MARKER_RE.exec(line);
    if (m) return Number(m[1]);
  }
  return null;
}

/** The package root a shim points at, read back so reruns can report a move. */
function parseShimImport(content: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    const m = /^import\s+(.+)$/.exec(line);
    if (!m) continue;
    try {
      const value = JSON.parse(m[1]!.trim());
      if (typeof value === "string") return value;
    } catch {
      /* not a plain quoted path - ignore it */
    }
  }
  return null;
}

// ━━ Paths and file writes ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** ${XDG_CONFIG_HOME:-$HOME/.config}/just/justfile, matching just's lookup. */
function globalJustfilePath(): string {
  const xdg = (process.env.XDG_CONFIG_HOME ?? "").trim();
  const configHome =
    xdg !== "" && path.isAbsolute(xdg)
      ? xdg
      : path.join(os.homedir(), ".config");
  return path.join(configHome, "just", "justfile");
}

/** The literal shim text: ownership marker, then the import. */
function shimText(pkgRoot: string): string {
  return [
    "# Managed by pi-ext-agent-comms. Generated by /coms-setup; do not edit.",
    `# coms-setup-shim v${SHIM_VERSION}`,
    `import ${JSON.stringify(path.join(pkgRoot, "justfile"))}`,
    "",
  ].join("\n");
}

/**
 * The seeded settings file: every example commented out, so a fresh install
 * behaves exactly like one with no file. scripts/coms-setting parses this
 * format, not a shell.
 */
function settingsTemplate(): string {
  return [
    "# pi-ext-agent-comms settings.",
    "#",
    "# The just recipes read this file through scripts/coms-setting when the",
    "# matching environment variable is not set. An environment variable always",
    "# wins, so a one-off `PI_COMS_TEAM=frontend just -g role builder` overrides",
    "# whatever is written here.",
    "#",
    "# Format: KEY=value, one per line. Blank lines and lines starting with #",
    "# are ignored; if a key appears twice, the last line wins. Values are used",
    "# as-is (no ~ or $HOME expansion), so paths must be absolute.",
    "#",
    "# Default pool for `just role`, `just backoffice` and `just team`.",
    "#PI_COMS_TEAM=team",
    "",
    "# Directory the `just backoffice` recipe launches in.",
    "#PI_BACKOFFICE_DIR=/home/you/repos/backoffice",
    "",
    "# Tools excluded by `just lean`.",
    "#PI_LEAN_EXCLUDE=ctx_purge,ctx_doctor,ctx_stats,ctx_upgrade,ctx_insight,aio-webpull,aio-webquery,aio-webmap,aio-webresearch,aio-webresult,aio-webcontent,mcp,mcpScript",
    "",
  ].join("\n");
}

/**
 * Write by rename, never by writing the target directly. Rename replaces a
 * symlink node instead of following it, which is the whole point here.
 */
function writeAtomic(target: string, content: string): void {
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.tmp-${process.pid}-${Date.now().toString(36)}`,
  );
  try {
    fs.writeFileSync(tmp, content, { encoding: "utf8", mode: 0o644 });
    fs.chmodSync(tmp, 0o644); // explicit: writeFileSync mode is masked by umask
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* the temp file never got created */
    }
    throw err;
  }
}

function uniqueBackupPath(target: string, stamp: string): string {
  let candidate = `${target}.bak-${stamp}`;
  for (let n = 2; fs.existsSync(candidate); n++) {
    candidate = `${target}.bak-${stamp}-${n}`;
  }
  return candidate;
}

/** 20260922T153812Z - sortable, UTC, no punctuation for filenames. */
function utcStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function safeRealpath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ━━ just version ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function readJustVersion(): string {
  const res = spawnSync("just", ["--version"], { encoding: "utf8" });
  if (res.error) {
    throw new Error(
      (res.error as NodeJS.ErrnoException).code === "ENOENT"
        ? "just was not found on PATH."
        : `could not run just --version: ${res.error.message}`,
    );
  }
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
  if (!m) {
    throw new Error(
      `could not read the version from \`just --version\`: ${out.trim() || "(no output)"}`,
    );
  }
  const got = [Number(m[1]), Number(m[2]), Number(m[3])];
  const version = got.join(".");
  for (let i = 0; i < MIN_JUST.length; i++) {
    if (got[i]! > MIN_JUST[i]!) return version;
    if (got[i]! < MIN_JUST[i]!) {
      throw new Error(
        `just ${version} is too old; this needs just >= ${MIN_JUST.join(".")}.`,
      );
    }
  }
  return version;
}

// ━━ Stale settings filter ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * The package is listed in settings with a plain source string. An older
 * install may carry an `extensions` filter next to it (this machine had
 * ["extensions/*.ts", "!extensions/coms-net.ts"]). The manifest decides what
 * loads now, so offer to drop the key. Report-only when there is no dialog.
 */
async function cleanStaleFilter(
  info: SourceInfo,
  ctx: ExtensionCommandContext,
  stamp: string,
): Promise<string | null> {
  const { configDirName, agentDir } = await loadPiPaths();
  const settingsPath =
    info.scope === "project"
      ? path.join(ctx.cwd, configDirName, "settings.json")
      : path.join(agentDir, "settings.json");

  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return null; // no settings file at this scope
    return `could not read ${settingsPath} to check for a stale extensions filter: ${message(err)}`;
  }
  let settings: any;
  try {
    settings = JSON.parse(raw);
  } catch {
    return `could not parse ${settingsPath} to check for a stale extensions filter`;
  }
  if (!settings || !Array.isArray(settings.packages)) return null;
  const index = settings.packages.findIndex(
    (p: any) => (typeof p === "string" ? p : p?.source) === info.source,
  );
  if (index === -1) return null;
  const entry = settings.packages[index];
  if (typeof entry === "string" || !entry || !("extensions" in entry)) {
    return null;
  }

  const listed = JSON.stringify(entry.extensions);
  const edit = `remove "extensions": ${listed} from the ${info.source} entry`;

  let confirmed = false;
  if (ctx.hasUI) {
    try {
      confirmed = await ctx.ui.confirm(
        "Clean stale coms filter?",
        `${settingsPath} still filters the extensions of this package (extensions: ${listed}).\n` +
          `The package manifest decides what loads now, so the filter is stale.\n\n` +
          `Remove it? A backup of settings.json is written first.`,
      );
    } catch {
      confirmed = false;
    }
  }
  if (!confirmed) {
    return `${settingsPath} still carries a stale extensions filter; ${edit}`;
  }

  const backupPath = uniqueBackupPath(settingsPath, stamp);
  try {
    fs.copyFileSync(settingsPath, backupPath);
  } catch (err) {
    return `could not back up ${settingsPath} to ${backupPath}: ${message(err)}`;
  }
  delete entry.extensions;
  // An entry holding nothing but its source goes back to the plain string form.
  if (Object.keys(entry).length === 1 && typeof entry.source === "string") {
    settings.packages[index] = entry.source;
  }
  try {
    writeAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  } catch (err) {
    return `could not write ${settingsPath}: ${message(err)} (backup: ${backupPath})`;
  }
  return `cleaned the stale extensions filter in ${settingsPath} (backup: ${backupPath})`;
}

/**
 * CONFIG_DIR_NAME and getAgentDir() come from pi so a non-default config
 * directory keeps working. The import is best-effort: if pi's package cannot
 * be resolved from an installed extension, fall back to the documented
 * defaults rather than failing the whole command.
 */
async function loadPiPaths(): Promise<{
  configDirName: string;
  agentDir: string;
}> {
  const fallback = {
    configDirName: ".pi",
    agentDir:
      process.env.PI_CODING_AGENT_DIR ??
      path.join(os.homedir(), ".pi", "agent"),
  };
  try {
    const mod: any = await import("@earendil-works/pi-coding-agent");
    return {
      configDirName:
        typeof mod.CONFIG_DIR_NAME === "string" && mod.CONFIG_DIR_NAME
          ? mod.CONFIG_DIR_NAME
          : fallback.configDirName,
      agentDir:
        typeof mod.getAgentDir === "function"
          ? mod.getAgentDir()
          : fallback.agentDir,
    };
  } catch {
    return fallback;
  }
}
