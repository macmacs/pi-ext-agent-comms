# Ticket 02 findings: prove the shim justfile works with `just -g`

Status: resolved. Branch: `research/just-shim`.
Tested on this machine (Linux) with `just 1.58.0`, `XDG_CONFIG_HOME` unset.
Scratch root: `/tmp/shim-exp/final`. The user's real `~/.config/just/justfile` (a symlink to `/home/coder/repos/local/pi-ext-agent-comms/justfile`) was never written. It was checked at the start and at the end of the run: still the same symlink.

Reproduce with `research/just-shim-experiments.sh`. Its full output is committed as `research/just-shim-experiments-output.txt` and inlined at the bottom. Section numbers below refer to that output.

## Verdict

The approved shim design as written **does not work**. `export PI_COMS_REPO := "..."` in the shim does not set the environment variable that `env_var_or_default("PI_COMS_REPO", ...)` in the imported justfile reads. The imported `repo` then falls through to the hardcoded `~/repos/local/pi-ext-agent-comms` fallback, silently and with exit 0 (section 3).

The shim works with a **one-line change in the package justfile**: resolve the repo root with `source_directory()` instead of `justfile_directory()`. Then the shim is nothing but an import line plus ownership comments (sections 2b, 4, 6, 7).

## Answers to the ticket's questions

### Q1. Does `just -g <recipe>` load the shim, and does `export PI_COMS_REPO := "..."` reach the imported `repo`?

- The shim is loaded: yes. Every `-g` run below executed recipes that only exist in the imported package justfile (section 2b `--list`, section 6 `respawn-demo`, `teams`).
- The export does **not** reach `env_var_or_default`: no. Section 3:

```
$ cat /tmp/shim-exp/final/xdg3/just/justfile
export PI_COMS_REPO := "/tmp/shim-exp/final/pkg-sourcedir"
import "/tmp/shim-exp/final/pkg-as-is/justfile"

$ env XDG_CONFIG_HOME=/tmp/shim-exp/final/xdg3 just -g --evaluate
PI_COMS_REPO   := "/tmp/shim-exp/final/pkg-sourcedir"
...
repo           := "/home/coder/repos/local/pi-ext-agent-comms"
```

`PI_COMS_REPO` becomes a justfile variable (visible in `--evaluate`, and passed to recipes), but `repo` still used the hardcoded fallback. Why, from just 1.58.0's source:

- `env_var_or_default` -> `fn env()` reads `context.execution_context.dotenv`, then `std::env::var(key)` (`src/function.rs`). It never looks at justfile variables.
- `export`ed variables are only put into child process environments: `Environment::export` -> `Command::env` (`src/environment.rs`). There is no `set_var` anywhere in `src/`, so just never mutates its own environment.
- Therefore the export is visible to recipes and backticks but invisible to `env_var` / `env_var_or_default`.

The failure is silent on the user's machine because `~/repos/local/pi-ext-agent-comms` exists: exit 0, wrong repo, wrong scripts. That is the worst failure mode for the setup command, so the fix must not rely on the env var at all.

### Q2. `justfile_directory()` / `invocation_directory()` in an import, settings, shebang, `--list`

- `justfile_directory()` inside an imported file returns the **root** justfile's directory, not the imported file's directory (section 5):

```
$ cat /tmp/shim-exp/final/xdg5/just/justfile
import "/tmp/shim-exp/final/imp5/justfile"
$ cat /tmp/shim-exp/final/imp5/justfile
jfd := justfile_directory()
srcd := source_directory()

$ env XDG_CONFIG_HOME=/tmp/shim-exp/final/xdg5 just -g --evaluate
jfd  := "/tmp/shim-exp/final/xdg5/just"
srcd := "/tmp/shim-exp/final/imp5"
```

  With the shim in `~/.config/just`, `justfile_directory()` is `~/.config/just` even for code that lives in the package. Source: the function reads `execution_context.search.justfile.parent()` (`src/function.rs`), and `search.justfile` is the file the search found (the shim).

- `source_directory()` returns the directory of the file that contains the call, in both cases: imported (section 5) and used directly at the root (section 4: `just --justfile .../pkg-sourcedir/justfile --evaluate repo` -> `/tmp/shim-exp/final/pkg-sourcedir`).
- `invocation_directory()` is the directory you typed `just` in, under `-g` too (section 4: `here := "/tmp/shim-exp/final/wk"`; section 8 from a subdir: `here` is that subdir). The repo justfile's use of `invocation_directory()` for `here` is correct.
- Settings propagate through the import and are module-wide, either direction:
  - `set dotenv-load := true` and `set positional-arguments` declared in the imported file both took effect (section 7: `V=hello-from-dotenv`, `ARGS=one two`).
  - `set dotenv-load := true` declared only in the shim also applied to a recipe defined in the imported file (section 7b: `V2=hello-from-dotenv`).
- Shebang recipes work through the import (section 6: `respawn-demo` and `teams` ran from the package's `scripts/`).
- `just --list` lists imported recipes with their `[doc]` strings, and `--summary` too (section 6).
- Recipe working directory under `-g`: the VCS root of the invocation directory, not `~/.config/just` and not always the invocation dir. Section 8: run from `.../repo8/sub` with `.../repo8/.git` present -> plain recipe cwd is `/tmp/shim-exp/final/repo8`, `[no-cd]` recipe cwd is `/tmp/shim-exp/final/repo8/sub`. Dotenv search starts at that working directory and walks up (`src/load_dotenv.rs`), so `set dotenv-load` in the package still reads the caller's project `.env`, not one next to the shim.

### Q3. Where `just -g` looks, and what controls it

Documented order (just book "Global and User justfiles") matches `Search::global_justfile_paths()` in `src/search.rs`:

1. `$XDG_CONFIG_HOME/just/justfile`
2. `$HOME/.config/just/justfile`
3. `$HOME/justfile`
4. `$HOME/.justfile`

First match wins. Evidence: `XDG_CONFIG_HOME` wins (section 1), `$HOME/.config/just/justfile` beats `$HOME/justfile` (section 2), normal case with `XDG_CONFIG_HOME` unset (section 2b).

Controls and edge cases (all from the run):

- `XDG_CONFIG_HOME` must be absolute and non-empty. Empty behaves as unset; a relative value is ignored and `$HOME/.config` is used instead (section 10f; `dirs::config_dir()` semantics).
- The file name match is case-insensitive on just >= 1.42.0: a file called `JUSTFILE` in `.../just/` is found (section 10e).
- A symlink named `justfile` in the directory is found and used (that is how the user's machine works today).
- A dangling symlink is a loud error, and just does **not** fall through to the later paths (section 10c: `error: failed to read justfile at ...: No such file or directory`, exit 1).
- `just -g` conflicts with `JUST_JUSTFILE` / `--justfile` (section 10d: clap error, exit 2).
- There is no environment variable that relocates the global justfile itself in 1.58.0 (`just --help` shows no env for `-g`; no `JUST_CONFIG_DIR` in `src/`).
- Bare `just -g` fails: the root (shim) justfile has no recipes, so there is no default recipe. `just -g --list` and `just -g <recipe>` work. Do not add a `default:` recipe to the shim to paper over this: the package already defines `default`, and duplicate recipes across an import are a hard error.

### Q4. How to recognise our own shim

Put a machine-readable marker line in the generated file. Comments are inert to just: the marker shim evaluated exactly like the unmarked one (section 11: `repo` correct, exit 0).

Exact generated content (tested instance shown; `/coms-setup` substitutes the real package dir):

```
# Managed by pi-ext-agent-comms. Generated by /coms-setup; do not edit.
# coms-setup-shim v1
import "/home/coder/.pi/agent/git/github.com/macmacs/pi-ext-agent-comms/justfile"
```

The marker to detect is a line matching `^# coms-setup-shim v[0-9]+$`. Accept any known version, so a later `/coms-setup` can upgrade its own older shim.

Refusal table for `/coms-setup`:

| Target state | Action |
| --- | --- |
| Does not exist | Create the dirs and write the shim. |
| Regular file whose text contains the marker | Ours: overwrite (idempotent). |
| Regular file without the marker | Foreign: refuse, print the path, tell the user to move it or approve a backup-then-overwrite. |
| Symlink (any target) | Refuse. Never follow it. Print `readlink -f`. |
| Directory | Refuse. |

The symlink row is not theoretical: the user's current setup is exactly that symlink, and writing through it destroys the file it points at. Section 11b demonstrates it: `printf 'CLOBBERED\n' > justfile` where `justfile` is a symlink left `target.txt` containing `CLOBBERED`. Section 11c shows the safe write: write `justfile.tmp` in the same directory, then `mv -f justfile.tmp justfile`; the symlink itself is replaced and `target.txt` keeps its original content.

After writing, verify the mechanism actually works before reporting success:
`got=$(just -g --evaluate repo); [ "$got" = "$package_dir" ]` (section 12). `--evaluate` prints no trailing newline, so command substitution is the safe way to compare.

### Q5. Version here, and caveats

Installed: `just 1.58.0`. Version facts from `just --changelog` on this machine:

- `--global-justfile` and `source_directory()`: added in 1.27.0 (2024-05-25).
- `import?`: 1.21.0. Duplicate variable definitions need `allow-duplicate-variables`: 1.28.0.
- Global justfile file name made case-insensitive: 1.42.0.
- Import scope fixes: "Use correct scope when running recipes in submodules" 1.42.0, "Only override root-justfile variable assignments" 1.42.1, "Run imported recipes in correct scope" 1.42.4. The shim + import design depends on imported recipes seeing the right scope, so treat 1.42.4 as the safe floor; only 1.58.0 was tested here.
- `set minimum-version`: 1.55.0. If the repo wants a hard floor it can add `set minimum-version := "1.42.4"`; a just older than 1.55.0 errors on the unknown setting, which is a loud failure rather than a silent one.
- Old just (pre-1.27.0) has no `-g` at all, so there is little point in supporting it.

The package dir is an absolute path baked into the shim, so if pi ever changes the clone location (for example a different `PI_CODING_AGENT_DIR`; see ticket 01) `/coms-setup` must rewrite the shim. The marker makes that safe. Re-installing or updating the git package re-clones to the same path, so the shim survives normal updates.

## The exact working shim

```
# Managed by pi-ext-agent-comms. Generated by /coms-setup; do not edit.
# coms-setup-shim v1
import "<ABSOLUTE PATH TO THE INSTALLED PACKAGE>/justfile"
```

Experiment instance used in every passing section: `import "/tmp/shim-exp/final/pkg-sourcedir/justfile"`.

## The package justfile change (the only code change needed)

Tested exact replacement for the `repo` line (section 4, "package with the one-line fix"):

```diff
-repo := env_var_or_default("PI_COMS_REPO", if path_exists(justfile_directory() / "roles") == "true" { justfile_directory() } else { home_directory() / "repos/local/pi-ext-agent-comms" })
+repo := env_var_or_default("PI_COMS_REPO", if path_exists(source_directory() / "roles") == "true" { source_directory() } else { home_directory() / "repos/local/pi-ext-agent-comms" })
```

Same line, both contexts, with the fix (sections 4 and 4-root): `just -g` -> package dir; run directly -> package dir. The comment block above the line must change too: it currently says `justfile_directory()` is correct under the repo and resolves to `~/.config/just` through the global symlink. After the fix the sentence about the fallback is stale.

A simpler form, `repo := env_var_or_default("PI_COMS_REPO", source_directory())`, is equivalent for a complete package, but it was **not** the form exercised in the run, so it is not claimed as tested.

## Alternatives that also work, and why not to use them

- Shim overrides the imported `repo` variable directly, with `set allow-duplicate-variables` and `repo := "<pkg>"` (section 9a: works, package justfile unchanged). Rejected: the shim then hardcodes the package's internal variable name, and `allow-duplicate-variables` would also mask genuine duplicate-variable mistakes in the package justfile.
- Shim adds `set dotenv-path := "<generated .env>"` next to the import, and the env file holds `PI_COMS_REPO` (section 9b: works; a real environment value still wins). Rejected: it needs a second generated file, and the failure mode is silent - if the env file disappears, `repo` falls back to `~/repos/local/pi-ext-agent-comms` with exit 0 (section 9c). `set dotenv-required` turns that into a loud error (section 9d), but then the shim depends on a dotenv setting that the package also configures.
- Keep the current symlink to the repo justfile. Rejected: it only works while the package sits at that exact local clone path; the whole point is the git install, where it does not.
- `import?` instead of `import`. Rejected: with the package missing, `just -g --list` prints an empty recipe list and exits 0 (section 10b), so a broken install looks fine. Plain `import` fails loudly at parse time with the shim path and line (section 10a), which is what the setup command wants.

## /coms-setup outline (all pieces verified above)

1. Resolve `just` and require >= 1.42.4 (warn on older; error if `-g` is unsupported).
2. Resolve the target as just does: `${XDG_CONFIG_HOME:-$HOME/.config}/just/justfile`, where an empty or relative `XDG_CONFIG_HOME` counts as unset.
3. Apply the refusal table (marker, symlink, foreign file, directory).
4. Write the shim atomically (temp file + `mv -f`).
5. Verify: `just -g --evaluate repo` must equal the package dir, else fail loudly.
6. Tell the user to run `just -g --list` or a recipe name; bare `just -g` has no default recipe.

## Raw evidence (full run transcript)

```text
--- repo line, package as-is today ---
10:repo := env_var_or_default("PI_COMS_REPO", if path_exists(justfile_directory() / "roles") == "true" { justfile_directory() } else { home_directory() / "repos/local/pi-ext-agent-comms" })
--- repo line, package with the one-line fix ---
10:repo := env_var_or_default("PI_COMS_REPO", if path_exists(source_directory() / "roles") == "true" { source_directory() } else { home_directory() / "repos/local/pi-ext-agent-comms" })

==== 0. environment ====
$ just --version
just 1.58.0
exit=0

XDG_CONFIG_HOME=unset, HOME=/home/coder
user's real global justfile (untouched by this script):
$ ls -la /home/coder/.config/just/justfile
lrwxrwxrwx 1 coder coder 51 Sep 22 14:48 /home/coder/.config/just/justfile -> /home/coder/repos/local/pi-ext-agent-comms/justfile
exit=0

$ readlink -f /home/coder/.config/just/justfile
/home/coder/repos/local/pi-ext-agent-comms/justfile
exit=0

==== 1. just -g search path: XDG_CONFIG_HOME/just/justfile wins ====
$ env XDG_CONFIG_HOME=/tmp/shim-exp/final/xdg1 just -g --evaluate repo
/tmp/shim-exp/final/pkg-sourcedirexit=0

==== 2. search order: $HOME/.config/just/justfile beats $HOME/justfile ====
$ env HOME=/tmp/shim-exp/final/fakehome XDG_CONFIG_HOME= just -g --evaluate repo
/tmp/shim-exp/final/pkgAexit=0

(pkgA won; pkgB would mean ~/justfile won)

==== 2b. normal user case: shim at $HOME/.config/just/justfile, XDG unset ====
$ cat /tmp/shim-exp/final/fakehome/.config/just/justfile
# Managed by pi-ext-agent-comms. Generated by /coms-setup; do not edit.
# coms-setup-shim v1
import "/tmp/shim-exp/final/pkgA/justfile"
exit=0

$ env HOME=/tmp/shim-exp/final/fakehome XDG_CONFIG_HOME= just -g --evaluate repo
/tmp/shim-exp/final/pkgAexit=0

$ env HOME=/tmp/shim-exp/final/fakehome XDG_CONFIG_HOME= just -g --list
Available recipes:
    backoffice *args           # Backoffice peer, always pinned to PI_BACKOFFICE_DIR
    default
    install-global             # Install coms globally + symlink the justfile for `just -g` from anywhere
    lean *args                 # pi in the current dir with the rarely-used tools excluded
    local-coms *args           # Plain local peer in the current dir (args go straight to pi)
    respawn-demo *args=""      # Scripted respawn smoke test between two role peers
    role name *args            # Role-file peer from roles/<name>.md in the current dir
    role-team team_name +roles # Tile roles in one tmux window on a named pool (--windows for one window each)
    team +roles                # Tile roles in one tmux window on the default pool (--windows for one window each)
    teams                      # List coms pools and who is registered in each
    typecheck                  # Typecheck the extensions with the repo's pinned tsc
exit=0

==== 3. the proposed shim with 'export PI_COMS_REPO' does NOT feed env_var_or_default ====
$ cat /tmp/shim-exp/final/xdg3/just/justfile
export PI_COMS_REPO := "/tmp/shim-exp/final/pkg-sourcedir"
import "/tmp/shim-exp/final/pkg-as-is/justfile"
exit=0

$ env XDG_CONFIG_HOME=/tmp/shim-exp/final/xdg3 just -g --evaluate
PI_COMS_REPO   := "/tmp/shim-exp/final/pkg-sourcedir"
backoffice_dir := "/home/coder/repos/backoffice"
here           := "/tmp/shim-exp/final/wk"
lean_exclude   := "ctx_purge,ctx_doctor,ctx_stats,ctx_upgrade,ctx_insight,aio-webpull,aio-webquery,aio-webmap,aio-webresearch,aio-webresult,aio-webcontent,mcp,mcpScript"
repo           := "/home/coder/repos/local/pi-ext-agent-comms"
team_default   := "team"
tools_core     := "read,bash,edit,write,todo,ask_user_question,coms_send,coms_list,coms_respawn,coms_cold_respawn,coms_request_respawn,ctx_search"
exit=0

(PI_COMS_REPO became a justfile variable, yet repo still fell back to the hardcoded ~/repos/local path)

==== 4. working shim: plain import; package uses source_directory() ====
$ cat /tmp/shim-exp/final/xdg4/just/justfile
import "/tmp/shim-exp/final/pkg-sourcedir/justfile"
exit=0

$ env XDG_CONFIG_HOME=/tmp/shim-exp/final/xdg4 just -g --evaluate repo
/tmp/shim-exp/final/pkg-sourcedirexit=0

$ env XDG_CONFIG_HOME=/tmp/shim-exp/final/xdg4 just -g --evaluate here
/tmp/shim-exp/final/wkexit=0

--- same file used directly at the root (not imported) ---
$ just --justfile /tmp/shim-exp/final/pkg-sourcedir/justfile --evaluate repo
/tmp/shim-exp/final/pkg-sourcedirexit=0


==== 5. justfile_directory() vs source_directory() inside an import ====
$ env XDG_CONFIG_HOME=/tmp/shim-exp/final/xdg5 just -g --evaluate
jfd  := "/tmp/shim-exp/final/xdg5/just"
srcd := "/tmp/shim-exp/final/imp5"
exit=0

(jfd is the shim dir, srcd is the imported file's dir)

==== 6. --list, --summary and real recipes through the shim ====
$ env XDG_CONFIG_HOME=/tmp/shim-exp/final/xdg4 just -g --list
Available recipes:
    backoffice *args           # Backoffice peer, always pinned to PI_BACKOFFICE_DIR
    default
    install-global             # Install coms globally + symlink the justfile for `just -g` from anywhere
    lean *args                 # pi in the current dir with the rarely-used tools excluded
    local-coms *args           # Plain local peer in the current dir (args go straight to pi)
    respawn-demo *args=""      # Scripted respawn smoke test between two role peers
    role name *args            # Role-file peer from roles/<name>.md in the current dir
    role-team team_name +roles # Tile roles in one tmux window on a named pool (--windows for one window each)
    team +roles                # Tile roles in one tmux window on the default pool (--windows for one window each)
    teams                      # List coms pools and who is registered in each
    typecheck                  # Typecheck the extensions with the repo's pinned tsc
exit=0

$ env XDG_CONFIG_HOME=/tmp/shim-exp/final/xdg4 just -g --summary
backoffice default install-global lean local-coms respawn-demo role role-team team teams typecheck
exit=0

$ env XDG_CONFIG_HOME=/tmp/shim-exp/final/xdg4 just -g respawn-demo
"/tmp/shim-exp/final/pkg-sourcedir/scripts/respawn-demo.sh" 
Respawn demo (scripted, two terminals)
======================================

1. Terminal A — orchestrator peer:
       just role orchestrator
   Terminal B — researcher peer:
       just role researcher

2. Wait for both peers to register, then snapshot the researcher's current sid:
       just respawn-demo sid researcher

3. In the orchestrator TUI, prompt the agent:
       call coms_request_respawn targeting researcher with note
       "respawned for the smoke test", then wait for the researcher to confirm.

   The orchestrator agent sends the request; the researcher agent decides
   whether to agree. An ack timeout surfaces if it never answers.

4. On the researcher TUI, if the confirm-destructive extension is active,
   a "Clear session?" gate appears before the session is replaced — approve
   it. Headless (non-interactive) peers skip this gate.

5. Observe the researcher: same pid, same TUI, identity preserved, and the
   kickoff note "respawned for the smoke test" appears as the fresh session's first message.

6. Verify on disk:
       just respawn-demo verify researcher "respawned for the smoke test"

   Expected: registry session_id changed (step 2 vs now), pid unchanged,
   and the session jsonl carrying that session_id shows the kickoff note.
exit=0

$ env XDG_CONFIG_HOME=/tmp/shim-exp/final/xdg4 just -g teams
cool                   cool
hollow                 hollow
exit=0


==== 7. settings propagate through the import ====
$ cat /tmp/shim-exp/final/wk7/.env
V=hello-from-dotenv
exit=0

$ env XDG_CONFIG_HOME=/tmp/shim-exp/final/xdg7 just -g show one two
V=hello-from-dotenv
ARGS=one two
exit=0

--- a setting declared in the SHIM also applies to imported recipes ---
$ env XDG_CONFIG_HOME=/tmp/shim-exp/final/xdg7b just -g show2
V2=hello-from-dotenv
exit=0


==== 8. working directory with -g (matters for dotenv search) ====
$ pwd
/tmp/shim-exp/final/repo8/sub
exit=0

$ env XDG_CONFIG_HOME=/tmp/shim-exp/final/xdg8 just -g pwd-here
/tmp/shim-exp/final/repo8
exit=0

$ env XDG_CONFIG_HOME=/tmp/shim-exp/final/xdg8 just -g pwd-invocation
/tmp/shim-exp/final/repo8/sub
exit=0

(with -g, the recipe cwd is the VCS root of the invocation dir; [no-cd] gives the invocation dir)

==== 9. alternatives that also carry PI_COMS_REPO ====
--- 9a. shim overrides the imported 'repo' variable (package unchanged) ---
$ env XDG_CONFIG_HOME=/tmp/shim-exp/final/xdg9 just -g --evaluate repo
/tmp/shim-exp/final/pkg-as-isexit=0

--- 9b. shim sets dotenv-path to a generated env file ---
$ env XDG_CONFIG_HOME=/tmp/shim-exp/final/xdg9b just -g --evaluate repo
/tmp/shim-exp/final/pkg-as-isexit=0

$ env XDG_CONFIG_HOME=/tmp/shim-exp/final/xdg9b PI_COMS_REPO=/tmp/real-env-wins just -g --evaluate repo
/tmp/real-env-winsexit=0

--- 9c. same, but the env file is missing: silent wrong fallback, exit 0 ---
$ env XDG_CONFIG_HOME=/tmp/shim-exp/final/xdg9c just -g --evaluate repo
/home/coder/repos/local/pi-ext-agent-commsexit=0

--- 9d. same, with set dotenv-required: now it fails loudly ---
$ env XDG_CONFIG_HOME=/tmp/shim-exp/final/xdg9d just -g --evaluate repo
error: dotenv file not found
exit=1


==== 10. failure modes of the shim ====
--- 10a. plain import of a missing package: loud parse error ---
$ env XDG_CONFIG_HOME=/tmp/shim-exp/final/xdg10 just -g --list
error: could not find source file for import
 ——▶ justfile:1:8
  │
1 │ import "/tmp/shim-exp/final/gone/justfile"
  │        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
exit=1

--- 10b. import? of a missing package: silent, empty recipe list, exit 0 ---
$ env XDG_CONFIG_HOME=/tmp/shim-exp/final/xdg10b just -g --list
Available recipes:
exit=0

--- 10c. dangling symlink as the global justfile: loud error, no fallback ---
$ env XDG_CONFIG_HOME=/tmp/shim-exp/final/xdg10c just -g --list
error: failed to read justfile at `/tmp/shim-exp/final/xdg10c/just/justfile`: No such file or directory (os error 2)
exit=1

--- 10d. -g conflicts with JUST_JUSTFILE ---
$ env JUST_JUSTFILE=/tmp/nope/justfile XDG_CONFIG_HOME=/tmp/shim-exp/final/xdg4 just -g --evaluate repo
error: the argument '--global-justfile' cannot be used with '--justfile <JUSTFILE>'

Usage: just --global-justfile --evaluate <ARGUMENTS>...

For more information, try '--help'.
exit=2

--- 10e. filename is matched case-insensitively (just >= 1.42.0) ---
$ env XDG_CONFIG_HOME=/tmp/shim-exp/final/xdg10e just -g --evaluate repo
/tmp/shim-exp/final/pkg-sourcedirexit=0

--- 10f. relative XDG_CONFIG_HOME is ignored ---
$ env HOME=/tmp/shim-exp/final/fakehome XDG_CONFIG_HOME=relxdg just -g --evaluate repo
/tmp/shim-exp/final/pkgAexit=0

(fell back to $HOME/.config: just uses dirs::config_dir(), which needs an absolute XDG_CONFIG_HOME)

==== 11. ownership: marker is inert, and how a bad writer clobbers a symlink ====
$ cat /tmp/shim-exp/final/xdg11/just/justfile
# Managed by pi-ext-agent-comms. Generated by /coms-setup; do not edit.
# coms-setup-shim v1
import "/tmp/shim-exp/final/pkg-sourcedir/justfile"
exit=0

$ env XDG_CONFIG_HOME=/tmp/shim-exp/final/xdg11 just -g --evaluate repo
/tmp/shim-exp/final/pkg-sourcedirexit=0

--- 11b. naive '> path' write follows a symlink and destroys its target ---
$ cat /tmp/shim-exp/final/clobber/target.txt
CLOBBERED
exit=0

--- 11c. write temp file + mv replaces the symlink itself; target survives ---
$ ls -la /tmp/shim-exp/final/safe/just
total 12
drwxr-xr-x 2 coder coder 4096 Sep 22 15:19 .
drwxr-xr-x 3 coder coder 4096 Sep 22 15:19 ..
-rw-r--r-- 1 coder coder   18 Sep 22 15:19 justfile
exit=0

$ cat /tmp/shim-exp/final/safe/target.txt
ORIGINAL: must survive
exit=0

$ cat /tmp/shim-exp/final/safe/just/justfile
SAFE shim content
exit=0


==== 12. post-write check /coms-setup can run ====
$ got=$(XDG_CONFIG_HOME=... just -g --evaluate repo); [ "$got" = "<package dir>" ] && echo ok
got=/tmp/shim-exp/final/pkg-sourcedir
verification ok

==== 13. user's real global justfile after all experiments ====
$ ls -la /home/coder/.config/just/justfile
lrwxrwxrwx 1 coder coder 51 Sep 22 14:48 /home/coder/.config/just/justfile -> /home/coder/repos/local/pi-ext-agent-comms/justfile
exit=0

$ readlink -f /home/coder/.config/just/justfile
/home/coder/repos/local/pi-ext-agent-comms/justfile
exit=0


```
