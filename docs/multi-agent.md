# Pi multi-agent notes

Pi offers several multi-agent patterns. This repo ships one of them: the flat
peer-to-peer coms approach from `disler/pi-vs-claude-code` (IndyDevDan's "Pi to
Pi" video), slimmed down to one extension.

Key reference: <https://www.youtube.com/watch?v=PIdETjcXNIk> (chapter "21:39 Pi
to Pi Tools and Codebase Breakdown").

How this repo wires that approach (roles, pools, tmux, models) is in
[team.md](team.md); the extension itself is in [coms.md](coms.md).

## Local team without just

The recipes are the normal way. Without them, a plain peer is just pi plus the
extension:

```bash
pi -e extensions/coms.ts --cname dev --project myteam
pi -e extensions/coms.ts --cname prod --project myteam   # another terminal
```

Tools: `coms_list` (list peers), `coms_send` (prompt a peer, await the reply),
plus the respawn tools. TUI: `/coms` pool view, `%agent` direct interaction.

## Example prompts (from the Pi to Pi video)

The exact verbatim prompts were never published; these are reconstructed from the
video transcript and a community write-up
(<https://sparsenotes.com/posts/2026/05/2026-05-23-pi-to-pi-agent-orchestration/>).

### Demo 1: PII redaction (prod + dev)

prod (Mac mini, gatekeeper):

```
you are the prod gatekeeper, you have a seeded production DB, you have a teammate on the network, you must not expose PII to any other agent.
```

dev (MacBook):

```
bring the affected slice from production over with PII stripped into your local dev DB so an engineer can reproduce the issue locally.
```

The trust boundary lives only in the prod agent's system prompt; it is never
injected into dev's context.

### Demo 2: building an exe.dev skill (expert + driver)

Fresh pool "sandbox", two agents.

E2B expert (GPT-5.5, loaded with the existing E2B skill):

```
you're the E2B expert, your teammate is exe.dev, answer their questions.
```

First it generates a compressed feature inventory file of the E2B skill as its
own reference.

exe.dev driver (Opus 4.7):

```
you're the driver. There is no exe.dev skill yet. Build one. Reference target is the E2B skill. Your teammate will answer questions.
```

The driver/expert split keeps each context at ~20% usage.

### The pattern

Give each agent a role/constraint, name the teammate it can talk to, and define
the end state so they don't loop.

## Role configs: the other way (background)

This repo puts per-role flags in recipes. The other common pattern is a directory
per role: the directory carries durable config, just carries the launch.

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
- `defaultTools` allowlists **built-in** tools only; extension/custom tools
  (coms_\*) stay enabled in every role
- `--tools`/`-t` on the CLI is a **strict allowlist over everything**: include
  coms tools if used, e.g. `-t read,grep,find,ls,coms_list,coms_send`
- Project-local settings need trust once: `/trust` in the dir, or
  `--approve`/`--no-approve` per run
- Built-in pi tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. No
  built-in web tools; web access comes from extensions/skills installed per role
  (`.pi/extensions/` or `pi install <pkg> -l` inside the role dir)

The launcher, then, is a one-liner per role:

```just
role name:
    cd ~/agents/{{name}} && pi -e ~/repos/local/pi-ext-agent-comms/extensions/coms.ts --cname {{name}} --project team
```

```bash
just role researcher
just role reviewer
```

Which pattern to use:

- Roles in separate workspace dirs: role dirs + launcher recipe
- Roles sharing one codebase dir: flags in recipes only (settings cannot differ
  per role within one dir)

This repo takes the flags-in-recipes route, because role peers all launch in
*your* current directory and so cannot have differing directory settings. See
[team.md](team.md) for how per-role models and tool budgets work here.

## Other pi multi-agent patterns (not used here)

- The official `examples/extensions/subagent` example: spawns `pi --mode json`
  subprocesses, single/parallel/chain.
- RPC mode (`pi --mode rpc`): JSON over stdin/stdout for external orchestrators.
- The `@onlinechefgroep/pi-agent-orchestrator` package: swarms, scheduling,
  worktrees.

## pi messaging primitives (reference)

| Primitive | Where | Purpose |
|---|---|---|
| `session.steer(text)` / `--streamingBehavior steer` | SDK / RPC | Inject message during a run, delivered after current tool batch |
| `session.followUp(text)` | SDK / RPC | Queue until agent stops |
| `pi.sendMessage()` | Extensions | Extension drives the LLM (extension commands) |
| `pi.events` | Extensions | Inter-extension event bus in one process |
| `coms_send` | coms tools | Peer-to-peer prompts with await |

## Sources

- Pi to Pi video: <https://www.youtube.com/watch?v=PIdETjcXNIk> (channel:
  @indydevdan)
- Base repo: <https://github.com/disler/pi-vs-claude-code> (coms extensions;
  forks: terakael for TUI/race fixes, TheMule71 as the base fork)
- Community write-up:
  <https://sparsenotes.com/posts/2026/05/2026-05-23-pi-to-pi-agent-orchestration/>
- pi docs: the `docs/` directory of your pi install (settings.md, packages.md,
  sdk.md, rpc.md)

## Removed extensions

Earlier versions of this repo shipped agent-team, agent-chain, pi-pi,
damage-control, subagent-widget, orchestrator and others. They are recoverable
from git history, e.g. `git show 75a2a8d:extensions/subagent-widget.ts`.
