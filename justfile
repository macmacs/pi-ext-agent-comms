set dotenv-load := true
# Lets shebang recipes read their args as "$@" so we can parse flags like --team.
set positional-arguments

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
# Default coms pool every peer joins. This is the shared discovery pool: agents
# only see each other if they share it. Override per-run with `--team <name>` or
# globally with PI_COMS_TEAM to run several independent teams side by side.
team_default := env_var_or_default("PI_COMS_TEAM", "team")

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
# Launches in the CURRENT directory, so it inherits that project's .pi/ setup.
# Joins the default pool unless you pass --team; any other args go through to pi.
# A `model:` key in the role file's frontmatter becomes the default --model
# (pi's `<provider>/<id>[:<thinking>]` syntax); an explicit --model still wins:
#   just role orchestrator   # or: builder / researcher / secops-dev / scribe
#   just role builder --team frontend
#   just role builder --team frontend --model openrouter/x-ai/grok-5
role name *args:
    #!/usr/bin/env bash
    set -euo pipefail
    role_file="{{repo}}/roles/{{name}}.md"
    test -f "$role_file" || { echo "role file $role_file not found" >&2; exit 1; }
    shift                      # drop the role name; leaves only pass-through args
    team="{{team_default}}"
    rest=()
    has_model=0
    while [ $# -gt 0 ]; do
      case "$1" in
        --team)   shift; [ $# -gt 0 ] || { echo "--team needs a value" >&2; exit 1; }; team="$1" ;;
        --team=*) team="${1#--team=}" ;;
        --model|--model=*|--provider|--provider=*)
                  has_model=1; rest+=("$1") ;;
        *)        rest+=("$1") ;;
      esac
      shift
    done
    test -n "$team" || { echo "--team value must not be empty" >&2; exit 1; }
    model=""
    if [ "$has_model" = 0 ]; then
      model="$("{{repo}}/scripts/role-field" "$role_file" model)"
    fi
    cd "{{here}}"
    exec pi --cname {{name}} --append-system-prompt "$role_file" \
            --project "$team" ${model:+--model "$model"} ${rest[@]+"${rest[@]}"}

# Backoffice peer: pinned to the backoffice dir (its local RAG extension +
# AGENTS.md) with the backoffice role identity replayed across respawn.
# Always lands there regardless of where you invoke it from.
#   just backoffice
#   just backoffice --team frontend
#   PI_BACKOFFICE_DIR=/other/path just backoffice
backoffice *args:
    #!/usr/bin/env bash
    set -euo pipefail
    role_file="{{repo}}/roles/backoffice.md"
    test -f "$role_file" || { echo "role file $role_file not found" >&2; exit 1; }
    test -d "{{backoffice_dir}}" || { echo "backoffice dir {{backoffice_dir}} not found (set PI_BACKOFFICE_DIR)" >&2; exit 1; }
    team="{{team_default}}"
    rest=()
    has_model=0
    while [ $# -gt 0 ]; do
      case "$1" in
        --team)   shift; [ $# -gt 0 ] || { echo "--team needs a value" >&2; exit 1; }; team="$1" ;;
        --team=*) team="${1#--team=}" ;;
        --model|--model=*|--provider|--provider=*)
                  has_model=1; rest+=("$1") ;;
        *)        rest+=("$1") ;;
      esac
      shift
    done
    test -n "$team" || { echo "--team value must not be empty" >&2; exit 1; }
    model=""
    if [ "$has_model" = 0 ]; then
      model="$("{{repo}}/scripts/role-field" "$role_file" model)"
    fi
    cd "{{backoffice_dir}}"
    exec pi --cname backoffice --append-system-prompt "$role_file" \
            --project "$team" ${model:+--model "$model"} ${rest[@]+"${rest[@]}"}

# List coms pools (teams) and who is registered in each.
#   just teams
teams:
    #!/usr/bin/env bash
    set -euo pipefail
    root="${PI_COMS_DIR:-$HOME/.pi/coms}/projects"
    test -d "$root" || { echo "no pools yet ($root)"; exit 0; }
    found=0
    for d in "$root"/*/; do
      [ -d "$d/agents" ] || continue
      p="$(basename "$d")"
      names=""
      for f in "$d/agents"/*.json; do
        [ -e "$f" ] || continue
        names="$names $(basename "$f" .json)"
      done
      [ -n "$names" ] || continue
      found=1
      printf "%-22s%s\n" "$p" "$names"
    done
    [ "$found" = 1 ] || echo "no agents registered under $root"

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

# Flat coms-net team in one tmux session: hub window + one window per peer.
# (Hub-based; for local role peers sharing a pool see `role-team`.)
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

# Local role peers sharing one pool, one tmux window each (no hub needed).
# Session is named coms-<team>, so several teams can run side by side.
#   just role-team frontend orchestrator builder scribe
#   just role-team ops backoffice secops-dev
role-team team_name +roles:
    #!/usr/bin/env bash
    set -euo pipefail
    sess="coms-{{team_name}}"
    for r in {{roles}}; do
      test -f "{{repo}}/roles/$r.md" || { echo "role file {{repo}}/roles/$r.md not found" >&2; exit 1; }
    done
    tmux kill-session -t "$sess" 2>/dev/null || true
    first=1
    for r in {{roles}}; do
      if [ "$first" = 1 ]; then
        tmux new-session -d -s "$sess" -n "$r" \
          "just -f '{{repo}}/justfile' role $r --team {{team_name}}"
        first=0
      else
        tmux new-window -t "$sess" -n "$r" \
          "just -f '{{repo}}/justfile' role $r --team {{team_name}}"
      fi
    done
    tmux attach -t "$sess"
