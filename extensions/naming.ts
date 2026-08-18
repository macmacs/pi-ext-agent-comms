/**
 * Docker-style hierarchical agent naming.
 *
 * Helper module — not an extension itself, but must export a default factory
 * so pi's extension loader doesn't reject it when scanning the directory.
 *
 * Level 1 (base agent):    <adjective>          e.g. "amber"
 * Level 2 (subagent):      <parent>-<noun>      e.g. "amber-basin"
 * Level 3 (sub-subagent):  <parent>-<noun>      e.g. "amber-basin-grove"
 * Level 4+:                <parent>-<6char-hash>
 *
 * Level = name.split("-").length
 *
 * Name state (shuffled word order + cursor) persisted to
 * ~/.pi/coms/name-state.json so picks stay diverse across restarts.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
// No-op factory — this file is a helper module, not a real extension.
export default function (_pi: ExtensionAPI) {}

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Word lists ────────────────────────────────────────────────────────────────

export const ADJECTIVES: string[] = [
  "amber", "azure", "balmy", "bare", "bold", "brisk", "calm", "cedar",
  "chill", "clean", "clear", "cobalt", "cool", "crisp", "cyan", "dark",
  "dawn", "deep", "dense", "dim", "dry", "dusk", "dusty", "early",
  "faint", "fair", "fast", "fierce", "firm", "flat", "fleet", "fresh",
  "full", "gold", "grand", "grave", "gray", "green", "grim", "hazy",
  "high", "hollow", "icy", "idle", "jade", "keen", "large", "late",
  "lean", "light", "lone", "long", "loud", "low", "lucid", "lunar",
  "mellow", "mild", "misty", "moist", "mossy", "muddy", "mute", "narrow",
  "neat", "nimble", "noble", "north", "numb", "oaken", "odd", "old",
  "olive", "open", "pale", "plain", "polar", "prime", "pure", "quiet",
  "rapid", "rare", "raw", "red", "regal", "rich", "rigid", "rocky",
  "round", "ruddy", "rugged", "rusty", "sandy", "sage", "salt", "scarce",
  "sharp", "sheer", "short", "shy", "silent", "slim", "slow", "small",
  "smart", "smoky", "smooth", "snowy", "soft", "solid", "spare", "stern",
  "still", "stone", "stormy", "stout", "subtle", "sunny", "swift", "tall",
  "tame", "tan", "taut", "terse", "thin", "thorn", "tidy", "tight",
  "tiny", "true", "tundra", "twilight", "vast", "vivid", "warm", "wet",
  "wide", "wild", "windy", "wintry", "wise", "wooden", "young", "zealous",
];

export const NOUNS: string[] = [
  "acorn", "apex", "arch", "arc", "ash", "atoll", "axle", "bank",
  "basin", "beam", "bend", "birch", "blade", "bluff", "bolt", "bough",
  "brook", "brush", "butte", "cairn", "canal", "cape", "cave", "cedar",
  "chalk", "chasm", "chord", "cleft", "cliff", "cloud", "coast", "cord",
  "core", "cove", "crag", "creek", "crest", "cross", "crown", "curve",
  "dell", "depth", "dome", "draft", "drift", "dune", "dusk", "dust",
  "echo", "edge", "ember", "fern", "field", "fjord", "flame", "flint",
  "ford", "forge", "fork", "gale", "gate", "glade", "gorge", "grain",
  "grove", "gust", "heath", "helm", "hill", "hinge", "hull", "inlet",
  "isle", "kelp", "knoll", "lake", "lance", "larch", "lath", "ledge",
  "lens", "lime", "loch", "lodge", "loft", "mast", "marsh", "mesa",
  "mill", "mire", "mist", "moor", "moss", "mount", "node", "notch",
  "oak", "opal", "orbit", "pass", "path", "peak", "pine", "plain",
  "plank", "plum", "plunge", "pool", "post", "press", "prism", "quay",
  "raft", "range", "rapid", "reef", "ridge", "rift", "rime", "rind",
  "rise", "road", "rook", "root", "rope", "rune", "rush", "salt",
  "sand", "shelf", "shore", "silt", "slab", "slate", "slope", "smoke",
  "spar", "spine", "spire", "spit", "spray", "spur", "stem", "stone",
  "strand", "stream", "stump", "surge", "swell", "thorn", "tidal", "tile",
  "timber", "torrent", "tower", "trace", "trail", "trunk", "turf", "vale",
  "vault", "vein", "vent", "wave", "weld", "well", "whirl", "wire",
];

// ── State file ────────────────────────────────────────────────────────────────

interface CursorState {
  shuffled: string[];
  cursor: number;
}

interface NameState {
  adjectives: CursorState;
  nouns: CursorState;
}

const STATE_FILE = path.join(
  process.env.PI_COMS_DIR || path.join(os.homedir(), ".pi", "coms"),
  "name-state.json",
);

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function loadNameState(): NameState {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as NameState;
    // Validate — re-initialise any corrupt list
    if (
      Array.isArray(parsed.adjectives?.shuffled) &&
      typeof parsed.adjectives?.cursor === "number" &&
      Array.isArray(parsed.nouns?.shuffled) &&
      typeof parsed.nouns?.cursor === "number"
    ) {
      return parsed;
    }
  } catch {
    // file missing or corrupt — fall through to fresh init
  }
  const state: NameState = {
    adjectives: { shuffled: shuffle(ADJECTIVES), cursor: 0 },
    nouns: { shuffled: shuffle(NOUNS), cursor: 0 },
  };
  saveNameState(state);
  return state;
}

function saveNameState(state: NameState): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, STATE_FILE);
  } catch {
    // best-effort — a lost write just means a duplicate pick next run
  }
}

// ── Internal pick helpers ─────────────────────────────────────────────────────

/**
 * Advance cursor and return the next word not in existingNames.
 * Wraps around the shuffled list. Falls back to a hash if all words collide.
 */
function pickWord(
  cs: CursorState,
  existingNames: Set<string>,
  testName: (word: string) => string,
  fallback: () => string,
): string {
  const len = cs.shuffled.length;
  for (let attempt = 0; attempt < len; attempt++) {
    cs.cursor = (cs.cursor + 1) % len;
    const word = cs.shuffled[cs.cursor];
    if (!existingNames.has(testName(word))) return word;
  }
  return fallback();
}

function hashFallback(): string {
  return crypto.randomBytes(3).toString("hex");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Pick a level-1 (base agent) name — a single adjective.
 * Advances the adjective cursor in name-state.json.
 */
export function pickLevelOneName(existingNames: Set<string>): string {
  const state = loadNameState();
  const word = pickWord(
    state.adjectives,
    existingNames,
    (w) => w,
    () => hashFallback(),
  );
  saveNameState(state);
  return word;
}

/**
 * Pick a subagent name by appending one word to parentName.
 * - Level 2 and 3: append a noun from NOUNS
 * - Level 4+: append a 6-char hex hash (no word pick, no cursor advance)
 */
export function pickSubagentName(
  parentName: string,
  existingNames: Set<string>,
): string {
  const level = parentName.split("-").length; // parent level; child = level + 1
  if (level >= 3) {
    // level 4+ child — hash fallback, no word list needed
    return `${parentName}-${hashFallback()}`;
  }
  const state = loadNameState();
  const word = pickWord(
    state.nouns,
    existingNames,
    (w) => `${parentName}-${w}`,
    () => hashFallback(),
  );
  saveNameState(state);
  return `${parentName}-${word}`;
}
