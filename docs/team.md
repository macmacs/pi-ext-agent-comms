# team

Roles, recipes, pools and tmux. The extension itself is documented in
[coms.md](coms.md).

## Role files

A role lives in `<name>.md`. Frontmatter sets
name/description/color/model/tools; the body sets that role's own job. Shipped
roles: `orchestrator`, `builder`, `researcher`, `secops-dev`, `scribe`,
`backoffice`. `just role <name>` launches any of them in your current directory.

```markdown
---
name: scribe
description: doc writer/reader/summarizer, owns the team's written record
color: "#C792EA"
model: litellm/claude-sonnet-5
---
```

`roles/_common.md` is not a role. It holds what every agent shares: the register
(how to write), the one-line team roster, and the hard rules - secrets never
travel, backoffice data stays local, how to report and how to hand off. It is
**not** passed on the command line: `coms.ts` finds it next to the role file,
else in the shipped `roles/`, and it is injected even when no role file was
passed at all, because those rules belong to the team and not to one role. The
hard rules land at the **end** of the prompt block on purpose: what the model
reads last is what it obeys. It has no frontmatter, and any `_`-prefixed file is
rejected as a role name by `just role` and by `scripts/coms-team`.

### Local roles

Role files are looked up in three folders. The first match wins, and it
replaces the others completely (no field-by-field merge):

| Order | Folder | Use it for |
|---|---|---|
| 1 | `<launch dir>/.pi/coms/roles/` | roles that belong to one project; check them in |
| 2 | `${XDG_CONFIG_HOME:-$HOME/.config}/just/coms-roles/` | your own roles on this machine; move it with `PI_COMS_ROLES_DIR` |
| 3 | `<package>/roles/` | the shipped roles |

`<launch dir>` is where you run `just role`, the same dir where pi finds
`.pi/`. For `just backoffice` it is `PI_BACKOFFICE_DIR`.

To change a shipped role, copy it and edit the copy:

```bash
mkdir -p ~/.config/just/coms-roles
cp "$(just -g --evaluate repo)/roles/builder.md" ~/.config/just/coms-roles/
```

`_common.md` works the same way: put one next to your local roles to change the
team rules for those roles. Without one, they use the shipped `_common.md`. A
peer launched **without** a role file has no sibling folder to look in, so it
always uses the shipped one (or `PI_COMS_REPO/roles`).

Role names may only use letters, digits and `-`. `_` is refused, because the
model key for `a_b` would be the same as for `a-b` (see below).
`scripts/role-resolve` is the one place that does the lookup;
`just role`, `just backoffice`, `just team` and `/coms-models` all call it.

The role text goes in through coms' own `--role` flag. For why that matters, see
[coms.md](coms.md).

## Recipes

The short version is in the [README](../README.md). All of them:

| Recipe | What it does |
|---|---|
| `just default` | prints `just --list` |
| `just local-coms *args` | plain local peer in the current dir; args go straight to pi, e.g. `just local-coms --name dev --cname dev` |
| `just role <name> *args` | role-file peer in the current dir. `--team` picks the pool; model and tool flags come from the frontmatter; anything else goes to pi |
| `just backoffice *args` | backoffice peer, always pinned to `PI_BACKOFFICE_DIR` (`~/repos/backoffice` by default), so it picks up that dir's local RAG extension and `AGENTS.md` |
| `just team +roles` | whole team tiled in one tmux window, default pool |
| `just role-team <pool> +roles` | same, on a named pool |
| `just teams` | list pools and who is registered in each |
| `just respawn-demo *args` | scripted respawn smoke test (see [coms.md](coms.md)) |
| `just typecheck` | tsc over the extensions; needs `npm install` once in the package |
| `just lean *args` | pi in the current dir with the rarely-used tools excluded |

`just team` and `just role-team` are the same launcher
(`scripts/coms-team`). It validates every role file before creating anything, so
a typo fails fast with nothing spawned; dispatches `backoffice` to
`just backoffice` so it still lands in `PI_BACKOFFICE_DIR`; uses
`switch-client` instead of `attach` when you are already inside tmux; and sets
`remain-on-exit failed` so a peer that dies on boot leaves its error on screen
instead of vanishing.

Run recipes from any directory with `just -g <recipe>`. That needs the global
justfile shim, which `/coms-setup` writes. The recipes are
location-independent: `repo` resolves with `source_directory()` (the package the
justfile lives in), while peers launch in **your current directory**
(`invocation_directory()`), so they inherit that project's `.pi/` extensions,
`AGENTS.md` and RAG index.

```bash
cd ~/repos/some-project
just -g role builder
just role builder --team frontend --model openrouter/x-ai/grok-5
```

Override `repo` with `PI_COMS_REPO` if you have another clone.

Recipe settings can also live in a file next to the global shim,
`${XDG_CONFIG_HOME:-$HOME/.config}/just/coms.env`. `/coms-setup` seeds it with
commented examples. See what a recipe will use:

```bash
"$(just -g --evaluate repo)"/scripts/coms-setting PI_COMS_TEAM
```

## Teams (multiple independent pools)

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

Precedence: `--team` > environment (`PI_COMS_TEAM`, or a project `.env` just
loaded) > the `coms.env` settings file > `team`.

The same role name can run in two teams simultaneously (`builder` in `frontend`
and `builder` in `backend`); pools are isolated. Within *one* pool a duplicate
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

`--tiled` is accepted explicitly too. The main pane's share of the width is
`60%`; override with `PI_COMS_MAIN_PANE_WIDTH` (any tmux `main-pane-width`
value, e.g. `55%` or a column count).

Two tmux behaviours the tiled path works around:

- A detached `new-session` is created at `default-size` 80x24, and tmux then
  scales the layout proportionally on attach, so `main-pane-width 60%` silently
  becomes 53%. The session is created at the real terminal size to avoid it.
- Pi sets its own pane title via an OSC escape, so each pane gets
  `allow-set-title off` before the role title is applied.

When the terminal size cannot be read (no controlling tty, e.g. launched from a
daemon) the session really is built at 80x24, so a one-shot `client-resized` hook
re-runs `select-layout` once a client attaches. Measured on tmux 3.7b,
240-column client, three panes: no hook 127 cols, `client-attached` 127 (it fires
before the client size reaches the window, so the re-layout resolves against the
old 80 cols and is scaled anyway - i.e. it achieves nothing), `client-resized`
143, the intended 60%. The hook unsets itself after firing: leaving it armed
would also re-assert `main-vertical` on every later resize and discard any manual
pane adjustment (drag the divider to 90, resize the terminal, back to 143), and
self-removing makes this fallback converge on the normal path, which sets no hook
at all.

## Per-role models

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

### Per-machine overrides

Different machines can see different model catalogues. Override a role's model
on one machine without touching the role file, with `PI_COMS_MODEL_<ROLE>`:
the role name in upper case, `-` as `_`.

```bash
# ~/.config/just/coms.env
PI_COMS_MODEL_BUILDER=openrouter/x-ai/grok-5
PI_COMS_MODEL_SECOPS_DEV=litellm/claude-sonnet-4-6
```

Or from inside pi:

```
/coms-models                                  # every role, its model, and where it came from
/coms-models set builder openrouter/x-ai/grok-5
/coms-models unset builder
```

`set` warns (and still writes) when pi does not know the model, since it may
exist on another machine or behind a proxy. It creates `coms.env` from the
template if it is missing, and writes through a symlinked `coms.env`. The change
applies from the next launch; the running session keeps its model.

What wins, highest first:

1. `--model` / `--provider` on the command line
2. `PI_COMS_MODEL_<ROLE>` in the environment (or a project `.env` just loaded)
3. `PI_COMS_MODEL_<ROLE>` in `coms.env`
4. `model:` in the role file
5. pi's `defaultModel`

```bash
just role builder                                    # litellm/claude-opus-5 (from builder.md)
just role scribe                                     # litellm/claude-sonnet-5 (from scribe.md)
just role scribe --model litellm/claude-opus-5        # explicit wins
just team orchestrator builder scribe                 # each window on its own model
```

The shipped defaults:

| Role | Model | Why |
|---|---|---|
| `orchestrator` | `litellm/claude-opus-5:xhigh` | owns the map and the decisions; long-horizon, errors compound |
| `builder` | `litellm/claude-opus-5` | writes the code; wrong answers are expensive to unpick |
| `researcher` | `litellm/gpt-5.4-2026-03-05` | a second vendor, so its blind spots differ from the rest of the team's |
| `scribe` | `litellm/claude-sonnet-5` | reads and restates; cheaper, 1M context |
| `secops-dev` | `litellm/claude-sonnet-5` | same |
| `backoffice` | `litellm/claude-sonnet-5` | same |

Effort is left implicit except on the orchestrator: it already defaults to `high`
on Opus 5 and Sonnet 5, and `xhigh` is the documented step-up for the most
demanding agentic work. Edit the role files to suit your own catalogue -
`pi --list-models` shows what you can name, and a model does **not** have to be in
your `enabledModels` setting (that only scopes Ctrl+P cycling, not `--model`).

Read at **launch** time by `just role` / `just backoffice` (via
`scripts/role-resolve`), so the session starts on the right model rather than
switching after the first turn, and the choice survives `coms_respawn`. A bare
`pi -e extensions/coms.ts` takes no role file, so peers launched that way stay on
your default model.

### Picking the models

How the shipped assignment was chosen, so it can be re-derived when the catalogue
moves. Vendor benchmarks were treated as directional only; the disqualifications
below came from probing the local proxy.

Probe results (August 2026 catalogue):

- **Tool-use screen** - "read this file and echo it back". `qwen3-235b` and
  `amazon.nova-2-lite` returned HTTP 400 from Bedrock; `qwen3-coder-30b` emitted
  raw `</tool_call>` markup instead of calling the tool; `nova-pro` leaked code
  fences. All four are unusable as agent roles regardless of their scores.
- **Reasoning probe** - find the even-length bug in a `median()` that returns
  `s[len(s)//2]`. Every Claude and GPT-5.4 model found a genuine even-length
  case; `claude-haiku-4-5` answered `[1,2,3]`, which does *not* expose the bug.
  That is why no role runs on Haiku.
- **Multi-file probe** - spot a shared-mutable-cache aliasing bug spanning two
  files. Opus 5, Sonnet 5, and Sonnet 4.6 all identified it correctly.
- **Summary fidelity** - given retro notes mixing one approved and one open
  decision, correctly separate them. All candidates passed.
- **Secret handling** - asked to "quote every file's full contents" in a dir
  containing a live-looking API key. None leaked it verbatim; Opus 5 redacted and
  said why.

Pricing, derived from Anthropic's batch table (batch is 50% off list): Opus 5
$5/$25, Sonnet 5 $2/$10, Sonnet 4.6 $3/$15, Haiku 4.5 $1/$5 per MTok. Note that
Sonnet 5 is both **newer and cheaper** than Sonnet 4.6, though its new tokenizer
counts roughly 30% more tokens for the same text, so the effective saving is
nearer par than the sticker suggests.

## Per-role tool budgets (`tools:`)

Tool schemas, not prose, are what make an agent's prompt big. A full install
here is 38 tools = 66,485 chars of JSON schema, plus ~13,300 chars of matching
guideline text that pi writes into the system prompt for those same tools. That
is ~22,400 tokens shipped on every turn before the agent reads your prompt.

So each role declares what it actually needs. `just role` reads the frontmatter
and turns it into pi's `--tools` allowlist on top of the shared `tools_core` set
in the justfile:

| key in frontmatter | what `just role` passes |
|---|---|
| *(absent)* | nothing - every installed tool loads (back-compat) |
| `tools: none` | `--tools <tools_core>` |
| `tools: jira,confluence` | `--tools <tools_core>,jira,confluence` |
| `exclude_tools: a,b` | `--exclude-tools a,b` (wins over `tools:`) |

No spaces in those lists. Your own `-t` / `--tools` / `-xt` /
`--exclude-tools` on the command line wins outright and suppresses all of this.

Measured, same machine, same 38-tool install:

| role | payload | tokens | vs 89,605 |
|---|---|---|---|
| `secops-dev` | 30,907 | ~7,700 | **-66%** |
| `builder` | 38,917 | ~9,700 | **-58%** |
| `scribe` | 45,069 | ~11,300 | -50% |
| `orchestrator` | 45,154 | ~11,300 | -50% |
| `researcher` | 55,485 | ~13,900 | -38% |

Why each role gets what it gets:

- **builder** adds `ctx_execute`, `ctx_execute_file` - it is the role that chews
  through build logs, and those keep the bytes out of its context.
- **researcher** owns the whole `aio-*` web stack. Nobody else carries 16k chars
  of web schema; they ask researcher instead. This is why `builder.md` says "ask
  researcher before you guess at an API" - the role file and the tool budget say
  the same thing.
- **orchestrator** and **scribe** get `jira` + `confluence`. Note those two cost
  ~6,600 chars of *system prompt guidelines* on top of their 7,665 chars of
  schema, which is why they are the two heaviest non-researcher roles.
- **secops-dev** gets `tools: none` - core set only. This is a containment
  boundary first and a token saving second: no web, no tickets, no wiki, no
  remote indexer can ship a secret off the machine.
- **backoffice** must name `rag_index,rag_query,rag_status` because `--tools` is
  a strict allowlist over **all** tools, project extensions included. A role
  launched in a project whose `.pi/` adds tools has to name them, or use
  `exclude_tools:` instead.

## `just lean` - the same trick for your own session

Role peers get an allowlist because their job is fixed. Your own interactive
session lands in arbitrary projects, so `just lean` uses a **deny**list instead -
`-xt` only removes what is named, so tools a project's `.pi/` registers still
show up:

```bash
just lean                                  # or: just -g lean
just lean --model litellm/claude-sonnet-4-6
PI_LEAN_EXCLUDE="mcp,mcpScript" just lean  # tune without editing the justfile
```

Dropped by default: context-mode's five diagnostics (run those from the CLI when
something is actually broken), the six `aio-*` tools that only matter for
whole-site crawls, and the `mcp` gateway pair. Kept: `ctx_batch_execute`,
`ctx_execute`, `ctx_execute_file`, `ctx_search`, `ctx_index`,
`ctx_fetch_and_index`, `aio-websearch`, `aio-webfetch`, `jira`, `confluence`,
`coms_*`, built-ins.

Measured -23% (8 tools, 13,827 chars). That figure is a floor: it was taken in
`pi -p` print mode, which does not register context-mode's tools at all, so the
five `ctx_*` diagnostics were not there to remove. In a real interactive session
the saving is ~3,900 chars larger.

> **Measuring this yourself:** hook `before_provider_request` and read
> `event.payload`. The system prompt is `payload.system` (Anthropic) or the
> `system`/`developer` entries of `payload.input` (OpenAI Responses API), and
> per-tool cost is `JSON.stringify(tool).length` over `payload.tools`. Print mode
> is convenient but under-reports: `ask_user_question` and all `ctx_*` tools are
> missing from it.

## Optional: zsh setup

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

- A plain `alias j='just -g'` would ignore a project's own justfile - you'd `cd`
  into a repo, run `j test`, and silently get global recipes. Hence the walk.
- The walk checks for the file rather than asking `just` to parse it, so a local
  justfile with a syntax error still wins and reports the parse error instead of
  silently falling through to the global one.

## Companion script

`scripts/agent-picker`: fzf tmux popup to see and jump between running coms
agents. Bind in tmux:

```
bind a display-popup -E -w 82% -h 65% "agent-picker"
```
