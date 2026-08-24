# pi-ext-agent-comms

Peer-to-peer agent communication for the Pi coding agent. Two extensions:

- **coms** (`extensions/coms.ts`): local agent-to-agent messaging over unix sockets. Flat peer team, no orchestrator. Any agent can ping, prompt, and await responses from any other agent in the pool.
- **coms-net** (`extensions/coms-net.ts`): the same protocol over a network hub (Bun HTTP/SSE server), for agents on other machines or sandboxes (E2B, exe.dev, etc.). Remote-only, and the only piece that needs Bun.

Slimmed down to just these two extensions from three upstream repos:

- [disler/pi-vs-claude-code](https://github.com/disler/pi-vs-claude-code): the original `coms` work (IndyDevDan's "Pi to Pi")
- [terakael/pi-vs-claude-code](https://github.com/terakael/pi-vs-claude-code): TUI/race fixes
- [TheMule71/pi-vs-claude-code](https://github.com/TheMule71/pi-vs-claude-code): base fork this repo was forked from

## Install

Global install (recommended) — `coms` then auto-loads in **every** pi session, in any directory, so you no longer need `-e`:

```bash
just install-global
```

That runs `pi install <repo>` and symlinks the justfile to `~/.config/just/justfile` so `just -g <recipe>` works from anywhere. Or do it by hand:

```bash
pi install ~/repos/local/pi-ext-agent-comms
```

> **Filter to `coms.ts`.** The package declares both extensions, but `coms-net.ts`
> notifies an error on every boot when no hub is configured. Restrict the global
> install in `~/.pi/agent/settings.json`, and load coms-net per session with an
> explicit `pi -e <repo>/extensions/coms-net.ts` when you actually want a hub:
>
> ```json
> { "source": "/absolute/path/to/pi-ext-agent-comms",
>   "extensions": ["extensions/coms.ts"] }
> ```
>
> (pi settings need a real absolute path here — `~` is not expanded.)

Or load for one session only:

```bash
pi -e extensions/coms.ts        # local P2P
pi -e extensions/coms-net.ts   # network hub client
```

No runtime dependencies beyond pi's bundled packages. `just` recipes included (`just --list`).

### Running recipes from any working directory

`just` searches **upward** for a justfile and runs recipes in the justfile's own
directory — so recipes are written to be location-independent. Peers launch in
**your current directory** (inheriting that project's `.pi/` extensions,
`AGENTS.md`, RAG index), while `roles/` and `scripts/` always resolve against the
repo:

```bash
cd ~/repos/some-project
just -g role builder                       # after `just install-global`
just -f ~/repos/local/pi-ext-agent-comms/justfile role builder   # without the symlink
```

No usernames are baked into the justfile. `repo` resolves in this order:
`PI_COMS_REPO` → `justfile_directory()` when it contains `roles/` (the normal
in-repo and `-f` cases) → `$HOME/repos/local/pi-ext-agent-comms` (the `just -g`
fallback, since the global symlink makes `justfile_directory()` point at
`~/.config/just`). If your clone lives elsewhere:

```bash
PI_COMS_REPO=/path/to/clone just -g role builder
```

| Variable | Default | Controls |
|---|---|---|
| `PI_COMS_REPO` | auto-detected, else `$HOME/repos/local/pi-ext-agent-comms` | where `roles/` and `scripts/` are found |
| `PI_BACKOFFICE_DIR` | `$HOME/repos/backoffice` | the dir `just backoffice` launches in |
| `PI_COMS_TEAM` | `team` | default pool for `role` / `backoffice` / `team` (override per-run with `--team`) |
| `PI_COMS_MAIN_PANE_WIDTH` | `60%` | width of the main (first role) pane in a tiled `team` / `role-team` |

### Optional: zsh setup

Not required, but removes the `-g` typing. Both snippets go in `~/.zshrc`; this
repo does not manage your shell config.

Homebrew ships a `just` completion (`_just`). It only activates if Homebrew's
`site-functions` is on `fpath` **before** `compinit` runs:

```zsh
if [[ -d /opt/homebrew/share/zsh/site-functions ]]; then
  fpath=(/opt/homebrew/share/zsh/site-functions $fpath)
fi
```

A `j` wrapper that prefers a project's own justfile and falls back to the global
one, so coms recipes work from anywhere without `-g`:

```zsh
j() {
  local d=$PWD n
  while true; do
    for n in justfile Justfile .justfile .Justfile; do
      [[ -f $d/$n ]] && { just "$@"; return }
    done
    [[ $d == / || -z $d ]] && break
    d=${d:h}
  done
  just -g "$@"
}
# Deferred: plugin managers (antigen, oh-my-zsh) run compinit in a precmd hook,
# which discards a compdef issued at rc time.
_j_compdef() { compdef j=just 2>/dev/null; add-zsh-hook -D precmd _j_compdef; }
autoload -Uz add-zsh-hook && add-zsh-hook precmd _j_compdef
```

Then `j role builder --team frontend` works from any directory, and `j <TAB>`
completes recipe names. Two notes:

- A plain `alias j='just -g'` would ignore a project's own justfile — you'd `cd`
  into a repo, run `j test`, and silently get global recipes. Hence the walk.
- The walk checks for the file rather than asking `just` to parse it, so a local
  justfile with a syntax error still wins and reports the parse error instead of
  silently falling through to the global one.

## coms (local P2P)

Every pi instance running coms gets an identity from `--cname` / `--project` and registers in `~/.pi/coms/projects/<project>/agents/<name>.json`.

```bash
pi -e extensions/coms.ts --cname dev --project myteam
pi -e extensions/coms.ts --cname prod --project myteam   # in another terminal, maybe another machine via shared fs
```

- **Tools**: `coms_list` (list peers), `coms_send` (send prompt to a peer, await its reply)
- **TUI**: `/coms` opens the pool view with live status; `@agent` for direct interaction; Ctrl+O expands message details
- Each agent keeps its own context window; messages carry sender, session id, hops, conversation id

## coms-net (network hub)

Same tools over HTTP/SSE: `coms_net_list`, `coms_net_send`, `coms_net_get`, `coms_net_await`.
This is the remote path only - agents on other machines or in sandboxes. If every
agent is on this machine, use `coms.ts` and skip the hub entirely.

There are no just recipes for the hub: it needs [Bun](https://bun.sh) (`brew install bun`),
which local pools do not, so it is started directly.

1. Start the hub:

```bash
# 127.0.0.1:52965
bun scripts/coms-net-server.ts

# other port
PI_COMS_NET_PORT=53000 bun scripts/coms-net-server.ts

# LAN-visible, token required
PI_COMS_NET_HOST=0.0.0.0 PI_COMS_NET_AUTH_TOKEN=<token> bun scripts/coms-net-server.ts
```

2. Point agents at it:

```bash
# on the hub machine: auto-discovers the local server.json
pi -e extensions/coms-net.ts --name mac-agent --cname mac-agent

# remote peer or sandbox
pi -e extensions/coms-net.ts --name e2b-agent --cname e2b-agent \
   --server-url http://<hub-host>:52965 --auth-token <token>
```

Env equivalents: `PI_COMS_NET_SERVER_URL`, `PI_COMS_NET_AUTH_TOKEN`, `PI_COMS_NET_PROJECT`.

Token policy (enforced by the server): loopback bind without token generates one into `~/.pi/coms-net/projects/<project>/server.secret.json` (0600); non-loopback bind without a token refuses to start. Hub state lives in `~/.pi/coms-net/`.

## just recipes

The justfile automates the video-style setups (IndyDevDan's `j` shortcuts). All
recipes are local-pool (`coms.ts`); the hub is started directly with `bun`, see
above.

```bash
brew install just

just install-global                              # global coms + `just -g` from anywhere
just local-coms --name dev --cname dev           # local unix-socket peer (current dir)
just role builder                                # role-file peer (current dir)
just role builder --team frontend                # ...joined to the `frontend` pool
just backoffice                                  # backoffice peer (pinned dir)
just team orchestrator builder scribe            # whole team tiled in one window, default pool
just team --windows orchestrator builder         # ...one window per role instead
just role-team frontend orchestrator builder scribe   # ...on a named pool
just teams                                       # list pools + who's in them
```

### Per-role models

A role file can name the model it runs on, so the expensive roles get the
expensive model and the rest don't. `model:` in the frontmatter becomes the
default `--model`, using pi's own `<provider>/<id>[:<thinking>]` syntax:

```markdown
---
name: scribe
description: doc writer/reader/summarizer, owns the team's written record
color: "#C792EA"
model: litellm/claude-sonnet-5
---
```

It is a **default**, not a pin: an explicit `--model` (or `--provider`) on the
command line suppresses it, and a role file without a `model:` key falls back to
your `defaultModel` setting exactly as before.

```bash
just role builder                                    # litellm/claude-opus-5 (from builder.md)
just role scribe                                     # litellm/claude-sonnet-5 (from scribe.md)
just role scribe --model litellm/claude-opus-5        # explicit wins
just team orchestrator builder scribe                 # each window on its own model
```

The shipped defaults:

| Role | Model | Why |
|---|---|---|
| `orchestrator` | `claude-opus-5:xhigh` | owns the map and the decisions; long-horizon, errors compound |
| `builder` | `claude-opus-5` | writes the code; wrong answers are expensive to unpick |
| `researcher` | `gpt-5.4-2026-03-05` | a second vendor, so its blind spots differ from the rest of the team's |
| `scribe` | `claude-sonnet-5` | reads and restates; cheaper, 1M context |
| `secops-dev` | `claude-sonnet-5` | same |
| `backoffice` | `claude-sonnet-5` | same |

Effort is left implicit except on the orchestrator: it already defaults to `high`
on Opus 5 and Sonnet 5, and `xhigh` is the documented step-up for the most
demanding agentic work. Edit the role files to suit your own catalogue —
`pi --list-models` shows what you can name, and a model does **not** have to be in
your `enabledModels` setting (that only scopes Ctrl+P cycling, not `--model`).

Read at **launch** time by `just role` / `just backoffice` (via
`scripts/role-field`), so the session starts on the right model rather than
switching after the first turn, and the choice survives `coms_respawn`. A bare
`pi -e extensions/coms-net.ts` takes no role file, so hub peers stay
explicit-model.

### Teams (multiple independent pools)

A "team" is a coms **pool**: a shared discovery namespace at
`~/.pi/coms/projects/<team>/agents/`. Agents only see each other if they share a
pool, so you can run several independent teams at once. Every peer also keeps a
private pool named after itself, so direct addressing still works.

```bash
just role builder                       # default pool ("team")
just role builder --team frontend       # frontend pool
just role builder --team=frontend       # same, equals form
PI_COMS_TEAM=frontend just role builder # default for this shell
```

Precedence: `--team` > `PI_COMS_TEAM` > `team`. Any other flags pass straight
through to `pi`, so you can combine them:

```bash
just role builder --team frontend --model openrouter/x-ai/grok-5
```

The same role name can run in two teams simultaneously (`builder` in `frontend`
and `builder` in `backend`) — pools are isolated. Within *one* pool a duplicate
name gets suffixed (`builder2`).

Launch a whole team into a tmux session (`coms-<pool>`). By default all roles
share **one window**, tiled `main-vertical`: the first role named gets the big
left pane, the rest stack in a right-hand column. `just team` uses the default
pool, `just role-team` takes the pool name, so you can run several teams side by
side:

```bash
just team orchestrator builder scribe researcher   # pool "team" (or $PI_COMS_TEAM)
just role-team frontend orchestrator builder scribe
just role-team ops backoffice secops-dev
just teams
#   team        orchestrator builder scribe researcher
#   frontend    orchestrator builder scribe
#   ops         backoffice secops-dev
```

Each pane's border carries its role name, since the window name can no longer
tell them apart. To focus one agent, `prefix-z` zooms the current pane to
fullscreen (`prefix-z` again to unzoom); `prefix-o` and `prefix-arrow` move
between them.

Pass `--windows` for one window per role instead (the pre-tiling behaviour). The
flag works anywhere in the argument list, before, among, or after the roles:

```bash
just team --windows orchestrator builder scribe
just role-team ops --windows backoffice secops-dev
just team orchestrator builder --windows            # same thing
```

`--tiled` is accepted explicitly too, so the intent can be written either way.
The main pane's share of the width is `60%`; override with
`PI_COMS_MAIN_PANE_WIDTH` (any tmux `main-pane-width` value, e.g. `55%` or a
column count).

Both are the same launcher (`scripts/coms-team`). It validates every role file
before creating anything, so a typo fails fast with nothing spawned; dispatches
`backoffice` to `just backoffice` so it still lands in `PI_BACKOFFICE_DIR`;
`switch-client`s instead of attaching when you are already inside tmux; and sets
`remain-on-exit failed` so a peer that dies on boot leaves its error on screen
instead of vanishing.

Roles live in `roles/<name>.md` (frontmatter sets name/description/color/model, body
sets the teammate map): `orchestrator`, `builder`, `researcher`, `secops-dev`,
`scribe`, `backoffice`. `just role <name>` launches any of them in your current
directory.
`just backoffice` is different — it **always** lands in the backoffice dir
(`PI_BACKOFFICE_DIR`, default `~/repos/backoffice`) no matter where you invoke it,
so it picks up that dir's local RAG extension and `AGENTS.md`. It takes `--team`
too:

```bash
just -g backoffice                                  # always ~/repos/backoffice
just -g backoffice --team ops                       # ...in the `ops` pool
PI_BACKOFFICE_DIR=/other/kb just -g backoffice      # point it elsewhere
```

Convention: one extension per agent. `coms.ts` for same-machine unix-socket pools, `coms-net.ts` for anything that goes through the hub (LAN or sandboxes). With a global `coms.ts` install, hub usage stays opt-in: pass `-e extensions/coms-net.ts` explicitly on that one session.

Reconstructed example prompts from the Pi to Pi video: see `PI-MULTI-AGENT.md`.

## Companion script

`scripts/agent-picker`: fzf tmux popup to see and jump between running coms agents. Bind in tmux:

```
bind a display-popup -E -w 82% -h 65% "agent-picker"
```

## Notes

- coms.ts requires `editor-host.ts` and `naming.ts` (bundled helpers, loaded as plain modules)
- Theme: coms/coms-net apply the bundled `ocean-breeze` theme
- Removed extensions (agent-team, agent-chain, pi-pi, damage-control, subagent-widget, orchestrator, etc.) are recoverable from git history, e.g. `git show 75a2a8d:extensions/subagent-widget.ts`
