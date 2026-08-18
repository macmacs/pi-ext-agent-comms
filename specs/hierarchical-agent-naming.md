# Spec: Docker-style Hierarchical Agent Naming

## Status
Ready to implement

## Background

Currently unnamed agents receive auto-generated names like `agent-A3F9C1` (last 6 chars of ULID). This is functional but opaque — hard to remember, no visual hierarchy. Subagents are named `<parent>-sub-N`, encoding relationship via suffix.

The goal is names that are memorable, visually encode hierarchy depth, and degrade gracefully.

---

## Naming Convention

| Level | Pattern | Example |
|-------|---------|---------|
| 1 (base agent) | `<adjective>` | `green` |
| 2 (subagent) | `<parent>-<noun>` | `green-tomato` |
| 3 (sub-subagent) | `<parent>-<noun>` | `green-tomato-hammer` |
| 4+ | `<parent>-<6char-hash>` | `green-tomato-hammer-a3f9c1` |

**Level = `name.split("-").length`** — no extra state needed.

Nouns are reused for levels 2 and 3. Level 4+ falls back to hash suffix — graceful degradation without a combinatorial explosion of word lists.

---

## Word Lists

Two lists embedded in `extensions/naming.ts`:

- `ADJECTIVES` — ~150 entries (e.g. `amber`, `bold`, `calm`, `dark`, `early`, `faint`, `grand`, ...)
- `NOUNS` — ~150 entries (e.g. `acorn`, `basin`, `cave`, `drift`, `ember`, `flame`, `grove`, ...)

Words must be:
- Short (1–2 syllables preferred)
- Unambiguous to spell/type
- No overlap with pi flags, common commands, or reserved words
- No offensive/loaded terms

~150 × ~150 = ~22,500 level-2 combinations; ~3.3M level-3 combinations — exhaustion is not a practical concern.

---

## Name State Persistence

To maximise diversity across restarts, a stable shuffled order is persisted to disk.

**File:** `~/.pi/coms/name-state.json`

```json
{
  "adjectives": { "shuffled": [...], "cursor": 12 },
  "nouns":      { "shuffled": [...], "cursor": 7  }
}
```

**On first run:** shuffle both lists using Fisher-Yates with `crypto.randomBytes` seed, write to disk, cursor starts at 0.

**On each name pick:** advance cursor, wrap around at list end. Collision check (live agents) may advance cursor further — try up to `list.length` positions before falling back to hash.

**Race condition:** two agents starting simultaneously may both read the same cursor. The collision check catches this — one agent advances further. Worst case: one wasted position. Atomic file write (`writeRegistryAtomic`-style) mitigates duplicate writes but is not strictly required here.

---

## New File: `extensions/naming.ts`

```ts
export const ADJECTIVES: string[] = [ ... ]   // ~150 words
export const NOUNS: string[]      = [ ... ]   // ~150 words

// Picks a level-1 name not in existingNames.
// Advances the adjective cursor in name-state.json.
// Falls back to hash if all adjectives are live-collisions.
export function pickLevelOneName(existingNames: Set<string>): string

// Picks a subagent name by appending a word to parentName.
// Level determined by parentName.split("-").length.
// Advances the noun cursor in name-state.json.
// Falls back to "<parentName>-<hash>" at level 4+.
export function pickSubagentName(parentName: string, existingNames: Set<string>): string

// Internal helpers
function loadNameState(): NameState
function saveNameState(state: NameState): void
function advanceCursor(list: string[], state: CursorState, existingNames: Set<string>): string
```

---

## Changes to `extensions/coms.ts`

### 1. Import naming helpers
```ts
import { pickLevelOneName } from "./naming.ts";
```

### 2. Replace default name generation in `session_start`
```ts
// Before:
const defaultName = `agent-${session_id.slice(-6)}`;

// After:
const liveNames = new Set(pruneDeadEntriesAllProjects().map(e => e.name));
const defaultName = pickLevelOneName(liveNames);
```

### 3. `resolveUniqueName` — keep as safety net for `--cname` collisions
The word-pick functions handle collision avoidance internally. `resolveUniqueName` remains for the explicit `--cname` path but its number-suffix fallback is not needed for auto-generated names.

---

## Changes to `extensions/subagent-widget.ts`

### 1. Import naming helpers
```ts
import { pickSubagentName } from "./naming.ts";
```

### 2. Replace `comsName` generation in `spawnSubagent`
```ts
// Before:
const comsName = `${process.env.PI_COMS_NAME ?? "agent"}-sub-${id}`;

// After:
const parentName = process.env.PI_COMS_NAME ?? "agent";
const poolEntries = readAllRegistryEntries(parentName); // scan parent's pool for existing names
const existingNames = new Set(poolEntries.map(e => e.name));
const comsName = pickSubagentName(parentName, existingNames);
```

Note: `readAllRegistryEntries` is a module-level function in `coms.ts` — it will need to be either re-implemented in `naming.ts` (one-liner using `fs.readdirSync`) or inlined in `subagent-widget.ts`. Since `subagent-widget.ts` already does registry reads (via `waitForComsRegistry`), a minimal inline scan is preferred over re-exporting from `coms.ts`.

### 3. Update `isSubagent` detection
```ts
// Before (regex on name):
const isSubagent = /^.+-sub-\d+$/.test(process.env.PI_COMS_NAME ?? "");

// After (env var presence):
const isSubagent = !!process.env.PI_PARENT_SESSION;
```

### 4. Update parent name extraction for reply enforcement
```ts
// Before (strips -sub-N suffix):
const parentName = (process.env.PI_COMS_NAME ?? "").replace(/-sub-\d+$/, "");

// After (reads from env var set by spawn command):
const parentName = process.env.PI_COMS_PROJECT ?? "";
// PI_COMS_PROJECT is set to the parent's coms name (the pool subagents join)
```

---

## Audit: All `-sub-` / `isSubagent` references to update

Search both files before implementing:
- `/-sub-/` regex patterns
- `isSubagent` variable
- Any display strings showing `sub-N` format

---

## Wraparound / Name Reuse

- Collision check is against **live** agents only (`pruneDeadEntries`) — dead agent names are fair game
- Functional risk: none — registry is keyed by `session_id`, not name
- Audit log risk: mild ambiguity if two `green` agents appear in logs over time — mitigated by `session_id` always being present
- Session files: named by `subagent-N-<timestamp>.jsonl`, not agent name — no collision

---

## Open Questions (resolved)

| Question | Decision |
|----------|----------|
| Reuse nouns for level 3? | Yes — keeps the setup concise |
| Random shuffle per startup or persisted? | Persisted cursor in `~/.pi/coms/name-state.json` |
| Cross-extension imports via jiti? | Confirmed supported — docs show helper module pattern |
| Third word list for level 3? | No — reuse NOUNS |
