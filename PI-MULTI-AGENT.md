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
pi install /Users/macmacs/pi-agen-main/pi-ext-agent-comms
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
```

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
    cd ~/agents/{{name}} && pi -e /Users/macmacs/pi-agen-main/pi-ext-agent-comms/extensions/coms.ts --cname {{name}} --project team
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
- Local package: `/Users/macmacs/pi-agen-main/pi-ext-agent-comms` (slimmed to coms + coms-net, merged fork fixes, import-normalized)
- pi docs: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/` (settings.md, packages.md, sdk.md, rpc.md)
