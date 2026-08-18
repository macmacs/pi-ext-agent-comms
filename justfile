set dotenv-load := true

default:
    @just --list

# ---------------------- coms (local P2P, unix sockets) ----------------------

# Local peer on the same machine:
#   just local-coms --name dev --cname dev --color "#72F1B8"
local-coms *args:
    pi -e extensions/coms.ts {{args}}

# ---------------------- coms-net (HTTP/SSE hub) ------------------------------

# Hub on 127.0.0.1 (kills any stale process on the pinned port first)
hub:
    -lsof -ti :${PI_COMS_NET_PORT:-52965} | xargs -r kill -TERM 2>/dev/null
    PI_COMS_NET_PORT=${PI_COMS_NET_PORT:-52965} bun scripts/coms-net-server.ts

# Hub on LAN, 0.0.0.0 (requires PI_COMS_NET_AUTH_TOKEN)
hub-lan:
    -lsof -ti :${PI_COMS_NET_PORT:-52965} | xargs -r kill -TERM 2>/dev/null
    PI_COMS_NET_HOST=0.0.0.0 PI_COMS_NET_PORT=${PI_COMS_NET_PORT:-52965} bun scripts/coms-net-server.ts

# Networked peer. On the hub machine it auto-discovers the local server.json:
#   just coms --name dev --cname dev
# Remote peer or sandbox:
#   just coms --name prod --cname prod --server-url http://<host>:52965 --auth-token <tok>
coms *args:
    pi -e extensions/coms-net.ts {{args}}

# Peer pinned to a model:
#   just coms-model openrouter/anthropic/claude-sonnet-4-5 --name dev --cname dev
coms-model model *args:
    pi -e extensions/coms-net.ts --model {{model}} {{args}}

# ---------------------- tmux team --------------------------------------------

# Flat team in one tmux session: hub window + one window per peer.
#   just team dev prod review
team +names:
    #!/usr/bin/env bash
    set -euo pipefail
    tmux kill-session -t coms-team 2>/dev/null || true
    tmux new-session -d -s coms-team -n hub "PI_COMS_NET_PORT=${PI_COMS_NET_PORT:-52965} bun scripts/coms-net-server.ts"
    for n in {{names}}; do
        tmux new-window -t coms-team -n "$n" "just coms --name $n --cname $n"
    done
    tmux attach -t coms-team
