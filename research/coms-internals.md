# Coms internals: where respawn plugs in

Research for wayfinder ticket "Coms internals: where respawn plugs in".

## Answer in one paragraph

coms.ts is already session-replacement-proof: `session_start` regenerates the session id, socket endpoint, and registry entry every time it runs (it re-runs idempotently on `/new`, so on respawn the extension gets torn down by `session_shutdown` and rebuilt by `session_start` automatically). Respawn needs: a `coms_respawn` tool that queues a `/coms-respawn` command, a command handler that calls `ctx.newSession`, and a new `respawn_request` envelope type handled like `handlePrompt` (steer the receiver; receiver decides). The role file can reuse the existing `--system-prompt` argv scan + `parseFrontmatter`.

## Facts with sources

Sources: `extensions/coms.ts` (this repo, ~3052 lines), `extensions/editor-host.ts`, `extensions/naming.ts`.

### Identity lifecycle is per-pi-session

- `pi.on("session_start")` (line 1310): generates `session_id = ulid()`, resolves name from `--cname` / frontmatter / `PI_COMS_NAME` / auto-generated, binds a unix socket at `~/.pi/coms/sockets/<session_id>.sock`, writes `~/.pi/coms/projects/<project>/agents/<name>.json` atomically, rebuilds the in-memory `identity`, installs pool widget + editor host. Comment in code: "idempotent if session_start re-runs".
- `pi.on("session_shutdown")` (line 3035): `cleanShutdown()` closes the socket, removes registry entries, uninstalls widgets, broadcasts a `closing` status.
- Therefore a `ctx.newSession()` respawn automatically produces: new session id, new socket, rewritten registry entry under the **same name**, fresh widgets. No extra teardown code needed.

### Registry and target resolution

- Registry entry: `{ session_id, name, purpose, model, color, pid, endpoint, cwd, started_at, explicit, version: 1, tmux_* }`. No role field today.
- Registry is keyed by **name** (one file per name per project); the session id lives inside it.
- `resolveTarget` (used by `coms_send`) resolves a name to the current registry entry: **name-based sends transparently follow the new session after respawn**. Session-id-based references go stale.

### Message flow

- `coms_send` (line 2623): fire-and-forget, ack on delivery, `PromptEnvelope { type: "prompt", msg_id, sender_session, sender_endpoint, sender_name, sender_cwd, hops, timestamp, prompt, conversation_id }`.
- `handlePrompt` (line 792): steers the receiver via `pi.sendMessage({ customType: "coms-inbound", ... }, { deliverAs: "followUp", triggerTurn: true })`, then acks. The receiver is never forced: the message arrives in context and the agent decides.
- A `respawn_request` envelope would follow the same pattern: new `EnvelopeType`, a handler that steers the target with a formatted request message, the target decides (its LLM calls `coms_respawn`). This satisfies "message, not command".

### Tools and commands

- Tools: `coms_list`, `coms_send` (lines 2505, 2623). A `coms_respawn` tool slots in here. Per the mechanism research, its `execute` can only queue a command: `pi.sendUserMessage("/coms-respawn", { deliverAs: "followUp" })`.
- Commands: `/coms` (pool widget refresh, line 2875). A `/coms-respawn` command handler would `await ctx.waitForIdle()` then `await ctx.newSession({ parentSession, setup, withSession })`.

### Role file: existing hook

- `findSystemPromptPath(argv)` (line 610): scans argv for pi-builtin `--system-prompt <file.md>` (preferred) or `--append-system-prompt`; `parseFrontmatter(raw)` (line 253) extracts `name`, `description`, `color` from the file's frontmatter (used at `session_start`, line 1315).
- So the role-file convention can build on an existing seam: one markdown file whose **body is the identity** and whose **frontmatter carries coms metadata** (`name`, `purpose`). Either reuse `--system-prompt` or register a new `--role-file` flag that reads the same file; respawn replays the body via `setup`, and `session_start` re-reads frontmatter so name/color stay stable across sessions.

### What breaks on respawn (handoff to the semantics ticket)

1. **Registry gap**: between `session_shutdown` (entry removed) and `session_start` (entry rewritten) the agent is invisible: peer `coms_list` misses it and name-based `resolveTarget` fails. Window is milliseconds but real for concurrent senders.
2. **Stale session ids**: peers holding the old `session_id` (conversation cards, relay bookkeeping `peerCards` keyed by session id) see the old card close and a new card appear; nothing maps old->new session id today.
3. **In-flight sends**: `coms_send` is ack-based; a send landing in the gap gets a connection error ("receiver unreachable"). No retry-against-new-session logic exists.
4. **Status broadcasts**: peers get a `closing` broadcast for the old session id (from `cleanShutdown`) and then a fresh status from the new one; TUI churn is handled, but the semantic "this is the same agent, new session" is not communicated.
5. **`conversation_id` continuity**: messages carry `conversation_id`; after respawn the new session has no memory of it - a trigger note can carry it, but coms does not do this automatically.
6. **Registry `version: 1`**: adding a role field or a `previous_session_id` would bump schema considerations; old peers just ignore unknown fields (JSON), so additive fields are safe.
