/**
 * /coms-models - per-machine model overrides for role peers.
 *
 *   /coms-models                      list roles, their model, and where it came from
 *   /coms-models set <role> <model>   write PI_COMS_MODEL_<ROLE>=<model> to coms.env
 *   /coms-models unset <role>         remove that line again
 *
 * The overrides live in the same per-machine settings file the recipes already
 * read, `${XDG_CONFIG_HOME:-$HOME/.config}/just/coms.env`. `just role` picks
 * the model at launch, so a change applies from the next launch; the running
 * session keeps its model.
 *
 * Role discovery and model precedence are NOT re-implemented here: the list
 * comes from `scripts/role-resolve list`, the same code the recipes run, so the
 * command and `just role` cannot disagree.
 *
 * Registered from coms.ts; a plain module, not a manifest entry.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
  settingsFilePath,
  settingsTemplate,
  writeAtomic,
} from "./coms-setup.ts";

// ━━ Pure helpers (exported for tests) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Role names are letters, digits and `-`. No `_`: `a_b` and `a-b` would share
 * one settings key. Same rule as scripts/role-resolve.
 */
export function validRoleName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(name);
}

/** secops-dev -> PI_COMS_MODEL_SECOPS_DEV */
export function modelKey(role: string): string {
  return `PI_COMS_MODEL_${role.toUpperCase().replace(/-/g, "_")}`;
}

/** A model string scripts/coms-setting can carry: one word, no quotes. */
export function validModelValue(model: string): boolean {
  return /^[^\s"'#]+$/.test(model);
}

/**
 * Set (value) or remove (null) one `KEY=value` line in coms.env text. The
 * first live line for the key is replaced in place, later duplicates are
 * dropped, comments and every other line are kept. A missing key is appended.
 */
export function applySetting(
  text: string,
  key: string,
  value: string | null,
): string {
  const re = new RegExp(`^\\s*${key}\\s*=`);
  const lines = text.split("\n");
  const out: string[] = [];
  let done = false;
  for (const line of lines) {
    if (re.test(line)) {
      if (!done && value !== null) out.push(`${key}=${value}`);
      done = true;
      continue;
    }
    out.push(line);
  }
  if (!done && value !== null) {
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    if (out.length > 0) out.push("");
    out.push(`${key}=${value}`);
  }
  let result = out.join("\n");
  if (!result.endsWith("\n")) result += "\n";
  return result;
}

/** Thinking suffixes pi accepts after `<provider>/<id>:`. */
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** `<provider>/<id>[:<thinking>]` -> provider + id, or null if it does not parse. */
export function splitModel(model: string): { provider: string; id: string } | null {
  const slash = model.indexOf("/");
  if (slash < 1 || slash === model.length - 1) return null;
  const provider = model.slice(0, slash);
  let id = model.slice(slash + 1);
  const colon = id.lastIndexOf(":");
  if (colon > 0 && THINKING.has(id.slice(colon + 1))) id = id.slice(0, colon);
  return { provider, id };
}

// ━━ Role list via scripts/role-resolve ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface RoleRow {
  name: string;
  scope: string; // project | user | shipped
  path: string;
  model: string; // empty = pi default
  source: string; // env | coms.env | role | empty
}

/** Package root: PI_COMS_REPO (same override as the justfile), else ours. */
export function comsRepo(): string {
  const env = (process.env.PI_COMS_REPO ?? "").trim();
  if (env && fs.existsSync(path.join(env, "scripts", "role-resolve"))) return env;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function listRoles(
  repo: string,
  cwd: string,
): { rows: RoleRow[]; error: string } {
  const script = path.join(repo, "scripts", "role-resolve");
  const r = spawnSync(script, ["list", cwd], { encoding: "utf8" });
  if (r.error || r.status !== 0) {
    return {
      rows: [],
      error: (r.error?.message ?? r.stderr ?? "").trim() || `exit ${r.status}`,
    };
  }
  const rows = r.stdout
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const [name = "", scope = "", p = "", model = "", source = ""] = l.split("\t");
      return { name, scope, path: p, model, source };
    });
  return { rows, error: (r.stderr ?? "").trim() };
}

// ━━ Command ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

type Notify = (text: string, level: "info" | "warning" | "error") => void;

/** true / false when the registry can answer, null when it cannot. */
function modelKnown(ctx: ExtensionCommandContext, model: string): boolean | null {
  const parts = splitModel(model);
  if (!parts) return false;
  try {
    const reg = ctx.modelRegistry;
    if (!reg) return null;
    return reg.find(parts.provider, parts.id) !== undefined;
  } catch {
    return null;
  }
}

function sourceLabel(row: RoleRow): string {
  switch (row.source) {
    case "env":
      return `env ${modelKey(row.name)}`;
    case "coms.env":
      return "coms.env";
    case "role":
      return "role file";
    default:
      return "";
  }
}

function listText(
  ctx: ExtensionCommandContext,
  rows: RoleRow[],
  settings: string,
): string {
  const lines = [`/coms-models  (settings: ${settings})`];
  if (rows.length === 0) lines.push("  no roles found");
  const nameW = Math.max(4, ...rows.map((r) => r.name.length + (r.scope === "shipped" ? 0 : r.scope.length + 3)));
  const modelW = Math.max(5, ...rows.map((r) => (r.model || "(pi default)").length));
  for (const r of rows) {
    const name = r.scope === "shipped" ? r.name : `${r.name} [${r.scope}]`;
    const model = r.model || "(pi default)";
    let tail = sourceLabel(r);
    if (r.model && modelKnown(ctx, r.model) === false) tail += tail ? ", unknown to pi" : "unknown to pi";
    lines.push(`  ${name.padEnd(nameW)}  ${model.padEnd(modelW)}  ${tail}`.trimEnd());
  }
  lines.push("", "set: /coms-models set <role> <model>   unset: /coms-models unset <role>");
  return lines.join("\n");
}

/** Read coms.env through a symlink (dotfile managers link it), never replace the link. */
function writeSettings(file: string, update: (text: string) => string): string {
  let target = file;
  let text: string;
  if (fs.existsSync(file)) {
    target = fs.realpathSync(file);
    text = fs.readFileSync(target, "utf8");
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    text = settingsTemplate();
  }
  writeAtomic(target, update(text));
  return target;
}

export async function runComsModels(
  args: string,
  ctx: ExtensionCommandContext,
  repo: string = comsRepo(),
): Promise<void> {
  const notify: Notify = (text, level) => {
    try {
      ctx.ui.notify(text, level);
    } catch {
      /* no UI (print mode) */
    }
  };
  const words = args.trim().split(/\s+/).filter(Boolean);
  const sub = words[0] ?? "list";
  const settings = settingsFilePath();
  const cwd = ctx.cwd ?? process.cwd();

  if (sub === "list") {
    const { rows, error } = listRoles(repo, cwd);
    notify(listText(ctx, rows, settings) + (error ? `\n\n${error}` : ""), error && rows.length === 0 ? "error" : "info");
    return;
  }

  if (sub !== "set" && sub !== "unset") {
    notify(`/coms-models: unknown subcommand '${sub}'. Use: list | set <role> <model> | unset <role>`, "error");
    return;
  }
  const role = words[1] ?? "";
  if (!validRoleName(role)) {
    notify(`/coms-models: bad role name '${role}' (use letters, digits and -)`, "error");
    return;
  }
  const key = modelKey(role);
  const warnings: string[] = [];

  let value: string | null = null;
  if (sub === "set") {
    if (words.length !== 3 || !validModelValue(words[2]!)) {
      notify("/coms-models: usage: /coms-models set <role> <provider>/<id>[:<thinking>]", "error");
      return;
    }
    value = words[2]!;
    const known = modelKnown(ctx, value);
    if (known === false) warnings.push(`pi does not know ${value} here; written anyway`);
  } else if (words.length !== 2) {
    notify("/coms-models: usage: /coms-models unset <role>", "error");
    return;
  }

  const { rows } = listRoles(repo, cwd);
  if (!rows.some((r) => r.name === role)) {
    warnings.push(`no role '${role}' found from ${cwd}`);
  }
  const envValue = (process.env[key] ?? "").trim();
  if (envValue) {
    warnings.push(`env ${key}=${envValue} is set in this session and wins over coms.env`);
  }

  let written: string;
  try {
    written = writeSettings(settings, (text) => applySetting(text, key, value));
  } catch (err) {
    notify(`/coms-models: could not write ${settings}: ${err instanceof Error ? err.message : String(err)}`, "error");
    return;
  }
  const what = value === null ? `removed ${key}` : `${key}=${value}`;
  const lines = [`/coms-models: ${what} in ${written}`, "applies from the next launch; this session keeps its model"];
  for (const w of warnings) lines.push(`warning: ${w}`);
  notify(lines.join("\n"), warnings.length > 0 ? "warning" : "info");
}

// ━━ Registration ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function registerComsModels(pi: ExtensionAPI): void {
  // Role names for completion; one role-resolve run per 5 s at most.
  let cache: { at: number; names: string[] } = { at: 0, names: [] };
  const roleNames = (): string[] => {
    if (Date.now() - cache.at > 5000) {
      cache = { at: Date.now(), names: listRoles(comsRepo(), process.cwd()).rows.map((r) => r.name) };
    }
    return cache.names;
  };

  pi.registerCommand("coms-models", {
    description:
      "List role models, or set/unset a per-machine model override in coms.env (next launch)",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const m = prefix.match(/^(\S*)$/);
      if (m) {
        const subs = ["list", "set", "unset"].filter((s) => s.startsWith(m[1]!));
        return subs.map((s) => ({ value: s === "list" ? s : `${s} `, label: s }));
      }
      const r = prefix.match(/^(set|unset)\s+(\S*)$/);
      if (r) {
        return roleNames()
          .filter((n) => n.startsWith(r[2]!))
          .map((n) => ({ value: `${r[1]} ${n}${r[1] === "set" ? " " : ""}`, label: n }));
      }
      return null;
    },
    handler: async (args, ctx) => runComsModels(args ?? "", ctx),
  });
}
