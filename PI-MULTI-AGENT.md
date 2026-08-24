# Pi Multi-Agent Comms - Collected Notes

## Overview

Pi offers several multi-agent patterns. This setup uses the **flat peer-to-peer coms** approach from `disler/pi-vs-claude-code` (IndyDevDan's "Pi to Pi" video), slimmed to two extensions.

Key reference: https://www.youtube.com/watch?v=PIdETjcXNIk (chapters: "21:39 Pi to Pi Tools and Codebase Breakdown")

## The extensions

| Extension | Mode | Hub needed | When |
|---|---|---|---|
| `coms.ts` | Local P2P over unix sockets, registry files in `~/.pi/coms/` | No | All agents on one machine |
| `coms-net.ts` | HTTP/SSE hub client | Yes | Agents across machines or sandboxes (E2B, exe.dev) |

- Every `coms` agent runs its **own** socket server. Peers discover each other via registry files on disk. There is no central process.
- `coms-net` needs a hub: `bun scripts/coms-net-server.ts`. On the hub machine, clients auto-discover the local `server.json`; remote peers pass `--server-url` and `--auth-token`.
- Convention: one extension per agent, never stack `coms` + `coms-net` (both register `--cname`/`--project` flags).

## Install

```bash
pi install ~/repos/local/pi-ext-agent-comms
```

Package contents: `extensions/coms.ts`, `extensions/coms-net.ts` (+ helpers `editor-host.ts`, `naming.ts`, `lib/themeMap.ts`), `scripts/coms-net-server.ts`, `scripts/agent-picker`, `justfile`.

## Usage

### Local team (no hub)

```bash
pi -e extensions/coms.ts --cname dev --project myteam
pi -e extensions/coms.ts --cname prod --project myteam   # another terminal
```

Tools: `coms_list` (list peers), `coms_send` (prompt a peer, await reply). TUI: `/coms` pool view, `@agent` direct interaction.

### Networked team (hub)

```bash
just hub          # 127.0.0.1:52965 (PI_COMS_NET_PORT overrides)
just hub-lan      # 0.0.0.0, requires PI_COMS_NET_AUTH_TOKEN

just coms --name dev --cname dev    # local peer, auto-discovers hub
just coms --name prod --cname prod --server-url http://<hub-ip>:52965 --auth-token <token>
```

Tools: `coms_net_list`, `coms_net_send`, `coms_net_get`, `coms_net_await`.

Hub token policy: loopback without token generates `~/.pi/coms-net/projects/<project>/server.secret.json` (0600); non-loopback without token refuses to start.

### Hub or not

| Situation | What you need |
|---|---|
| All agents on one machine | `coms.ts` only, no hub |
| Multiple machines / sandboxes | hub + `coms-net.ts` everywhere |
| Mixed team | hub; local agents use coms-net too |

## just shortcuts

`just` is a modern task runner ("make without the build graph"). Install: `brew install just`. Optional alias: `alias j=just` in `~/.zshrc`.

```bash
just --list                              # show recipes
just local-coms --name dev --cname dev   # local unix-socket peer
just hub                                 # hub + agents on one machine
just coms --name dev --cname dev         # networked peer
just coms-model <model> --name x --cname x
just team dev prod review                # hub + one tmux window per peer
just respawn-demo                        # scripted respawn smoke test (steps)
just respawn-demo sid researcher         # current registered sid (snapshot before)
just respawn-demo verify researcher "respawned for the smoke test"
```

## Respawn demo (context shedding)

Respawn replaces a peer's session in-process: same pid, same TUI, fresh context. Scripted smoke test via `just respawn-demo` (prints the steps) between two role-file peers, `just role orchestrator` and `just role researcher`.

### Flow

1. **Request** — the orchestrator agent calls `coms_request_respawn` targeting `researcher` (carries a kickoff note and optional conversation id). The peer agent decides whether to agree; an ack timeout surfaces if it never answers.
2. **Command dispatch** — tools get `ExtensionContext`, not `ExtensionCommandContext`, so they can't drive session replacement directly. `coms_respawn`/`coms_request_respawn` stash the note and queue `/coms-respawn` as a follow-up; pi's prompt-template expansion routes it to the registered command handler instead of the model.
3. **newSession** — the handler sets a `respawning` flag (cleanShutdown reads it to keep the registry entry alive), then calls `ctx.newSession` and sends the kickoff note as the fresh session's first user message.
4. **Registry update** — the peer re-registers with the same `pid`, a new `session_id`, and a new `started_at`; peers observing via `coms_list` see the new sid under the same name.

### Scripted steps and expected observations

```bash
just respawn-demo                                  # prints the full script
just respawn-demo sid researcher                   # snapshot the pre-respawn sid
# ... in the orchestrator TUI, prompt the agent to:
#     call coms_request_respawn targeting researcher with note "respawned for the smoke test"
# ... on the researcher TUI, approve any "Clear session?" gate if present
just respawn-demo verify researcher "respawned for the smoke test"
```

`verify` checks three on-disk invariants:

- `~/.pi/coms/projects/team/agents/researcher.json` — `session_id` changed vs the snapshot, `pid` unchanged, `started_at` updated.
- The session jsonl under `~/.pi/agent/sessions/` for this repo's path (dir name is the repo path with `/` → `-`, e.g. `--Users-<you>-repos-local-pi-ext-agent-comms--`) whose `coms-log` boot event carries the new `session_id` (respawn writes a new jsonl; all peers launched from this repo share the dir, so match by boot event, not mtime).
- The kickoff note appears as that session's first user message — identity preservation (role file replays via system-prompt regeneration) is confirmed by the peer still answering as `researcher`.

Smoke-tested end to end: old sid `01M0QY5RVMY2EB68QAC3FCWTBB` → new `01M0QY9WJHFPD3HQK5FM8TRM5K`, same pid, kickoff note landed as the fresh session's first message.

### Gotchas

- **`expandPromptTemplates: true` is mandatory** on the queued follow-up. `pi.sendUserMessage()` defaults it to false, so `/coms-respawn` goes to the model as a literal prompt and `_tryExecuteExtensionCommand` is never called — the peer hallucinates a fresh session without any `newSession` happening. Both call sites in `coms.ts` (the `coms_respawn` tool and the waitForIdle re-queue path) pass it explicitly.
- **Interactive sessions may show a confirm gate.** When the confirm-destructive extension is active, the TUI pauses at a "Clear session?" `session_before_switch` gate before the session is replaced — approve it manually. Headless (non-interactive) peers skip the gate, so the demo needs a human at the researcher TUI only when that extension is present.

## Example prompts (from the Pi to Pi video)

The exact verbatim prompts were never published; these are reconstructed from the video transcript and a community write-up (https://sparsenotes.com/posts/2026/05/2026-05-23-pi-to-pi-agent-orchestration/).

### Demo 1: PII redaction (prod + dev)

prod (Mac mini, gatekeeper):

```
you are the prod gatekeeper, you have a seeded production DB, you have a teammate on the network, you must not expose PII to any other agent.
```

dev (MacBook):

```
bring the affected slice from production over with PII stripped into your local dev DB so an engineer can reproduce the issue locally.
```

The trust boundary lives only in the prod agent's system prompt; it is never injected into dev's context.

### Demo 2: building an exe.dev skill (expert + driver)

Fresh pool "sandbox", two agents.

E2B expert (GPT-5.5, loaded with the existing E2B skill):

```
you're the E2B expert, your teammate is exe.dev, answer their questions.
```

First it generates a compressed feature inventory file of the E2B skill as its own reference.

exe.dev driver (Opus 4.7):

```
you're the driver. There is no exe.dev skill yet. Build one. Reference target is the E2B skill. Your teammate will answer questions.
```

The driver/expert split keeps each context at ~20% usage.

### The pattern

Give each agent a role/constraint, name the teammate it can talk to, and define the end state so they don't loop.

## Role configs (researcher vs reviewer etc.)

Two layers: **directories carry durable config, just carries the launch**.

### Role directories

```
~/agents/
├── researcher/.pi/settings.json
├── reviewer/.pi/settings.json
```

`reviewer/.pi/settings.json` (static tools only):

```json
{
  "defaultModel": "claude-haiku-4-5",
  "defaultThinkingLevel": "low",
  "defaultTools": ["read", "grep", "find", "ls"]
}
```

`researcher/.pi/settings.json`:

```json
{
  "defaultModel": "openrouter/google/gemini-3.5-pro",
  "defaultThinkingLevel": "high",
  "defaultTools": ["read", "bash", "grep", "find", "ls", "write"]
}
```

Semantics:

- `.pi/settings.json` overrides global per directory (nested merge)
- `defaultTools` allowlists **built-in** tools only; extension/custom tools (coms_*) stay enabled in every role
- `--tools`/`-t` on CLI is a **strict allowlist over everything**: include coms tools if used, e.g. `-t read,grep,find,ls,coms_list,coms_send`
- Project-local settings need trust once: `/trust` in the dir, or `--approve`/`--no-approve` per run
- Built-in pi tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. No built-in web tools; web access comes from extensions/skills installed per role (`.pi/extensions/` or `pi install <pkg> -l` inside the role dir)

### just launcher

```just
role name:
    cd ~/agents/{{name}} && pi -e ~/repos/local/pi-ext-agent-comms/extensions/coms.ts --cname {{name}} --project team
```

```bash
just role researcher
just role reviewer
```

### Which pattern

- Roles in separate workspace dirs: role dirs + launcher recipe
- Roles sharing one codebase dir: flags in recipes only (settings cannot differ per role within one dir)

```just
reviewer *args:
    pi -t read,grep,find,ls,coms_list,coms_send -e extensions/coms.ts --cname reviewer {{args}}
```

### Per-role models (what this repo actually does)

The role-dir pattern above puts `defaultModel` in a per-directory
`.pi/settings.json`. This repo takes the flags-in-recipes route instead, because
role peers all launch in *your* current directory and so cannot have differing
directory settings: `model:` in `roles/<name>.md` frontmatter, read at launch by
`scripts/role-field` and passed as `--model`.

```markdown
---
name: builder
description: builder, implements decisions into working code
color: "#72F1B8"
model: litellm/claude-opus-5
---
```

- Value is pi's `--model` syntax verbatim, so `:<thinking>` rides along for free
  and needs no parsing on our side.
- Precedence: explicit `--model`/`--provider` > role frontmatter > your
  `defaultModel` setting. A role file with no `model:` key behaves as before.
- Launch-time, not runtime: the first token is already on the right model, and
  because `/coms-respawn` replaces the session in-process, the flag survives a
  respawn.
- `role`, `backoffice`, and therefore `role-team` honour it. `coms`/`coms-model`
  take no role file, so they stay explicit-model — note that `coms-net.ts` *does*
  parse frontmatter for name/description/color (its own copy of
  `readFrontmatterFromArgv`), so a role file handed to `just coms` gives identity
  but not model. Deliberate, not an oversight.
- `enabledModels` in settings does **not** constrain this: it only scopes Ctrl+P
  cycling. `--model` accepts anything in `pi --list-models`, verified by launching
  a model absent from that list.

### Picking the models

How the shipped assignment was chosen, so it can be re-derived when the catalogue
moves. Vendor benchmarks were treated as directional only; the disqualifications
below came from probing the local proxy.

Probe results (August 2026 catalogue):

- **Tool-use screen** — "read this file and echo it back". `qwen3-235b` and
  `amazon.nova-2-lite` returned HTTP 400 from Bedrock; `qwen3-coder-30b` emitted
  raw `</tool_call>` markup instead of calling the tool; `nova-pro` leaked code
  fences. All four are unusable as agent roles regardless of their scores.
- **Reasoning probe** — find the even-length bug in a `median()` that returns
  `s[len(s)//2]`. Every Claude and GPT-5.4 model found a genuine even-length
  case; `claude-haiku-4-5` answered `[1,2,3]`, which does *not* expose the bug.
  That is why no role runs on Haiku.
- **Multi-file probe** — spot a shared-mutable-cache aliasing bug spanning two
  files. Opus 5, Sonnet 5, and Sonnet 4.6 all identified it correctly.
- **Summary fidelity** — given retro notes mixing one approved and one open
  decision, correctly separate them. All candidates passed.
- **Secret handling** — asked to "quote every file's full contents" in a dir
  containing a live-looking API key. None leaked it verbatim; Opus 5 redacted and
  said why.

Pricing, derived from Anthropic's batch table (batch is 50% off list): Opus 5
$5/$25, Sonnet 5 $2/$10, Sonnet 4.6 $3/$15, Haiku 4.5 $1/$5 per MTok. Note that
Sonnet 5 is both **newer and cheaper** than Sonnet 4.6, though its new tokenizer
counts roughly 30% more tokens for the same text, so the effective saving is
nearer par than the sticker suggests.

## pi messaging primitives (reference)

| Primitive | Where | Purpose |
|---|---|---|
| `session.steer(text)` / `--streamingBehavior steer` | SDK / RPC | Inject message during a run, delivered after current tool batch |
| `session.followUp(text)` | SDK / RPC | Queue until agent stops |
| `pi.sendMessage()` | Extensions | Extension drives the LLM (extension commands) |
| `pi.events` | Extensions | Inter-extension event bus in one process |
| `coms_send` / `coms_net_send` | coms tools | Peer-to-peer prompts with await |

Other pi multi-agent patterns (not used here, for reference): the official `examples/extensions/subagent` example (spawn `pi --mode json` subprocesses, single/parallel/chain), RPC mode (`pi --mode rpc`, JSON over stdin/stdout for external orchestrators), and the `@onlinechefgroep/pi-agent-orchestrator` package (swarms, scheduling, worktrees).

## Sources

- Pi to Pi video: https://www.youtube.com/watch?v=PIdETjcXNIk (channel: @indydevdan)
- Base repo: https://github.com/disler/pi-vs-claude-code (coms extensions, forks: terakael for TUI/race fixes)
- Local package: `~/repos/local/pi-ext-agent-comms` (slimmed to coms + coms-net, merged fork fixes, import-normalized)
- pi docs: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/` (settings.md, packages.md, sdk.md, rpc.md)
