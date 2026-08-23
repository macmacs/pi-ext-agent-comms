# PROTOTYPE - Role file convention sketch

Throwaway reaction sketch for wayfinder ticket "Role file: convention, flag, and replay". The question: which flag carries the per-agent role file, how does identity persist across respawn, and what is the file convention? Answer this, then delete this directory (or absorb the role files).

## Recommended route: role file rides pi's system-prompt flags

Facts that shape it (from closed tickets and pi source):

- `--system-prompt <file>` / `--append-system-prompt <file>` are pi-builtin: pi reads the file body into the system prompt (`customPrompt` / `appendSystemPrompt`).
- On respawn (`ctx.newSession`), pi regenerates the system prompt from the same config, so the role file comes back in the fresh session with **zero re-injection code**.
- coms already scans argv for these two flags and parses frontmatter (`name`, `description`, `color`) from the file: the identity seam exists today (`findSystemPromptPath` + `parseFrontmatter`).
- pi does **not** strip YAML frontmatter from the file: the three metadata lines ride along in the system prompt. Harmless; keep them minimal.
- If the file is missing at launch, pi falls back to injecting the literal path string as the prompt text. The just recipe should guard on file existence.

Consequence: ticket 4's "identity = role file body via `ctx.newSession({ setup })`" is **dropped**: `setup` goes unused. The identity never needs re-injection because pi's own system-prompt regeneration carries it.

## Example role files

See `roles/dev.md` and `roles/prod.md` (LF line endings, three-line frontmatter, body = identity).

```markdown
---
name: dev
description: frontend engineer, owns the local dev DB
color: "#72F1B8"
---
You are dev, the frontend engineer on this team. You own the local dev DB.
...
```

## Launch

```bash
just role dev     # pi -e extensions/coms.ts --cname dev --append-system-prompt roles/dev.md --project team
```

Precedence stays as today: CLI flags > frontmatter > defaults. `--cname` wins over `frontmatter.name`; file named after the cname.

## Replay on respawn

1. `coms_respawn` / `respawn_request` queues `/coms-respawn` (semantics from ticket 4, unchanged).
2. Command handler: `ctx.waitForIdle()` then `ctx.newSession({ parentSession, withSession: kickoff })`. **No `setup`.**
3. pi tears down and builds the fresh session's system prompt from the same config: role body present again. `session_start { reason: "new" }` re-runs coms: re-parses argv frontmatter, re-resolves identity, re-registers.
4. `withSession` kicks off: the trigger note, or the default "You respawned to shed stale context. Continue your current work."

## Alternative considered: dedicated `--role-file` flag + setup injection

`registerFlag("role-file")`; coms reads the body at respawn and injects via `ctx.newSession({ setup })`.

Costs: the initial session never gets the role in the system prompt (coms would have to inject it at `session_start`, racy); every respawn re-injects a large user message; the role is demoted from system prompt to transcript message; new flag + parser + replay code. Wins nothing except keeping ticket 4's wording. Rejected unless the user overrides.

## Open choices (for the HITL round)

- Q1 Carrier and persistence route: system-prompt flags (recommended, amends ticket 4) vs dedicated `--role-file` flag (keeps ticket 4).
- Q2 If reusing the builtin flags: `--append-system-prompt` (role augments the default harness prompt; recommended) vs `--system-prompt` (role replaces it).
- Q3 File convention: repo `roles/<cname>.md` (recommended) vs `~/.pi/roles/<cname>.md` vs per-role dirs.
- Known wrinkle (accepted): frontmatter leaks into the system prompt; missing file leaks the path string.
