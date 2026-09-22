# coms

`extensions/coms.ts` is the whole extension. It gives every pi session a name and
a socket, and lets sessions talk to each other on the same machine. No hub, no
server process, no runtime dependencies beyond pi's bundled packages.

The launch side of this (roles, models, tool budgets, tmux) lives in
[team.md](team.md). Example prompts and other pi multi-agent patterns live in
[multi-agent.md](multi-agent.md).

## Identity and registry

Every pi instance running coms gets an identity from `--cname` / `--project` and
registers in `~/.pi/coms/projects/<project>/agents/<name>.json`.

```bash
just -g role builder                                    # identity from roles/builder.md
pi -e extensions/coms.ts --cname dev --project myteam
pi -e extensions/coms.ts --cname prod --project myteam  # in another terminal
```

- `--cname` is the peer name (from the role file when you use `just role`,
  otherwise auto-generated). Pi's own `--name` is a different thing: it names the
  session and is resumed by the harness.
- `--project` is the pool. Peers only see each other if they share it.
- The registry file holds pid, session id, socket path, start time and the last
  turn stamp. Peers discover each other by reading those files. Each agent runs
  its own unix socket server, so there is no central process to start or babysit.
- `--purpose`, `--color` and `--explicit` override the frontmatter / palette
  defaults. An `explicit` peer is hidden from auto-discovery and only reachable
  by exact name.

Messages carry sender, session id, hop count and conversation id. The hop limit
is `PI_COMS_MAX_HOPS` (default 5); past it the receiver nacks with
`hops exceeded`. A keepalive ping runs every `PI_COMS_PING_INTERVAL_MS`
(default 10s) and a peer is evicted after 3 missed cycles.

`PI_COMS_PROJECT` and `PI_COMS_NAME` are written by the extension at boot so
co-loaded extensions can read the identity, and so `/reload` reuses the same name
instead of drawing a new one. `PI_PARENT_SESSION` is only ever read
(`IS_ROOT = !PI_PARENT_SESSION`, gating the cascade ping); nothing in this repo
or in pi sets it today, so every coms agent currently counts as root.

## Tools and TUI

Tools:

- `coms_list` - list peers with live status and idle time
- `coms_send` - send a prompt to a peer and await its reply
- plus the respawn tools below

TUI:

- `/coms` opens the pool view with live status
- `%agent` talks to one peer directly
- Ctrl+O expands message details

## Why `%` and not `@`

Peer mentions use `%`, not `@`. `@` is pi's built-in path completion, and an
earlier build layered agents on top of it - which broke paths: `@src`
fuzzy-matched the agent `scribe`, agents were listed first, and Enter inserted
`@scribe` instead of the path. `%` has no meaning in paths, globs, shells or
markdown, so the two never collide.

```
@src        -> src/ , src/foo.ts        pi built-in, untouched
%           -> %oracle, %scribe, ...    all live peers, every pool
%ora        -> %oracle
100%done    -> nothing                  needs line start or whitespace before %
%20         -> nothing                  same rule, so URL escapes stay quiet
```

`coms_send` and friends still accept a leading `@` on a target name for
back-compat, so old transcripts keep working.

## Respawn and cold respawn

Respawn replaces a session in-process - same pid, same TUI, fresh context - and
the role identity is regenerated from the role file. Three ways in, differing
only in who decides and whether the peer pays for a turn:

| Tool | Who decides | Costs the peer a turn? |
| --- | --- | --- |
| `coms_respawn` | yourself | yes, a kickoff turn continues your work |
| `coms_respawn` with `cold: true` | yourself | **no** - the note is stored, nothing is sent |
| `coms_request_respawn` | you ask, peer chooses | yes, the peer wakes to consider it |
| `coms_cold_respawn` | you decide for an idle peer | **no** - the peer never wakes |

`coms_cold_respawn` exists because asking is not free. A respawn request is a
message, a message is a turn, and that turn re-sends the entire stale context at
uncached price purely to throw it away. So the cold path delivers no message and
triggers no LLM call: the fresh session is seeded with your note as stored
context and idles at zero API cost until real work arrives. Verified against a
provider-request probe: boot 0 requests, one real turn 1 request, cold respawn
still 1, and only prompting the fresh session made it 2.

The peer gets no veto - a veto needs a turn, which is the cost being removed - so
its interests are protected structurally instead. A peer that is running,
blocked, or already respawning is **skipped, not errored**, and the ack says
which:

```
coms_cold_respawn -> builder: skipped (running), session left intact
coms_cold_respawn -> builder: queued, no turn fired
```

Always check the result rather than assuming it took effect.

`coms_list` reports idle time per peer to tell you who is worth recycling,
marking anyone past the cache TTL as `cache cold` - past that point the prompt
cache is gone anyway, so respawning costs nothing in cache terms:

```
● %builder (claude-opus-5) 34% idle 12m (cache cold) - implements decisions
● %scribe  (claude-opus-5) 8%  running                - owns the written record
● %legacypeer (claude-opus-5) ?% idle ?               - peer on an older coms build
```

Idle time is read from the live peer where possible and the registry snapshot
otherwise; a peer too old to report it shows `idle ?` rather than passing as
freshly idle. Override the TTL with `PI_COMS_CACHE_TTL_MS`.

**`coms_list` is not race-free.** Its `running` flag comes from a snapshot that
can lag, and a peer has been observed reporting `is_running: false` while
demonstrably mid-turn. Treat it as a hint for choosing who to recycle, never as
proof a peer is idle. The receiver-side guardrail behind the ack is the only
authoritative gate, which is exactly why the skip decision lives there and not in
the caller.

Combined with the session-hygiene rule coms adds to every agent's system prompt -
one task per session, respawn while idle rather than after a prompt lands, finish
in-flight work first - this keeps long-lived teams from dragging stale context
between unrelated tasks.

### How respawn works under the hood

1. **Request** - the calling agent invokes `coms_request_respawn` targeting a
   peer (with a kickoff note and optional conversation id). The peer decides
   whether to agree; an ack timeout surfaces if it never answers.
2. **Command dispatch** - tools get `ExtensionContext`, not
   `ExtensionCommandContext`, so they cannot drive session replacement directly.
   `coms_respawn` / `coms_request_respawn` stash the note and queue
   `/coms-respawn` as a follow-up; pi's prompt-template expansion routes it to
   the registered command handler instead of the model.
3. **newSession** - the handler sets a `respawning` flag (cleanShutdown reads it
   to keep the registry entry alive), then calls `ctx.newSession` and sends the
   kickoff note as the fresh session's first user message.
4. **Registry update** - the peer re-registers with the same `pid`, a new
   `session_id`, and a new `started_at`; peers observing via `coms_list` see the
   new sid under the same name.

Cold respawn removes step 1: the `respawn_cold` envelope delivers no message, so
the receiving extension goes straight to step 2. The queued `/coms-respawn` is
consumed by the command handler during prompt-template expansion, so it never
becomes a model request; the kickoff note is written into the fresh session with
`appendMessage` (stored) instead of `sendUserMessage` (sent), and the
`withSession` callback is omitted entirely, because any callback that sent a
message would trigger the exact turn being avoided.

Two gotchas worth knowing:

- **`expandPromptTemplates: true` is mandatory** on the queued follow-up.
  `pi.sendUserMessage()` defaults it to false, so `/coms-respawn` would go to the
  model as a literal prompt and `_tryExecuteExtensionCommand` would never be
  called - the peer would hallucinate a fresh session with no `newSession` ever
  happening.
- **Interactive sessions may show a confirm gate.** When the
  confirm-destructive extension is active, the TUI pauses at a "Clear session?"
  `session_before_switch` gate before the session is replaced - approve it
  manually. Headless (non-interactive) peers skip the gate.

A scripted smoke test lives in the repo: `just respawn-demo` prints the steps,
`just respawn-demo sid researcher` snapshots the session id,
`just respawn-demo verify researcher "<note>"` checks the three on-disk
invariants: the registry `session_id` changed with the same `pid`, the new
session jsonl carries the new sid in its `coms-log` boot event, and the kickoff
note is that session's first user message.

## One prompt block, appended last (`--role`)

Both launchers pass the role file with coms' own `--role` flag, **not**
`--append-system-prompt`. `coms.ts` then assembles ONE block - identity, role
body, team rules, session hygiene - and returns it from `before_agent_start`, so
it lands at the very **end** of the system prompt.

This matters because of how pi builds the prompt:

```
base prompt + tool guidelines   ~15.7k chars   64%
pi docs block                    ~1.2k
appendSystemPrompt               <-- role text used to land HERE, mid-prompt
<project_context> (AGENTS.md)    ~2.1k
<available_skills>               ~3.1k
cwd
<-- before_agent_start output lands HERE, genuinely last
```

With `--append-system-prompt` the role was 2% of the prompt, buried behind ~13k
chars of dense tool guidelines and outranked on recency by the ~5k chars of
`AGENTS.md` and skill listings that pi appends after it. A writing-style rule
stated there loses to a project `AGENTS.md` that states the same rule in
different words further down.

Side effects of moving to `--role`:

- The role's YAML frontmatter is no longer pasted into the prompt as text.
  `--append-system-prompt` reads the file verbatim; `coms.ts` strips it.
- Identity and shared rules are one block with one heading tree, not two
  disconnected appends.
- Style is stated once, at the tail, with an explicit note that it overrides the
  tool guidelines above it.

`--system-prompt` and `--append-system-prompt` still work for older launchers:
`coms.ts` reads identity frontmatter from them as before and appends only the
hygiene block, so the role body is never injected twice.

Respawn advice is not stored in the role files either. `coms.ts` generates the
session hygiene block and tailors it per role (the orchestrator gets the
cold-respawn-your-peers line, everyone else gets the respawn-yourself lines), so
duplicating it in a role file only wastes tokens.
