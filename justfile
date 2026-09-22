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

# Tools every role gets, no matter what. Everything else is opt-in per role via
# a `tools:` key in the role frontmatter (see the `role` recipe).
#
# Why an allowlist at all: tool schemas are ~72% of what ships to the model on
# every turn. A full install here is 38 tools = 66,485 chars of schema plus
# ~13,300 chars of matching guideline text inside the system prompt, so a peer
# pays ~23,000 tokens before it reads a word of your prompt. Excluding a tool
# drops BOTH its schema and its guidelines. Measured: a builder on this core set
# plus two extras costs ~9,700 tokens instead of ~23,000.
#
# Keep this list boring: file edits, shell, task tracking, asking the human, and
# talking to peers. A role that needs web, tickets or a sandbox says so itself.
tools_core := "read,bash,edit,write,todo,ask_user_question,coms_send,coms_list,coms_respawn,coms_cold_respawn,coms_request_respawn,ctx_search"

# Denylist for `just lean` (your own session, not a role peer). Override with
# PI_LEAN_EXCLUDE to tune it without editing this file. See the `lean` recipe for
# what is deliberately KEPT.
lean_exclude := env_var_or_default("PI_LEAN_EXCLUDE", "ctx_purge,ctx_doctor,ctx_stats,ctx_upgrade,ctx_insight,aio-webpull,aio-webquery,aio-webmap,aio-webresearch,aio-webresult,aio-webcontent,mcp,mcpScript")

default:
    @just --list

# ---------------------- setup ------------------------------------------------

# Install is two manual steps, because the first one cannot be a recipe:
#   1. pi install git:github.com/macmacs/pi-ext-agent-comms
#   2. restart pi, then run /coms-setup to wire `just -g`
# Old `just install-global` recipe deleted with the coms-net restructure.
# Typecheck the extensions with the repo's own pinned tsc (5.9.3). Deliberately
# does NOT run npm install for you: a recipe that mutates node_modules behind
# your back is a surprise, and the install is a one-time step.
# Covers coms.ts, editor-host.ts and naming.ts; see tsconfig.typecheck.json.
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
# These assume coms is installed globally (run `/coms-setup`). If it is not,
# add `-e {{repo}}/extensions/coms.ts` to the pi invocation.

# Local peer in the CURRENT directory:
#   just local-coms --name dev --cname dev --color "#72F1B8"
[doc("Plain local peer in the current dir (args go straight to pi)")]
local-coms *args:
    cd "{{here}}" && pi {{args}}

# Your own session, minus the tools you almost never call by hand.
#
# Unlike a role peer this is a DENYlist, not an allowlist: your interactive
# session lands in arbitrary projects, and an allowlist would silently swallow
# whatever tools that project's .pi/ registers. `-xt` only removes what is named
# here, so anything new still shows up.
#
# Kept on purpose, because these are the ones worth reaching for:
#   ctx_batch_execute, ctx_execute, ctx_execute_file, ctx_search  (think-in-code)
#   ctx_index, ctx_fetch_and_index                                (build the KB)
#   aio-websearch, aio-webfetch                                   (search, read)
#   jira, confluence, coms_*, and the built-ins
#
# Dropped: context-mode's diagnostics (you run those from the CLI when something
# is actually broken), the six webaio tools that only matter for whole-site
# crawls, and the MCP gateway pair.
#
#   just lean                     # or: just -g lean
#   just lean --model litellm/claude-sonnet-4-6
#   PI_LEAN_EXCLUDE="mcp,mcpScript" just lean      # tune it without editing here
[doc("pi in the current dir with the rarely-used tools excluded")]
lean *args:
    @cd "{{here}}" && exec pi --exclude-tools "{{lean_exclude}}" {{args}}

# Role-file peer (identity from roles/<name>.md; replays across respawn).
# Launches in the CURRENT directory, so it inherits that project's .pi/ setup.
# Joins the default pool unless you pass --team; any other args go through to pi.
# A `model:` key in the role file's frontmatter becomes the default --model
# (pi's `<provider>/<id>[:<thinking>]` syntax); an explicit --model still wins.
# The role file goes in via coms' own --role, NOT --append-system-prompt: coms
# reads identity from the frontmatter and injects the body plus the sibling
# roles/_common.md as ONE block at the very END of the system prompt, after
# pi's AGENTS.md context files and skill list, so the style rule wins on
# recency instead of being buried mid-prompt.
#
# Tool budget comes from the frontmatter too, and is opt-in per role:
#   (no key)                  -> no tool flags at all, every installed tool loads
#   tools: none               -> `--tools {{tools_core}}`
#   tools: jira,confluence    -> `--tools {{tools_core}},jira,confluence`
#   exclude_tools: a,b        -> `--exclude-tools a,b` (wins over `tools:`)
# Use no spaces in those lists. `--tools` is a STRICT allowlist over ALL tools,
# so a role launched in a project whose .pi/ adds its own tools must name them
# (that is why roles/backoffice.md lists rag_*), or use `exclude_tools:` instead.
# Your own -t / --tools / -xt / --exclude-tools on the command line wins outright.
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
    # $common_file is not passed on the command line: coms finds it as a sibling
    # of $role_file. It is checked here so a missing shared file fails loudly at
    # launch instead of silently dropping the team rules from the prompt.
    team="{{team_default}}"
    rest=()
    has_model=0
    has_tools=0
    while [ $# -gt 0 ]; do
      case "$1" in
        --team)   shift; [ $# -gt 0 ] || { echo "--team needs a value" >&2; exit 1; }; team="$1" ;;
        --team=*) team="${1#--team=}" ;;
        --model|--model=*|--provider|--provider=*)
                  has_model=1; rest+=("$1") ;;
        -t|--tools|-t=*|--tools=*|-xt|--exclude-tools|-xt=*|--exclude-tools=*)
                  has_tools=1; rest+=("$1") ;;
        *)        rest+=("$1") ;;
      esac
      shift
    done
    test -n "$team" || { echo "--team value must not be empty" >&2; exit 1; }
    model=""
    if [ "$has_model" = 0 ]; then
      model="$("{{repo}}/scripts/role-field" "$role_file" model)"
    fi
    tools=()
    if [ "$has_tools" = 0 ]; then
      xt="$("{{repo}}/scripts/role-field" "$role_file" exclude_tools)"
      allow="$("{{repo}}/scripts/role-field" "$role_file" tools)"
      if [ -n "$xt" ]; then
        tools=(--exclude-tools "$xt")
      elif [ "$allow" = none ]; then
        tools=(--tools "{{tools_core}}")
      elif [ -n "$allow" ]; then
        tools=(--tools "{{tools_core}},$allow")
      fi
    fi
    cd "{{here}}"
    exec pi --cname {{name}} --role "$role_file" \
            --project "$team" ${model:+--model "$model"} \
            ${tools[@]+"${tools[@]}"} ${rest[@]+"${rest[@]}"}

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
    has_tools=0
    while [ $# -gt 0 ]; do
      case "$1" in
        --team)   shift; [ $# -gt 0 ] || { echo "--team needs a value" >&2; exit 1; }; team="$1" ;;
        --team=*) team="${1#--team=}" ;;
        --model|--model=*|--provider|--provider=*)
                  has_model=1; rest+=("$1") ;;
        -t|--tools|-t=*|--tools=*|-xt|--exclude-tools|-xt=*|--exclude-tools=*)
                  has_tools=1; rest+=("$1") ;;
        *)        rest+=("$1") ;;
      esac
      shift
    done
    test -n "$team" || { echo "--team value must not be empty" >&2; exit 1; }
    model=""
    if [ "$has_model" = 0 ]; then
      model="$("{{repo}}/scripts/role-field" "$role_file" model)"
    fi
    tools=()
    if [ "$has_tools" = 0 ]; then
      xt="$("{{repo}}/scripts/role-field" "$role_file" exclude_tools)"
      allow="$("{{repo}}/scripts/role-field" "$role_file" tools)"
      if [ -n "$xt" ]; then
        tools=(--exclude-tools "$xt")
      elif [ "$allow" = none ]; then
        tools=(--tools "{{tools_core}}")
      elif [ -n "$allow" ]; then
        tools=(--tools "{{tools_core}},$allow")
      fi
    fi
    cd "{{backoffice_dir}}"
    exec pi --cname backoffice --role "$role_file" \
            --project "$team" ${model:+--model "$model"} \
            ${tools[@]+"${tools[@]}"} ${rest[@]+"${rest[@]}"}

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
