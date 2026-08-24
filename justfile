set dotenv-load := true

# Repo root (where roles/ and scripts/ live). Resolved dynamically, no username
# baked in: justfile_directory() is correct when you run in/under the repo, but
# resolves to ~/.config/just via the global symlink (`just -g`) — so that case
# falls back to a $HOME-relative path. Override with PI_COMS_REPO for any other
# clone location.
repo := env_var_or_default("PI_COMS_REPO", if path_exists(justfile_directory() / "roles") == "true" { justfile_directory() } else { home_directory() / "repos/local/pi-ext-agent-comms" })
# The directory you actually ran `just` in — peers launch here so they inherit
# that project's .pi/ extensions, AGENTS.md, RAG index, etc.
here := invocation_directory()
# Where the backoffice knowledge base lives (its own .pi/ RAG extension +
# AGENTS.md). $HOME-relative; override with PI_BACKOFFICE_DIR if you move it.
backoffice_dir := env_var_or_default("PI_BACKOFFICE_DIR", home_directory() / "repos/backoffice")

default:
    @just --list

# ---------------------- setup ------------------------------------------------

# Install coms globally (auto-loads in every session) + wire `just -g` from anywhere.
# Filters the package to coms.ts only: coms-net.ts errors on boot without a hub,
# so it stays opt-in via `just coms` / `just hub`.
#   just install-global
install-global:
    #!/usr/bin/env bash
    set -euo pipefail
    pi install "{{repo}}"
    echo "→ installed {{repo}} to ~/.pi/agent/settings.json"
    echo "  If every session shows a coms-net 'no server URL' error, filter the"
    echo "  package to coms.ts only in ~/.pi/agent/settings.json:"
    echo '    { "source": "'"{{repo}}"'", "extensions": ["extensions/coms.ts"] }'
    mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/just"
    ln -sf "{{repo}}/justfile" "${XDG_CONFIG_HOME:-$HOME/.config}/just/justfile"
    echo "→ symlinked justfile to global location; now 'just -g <recipe>' works from any dir"

# ---------------------- coms (local P2P, unix sockets) ----------------------
# These assume coms is installed globally (see install-global). If it is not,
# add `-e {{repo}}/extensions/coms.ts` to the pi invocation.

# Local peer in the CURRENT directory:
#   just local-coms --name dev --cname dev --color "#72F1B8"
local-coms *args:
    cd "{{here}}" && pi {{args}}

# Role-file peer (identity from roles/<name>.md; replays across respawn).
# Launches in the CURRENT directory, so it inherits that project's .pi/ setup:
#   just role orchestrator   # or: builder / researcher / secops-dev / scribe
role name:
    #!/usr/bin/env bash
    set -euo pipefail
    role_file="{{repo}}/roles/{{name}}.md"
    test -f "$role_file" || { echo "role file $role_file not found" >&2; exit 1; }
    cd "{{here}}"
    exec pi --cname {{name}} --append-system-prompt "$role_file" --project team

# Backoffice peer: pinned to the backoffice dir (its local RAG extension +
# AGENTS.md) with the backoffice role identity replayed across respawn.
# Always lands there regardless of where you invoke it from.
#   just backoffice
#   PI_BACKOFFICE_DIR=/other/path just backoffice
backoffice:
    #!/usr/bin/env bash
    set -euo pipefail
    role_file="{{repo}}/roles/backoffice.md"
    test -f "$role_file" || { echo "role file $role_file not found" >&2; exit 1; }
    test -d "{{backoffice_dir}}" || { echo "backoffice dir {{backoffice_dir}} not found (set PI_BACKOFFICE_DIR)" >&2; exit 1; }
    cd "{{backoffice_dir}}"
    exec pi --cname backoffice --append-system-prompt "$role_file" --project team

# ---------------------- coms-net (HTTP/SSE hub) ------------------------------

# Hub on 127.0.0.1 (kills any stale process on the pinned port first)
hub:
    -lsof -ti :${PI_COMS_NET_PORT:-52965} | xargs -r kill -TERM 2>/dev/null
    PI_COMS_NET_PORT=${PI_COMS_NET_PORT:-52965} bun "{{repo}}/scripts/coms-net-server.ts"

# Hub on LAN, 0.0.0.0 (requires PI_COMS_NET_AUTH_TOKEN)
hub-lan:
    -lsof -ti :${PI_COMS_NET_PORT:-52965} | xargs -r kill -TERM 2>/dev/null
    PI_COMS_NET_HOST=0.0.0.0 PI_COMS_NET_PORT=${PI_COMS_NET_PORT:-52965} bun "{{repo}}/scripts/coms-net-server.ts"

# Networked peer in the CURRENT directory. On the hub machine it auto-discovers
# the local server.json:
#   just coms --name dev --cname dev
# Remote peer or sandbox:
#   just coms --name prod --cname prod --server-url http://<host>:52965 --auth-token <tok>
coms *args:
    cd "{{here}}" && pi -e "{{repo}}/extensions/coms-net.ts" {{args}}

# Peer pinned to a model:
#   just coms-model openrouter/anthropic/claude-sonnet-4-5 --name dev --cname dev
coms-model model *args:
    cd "{{here}}" && pi -e "{{repo}}/extensions/coms-net.ts" --model {{model}} {{args}}

# ---------------------- respawn demo -------------------------------------------

# Scripted respawn smoke test between two role-file peers (orchestrator + researcher).
#   just respawn-demo                          # print the scripted steps
#   just respawn-demo sid researcher           # current registered session id (snapshot before)
#   just respawn-demo verify researcher "respawned for the smoke test"
respawn-demo *args="":
    "{{repo}}/scripts/respawn-demo.sh" {{args}}

# ---------------------- tmux team --------------------------------------------

# Flat team in one tmux session: hub window + one window per peer.
#   just team dev prod review
team +names:
    #!/usr/bin/env bash
    set -euo pipefail
    tmux kill-session -t coms-team 2>/dev/null || true
    tmux new-session -d -s coms-team -n hub "PI_COMS_NET_PORT=${PI_COMS_NET_PORT:-52965} bun '{{repo}}/scripts/coms-net-server.ts'"
    for n in {{names}}; do
        tmux new-window -t coms-team -n "$n" "just -f '{{repo}}/justfile' coms --name $n --cname $n"
    done
    tmux attach -t coms-team
