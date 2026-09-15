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
# so it stays opt-in via an explicit `pi -e {{repo}}/extensions/coms-net.ts`.
#   just install-global
[doc("Install coms globally + symlink the justfile for `just -g` from anywhere")]
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

# Typecheck the extensions with the repo's own pinned tsc (5.9.3). Deliberately
# does NOT run npm install for you: a recipe that mutates node_modules behind
# your back is a surprise, and the install is a one-time step.
# Covers coms.ts, editor-host.ts and naming.ts; coms-net.ts is excluded, see
# tsconfig.typecheck.json and the README.
#   npm install     # once
#   just typecheck
[doc("Typecheck the extensions with the repo's pinned tsc")]
typecheck:
    #!/usr/bin/env bash
    set -euo pipefail
    tsc="{{repo}}/node_modules/typescript/bin/tsc"
    if [ ! -f "$tsc" ]; then
      echo "typecheck: no local typescript found at $tsc" >&2
      echo "  run 'npm install' in {{repo}} first (installs the pinned tsc + pi type deps)" >&2
      exit 1
    fi
    cd "{{repo}}" && node "$tsc" -p tsconfig.typecheck.json
    echo "→ typecheck clean"

# ---------------------- coms (local P2P, unix sockets) ----------------------
# These assume coms is installed globally (see install-global). If it is not,
# add `-e {{repo}}/extensions/coms.ts` to the pi invocation.

# Local peer in the CURRENT directory:
#   just local-coms --name dev --cname dev --color "#72F1B8"
[doc("Plain local peer in the current dir (args go straight to pi)")]
local-coms *args:
    cd "{{here}}" && pi {{args}}

# Role-file peer (identity from roles/<name>.md; replays across respawn).
# Launches in the CURRENT directory, so it inherits that project's .pi/ setup.
# Joins the default pool unless you pass --team; any other args go through to pi.
# A `model:` key in the role file's frontmatter becomes the default --model
# (pi's `<provider>/<id>[:<thinking>]` syntax); an explicit --model still wins.
# roles/_common.md is appended second (shared style + roster + hard rules); the
# role file stays FIRST so coms.ts reads identity frontmatter from it.
#   just role orchestrator   # or: builder / researcher / secops-dev / scribe
#   just role builder --team frontend
#   just role builder --team frontend --model openrouter/x-ai/grok-5
[doc("Role-file peer from roles/<name>.md in the current dir")]
role name *args:
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{name}}" in _*) echo "'{{name}}' is a shared fragment, not a role" >&2; exit 1 ;; esac
    role_file="{{repo}}/roles/{{name}}.md"
    common_file="{{repo}}/roles/_common.md"
    test -f "$role_file" || { echo "role file $role_file not found" >&2; exit 1; }
    test -f "$common_file" || { echo "shared role file $common_file not found" >&2; exit 1; }
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
            --append-system-prompt "$common_file" \
            --project "$team" ${model:+--model "$model"} ${rest[@]+"${rest[@]}"}

# Backoffice peer: pinned to the backoffice dir (its local RAG extension +
# AGENTS.md) with the backoffice role identity replayed across respawn.
# Always lands there regardless of where you invoke it from.
#   just backoffice
#   just backoffice --team frontend
#   PI_BACKOFFICE_DIR=/other/path just backoffice
[doc("Backoffice peer, always pinned to PI_BACKOFFICE_DIR")]
backoffice *args:
    #!/usr/bin/env bash
    set -euo pipefail
    role_file="{{repo}}/roles/backoffice.md"
    common_file="{{repo}}/roles/_common.md"
    test -f "$role_file" || { echo "role file $role_file not found" >&2; exit 1; }
    test -f "$common_file" || { echo "shared role file $common_file not found" >&2; exit 1; }
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
            --append-system-prompt "$common_file" \
            --project "$team" ${model:+--model "$model"} ${rest[@]+"${rest[@]}"}

# List coms pools (teams) and who is registered in each.
#   just teams
[doc("List coms pools and who is registered in each")]
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

# ---------------------- respawn demo -------------------------------------------

# Scripted respawn smoke test between two role-file peers (orchestrator + researcher).
#   just respawn-demo                          # print the scripted steps
#   just respawn-demo sid researcher           # current registered session id (snapshot before)
#   just respawn-demo verify researcher "respawned for the smoke test"
[doc("Scripted respawn smoke test between two role peers")]
respawn-demo *args="":
    "{{repo}}/scripts/respawn-demo.sh" {{args}}

# ---------------------- tmux team --------------------------------------------
# Both recipes are the same launcher (scripts/coms-team): one window with one
# main-vertical pane per role (first role gets the big left pane), backoffice
# dispatched to its own pinned-dir recipe, all role files validated before
# anything is created. Pass --windows for one window per role instead. They
# differ only in which pool they join. Peers launch in your CURRENT directory,
# so `here` is passed explicitly (shebang/script pwd is the justfile dir, not
# yours).

# Whole team tiled in one tmux window on the DEFAULT pool ({{team_default}}).
# Session coms-{{team_default}}, one pane per role, per-role models from
# roles/<name>.md frontmatter. Pane borders carry the role names; prefix-z
# zooms one agent to fullscreen.
#   just team orchestrator builder scribe researcher
#   just team --windows orchestrator builder
[doc("Tile roles in one tmux window on the default pool (--windows for one window each)")]
team +roles:
    @"{{repo}}/scripts/coms-team" --repo "{{repo}}" --pool "{{team_default}}" --dir "{{here}}" {{roles}}

# Same, on an explicitly named pool - run several teams side by side.
# Session coms-<team_name>.
#   just role-team frontend orchestrator builder scribe
#   just role-team ops backoffice secops-dev
#   just role-team ops --windows backoffice secops-dev
[doc("Tile roles in one tmux window on a named pool (--windows for one window each)")]
role-team team_name +roles:
    @"{{repo}}/scripts/coms-team" --repo "{{repo}}" --pool "{{team_name}}" --dir "{{here}}" {{roles}}
