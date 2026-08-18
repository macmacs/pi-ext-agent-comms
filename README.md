# pi-ext-agent-comms

Peer-to-peer agent communication for the Pi coding agent. Two extensions:

- **coms** (`extensions/coms.ts`): local agent-to-agent messaging over unix sockets. Flat peer team, no orchestrator. Any agent can ping, prompt, and await responses from any other agent in the pool.
- **coms-net** (`extensions/coms-net.ts`): the same protocol over a network hub (Bun HTTP/SSE server), for agents on other machines or sandboxes (E2B, exe.dev, etc.).

Slimmed down to just these two extensions from three upstream repos:

- [disler/pi-vs-claude-code](https://github.com/disler/pi-vs-claude-code): the original `coms` work (IndyDevDan's "Pi to Pi")
- [terakael/pi-vs-claude-code](https://github.com/terakael/pi-vs-claude-code): TUI/race fixes
- [TheMule71/pi-vs-claude-code](https://github.com/TheMule71/pi-vs-claude-code): base fork this repo was forked from

## Install

```bash
pi install /Users/macmacs/pi-agen-main/pi-ext-agent-comms
```

Or load for one session only:

```bash
pi -e extensions/coms.ts        # local P2P
pi -e extensions/coms-net.ts   # network hub client
```

No runtime dependencies beyond pi's bundled packages. `just` recipes included (`just --list`).

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

1. Start the hub:

```bash
just hub          # 127.0.0.1:52965 (override with PI_COMS_NET_PORT)
just hub-lan      # 0.0.0.0, requires PI_COMS_NET_AUTH_TOKEN
```

2. Point agents at it:

```bash
just coms --name mac-agent --cname mac-agent
# remote peer or sandbox:
just coms --name e2b-agent --cname e2b-agent \
     --server-url http://<hub-host>:52965 --auth-token <token>
```

Env equivalents: `PI_COMS_NET_SERVER_URL`, `PI_COMS_NET_AUTH_TOKEN`, `PI_COMS_NET_PROJECT`.

Token policy (enforced by the server): loopback bind without token generates one into `~/.pi/coms-net/projects/<project>/server.secret.json` (0600); non-loopback bind without a token refuses to start. Hub state lives in `~/.pi/coms-net/`.

## just recipes

The justfile automates the video-style setups (IndyDevDan's `j` shortcuts):

```bash
brew install just

just local-coms --name dev --cname dev           # local unix-socket peer
just hub                                         # hub + agents on one machine
just coms --name dev --cname dev                 # networked peer (auto-discovers local hub)
just coms-model openrouter/x-ai/grok-5 --name r1 --cname r1
just team dev prod review                        # hub + 3 peers in one tmux session
```

Convention: one extension per agent. `coms.ts` for same-machine unix-socket pools, `coms-net.ts` for anything that goes through the hub (same machine, LAN, or sandboxes).

## Companion script

`scripts/agent-picker`: fzf tmux popup to see and jump between running coms agents. Bind in tmux:

```
bind a display-popup -E -w 82% -h 65% "agent-picker"
```

## Notes

- coms.ts requires `editor-host.ts` and `naming.ts` (bundled helpers, loaded as plain modules)
- Theme: coms/coms-net apply the bundled `ocean-breeze` theme
- Removed extensions (agent-team, agent-chain, pi-pi, damage-control, subagent-widget, orchestrator, etc.) are recoverable from git history, e.g. `git show 75a2a8d:extensions/subagent-widget.ts`
