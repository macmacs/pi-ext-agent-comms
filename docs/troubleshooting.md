# Troubleshooting

Install, setup and recipe failures. Runtime and design gotchas (the respawn
confirm gate, `coms_list` idleness caveats, old-build peers) live in
[coms.md](coms.md).

## Boot exits 1: `Tool "coms_list" conflicts ...`

**Symptom.** Pi exits 1 before it starts. The error names
`Tool "coms_list" conflicts`, plus six duplicate-flag errors for
`--cname`, `--role`, `--purpose`, `--project`, `--color` and `--explicit`.

**Cause.** This package is installed twice, once from a local path and once from
git. To pi those are different identities, so both entries load `coms.ts` and
both register the same tools and flags. One entry can also hide in a project's
`.pi/settings.json` while the other is global.

**Fix.** Remove one of the two entries: `/settings` in pi, or edit
`~/.pi/agent/settings.json` (and any project `.pi/settings.json`).

When you switch from a local checkout to the git install, do both in **one**
step: add the git entry and remove the local-path entry together. Adding the git
entry first breaks the next boot, because that is the boot where both exist.

## `/coms-setup: coms was loaded with -e/--extension`

**Symptom.** `/coms-setup` refuses to run:

```
/coms-setup: coms was loaded with -e/--extension, not as a package, so there is no package root to wire.
```

**Cause.** A session started with `pi -e extensions/coms.ts` has no package
install behind it, so there is nothing for the shim to import.

**Fix.** Install the package, restart pi, rerun `/coms-setup`:

```bash
pi install git:github.com/macmacs/pi-ext-agent-comms
```

A dev checkout works too, as long as it is installed:
`pi install /path/to/checkout`.

## `/coms-setup: just X.Y.Z is too old`

**Symptom.** `/coms-setup` refuses with `just 1.40.0 is too old; this needs just
>= 1.42.4.`

**Cause.** The shim imports the package justfile, and imported justfiles need
the 1.42.4 import-scope fix to resolve `source_directory()` correctly.

**Fix.** Upgrade just (`brew install just`, `cargo install just`,
`apt install just`), then rerun `/coms-setup`.

## `/coms-setup` refuses a symlink

**Symptom.**

```
/coms-setup: /home/you/.config/just/justfile is a symlink to /home/you/repos/.../justfile;
refusing to write through it, because that would rewrite the file it points at.
```

**Cause.** The old manual setup symlinked `~/.config/just/justfile` into the
checkout. Writing through a symlink would rewrite the file it points at, so the
command never follows one.

**Fix.** Either remove the link and rerun `/coms-setup`:

```bash
rm ~/.config/just/justfile
```

or run `/coms-setup force`. Force replaces the link node itself (temp file plus
rename) and leaves the target file untouched.

## `/coms-setup` refuses a foreign justfile

**Symptom.**

```
/coms-setup: /home/you/.config/just/justfile is a justfile this package did not write.
```

**Cause.** Something else owns the global justfile. The command only overwrites
its own shim, recognised by the `# coms-setup-shim vN` marker line.

**Fix.** Move the file aside, or run `/coms-setup force`, which backs it up to
`justfile.bak-<stamp>` first. A **directory** at that path is refused even with
force; move it aside.

## Bare `just -g` fails from an unrelated directory

**Symptom.** Outside the repo, `just -g` prints:

```
error: no justfile found
error: recipe `default` failed on line 43 with exit code 1
```

**Cause.** Bare `just -g` runs the imported `default` recipe, which is
`just --list`. That nested `just` call does not carry `-g`, so it searches
upward from your current directory, finds no justfile and fails. In a project
that has its own justfile, the same command prints that project's recipes
instead of the global ones.

**Fix.** Name what you want:

```bash
just -g --list
just -g teams
just -g role builder
```

## `just typecheck: no local typescript found`

**Symptom.**

```
typecheck: no local typescript found at /path/to/package/node_modules/typescript/bin/tsc
```

**Cause.** Typechecking is a development-only path. An installed package has no
`node_modules` (npm's dev dependencies are not installed for a git install), so
the pinned tsc is missing.

**Fix.** In a checkout, run `npm install` once (it installs the pinned tsc plus
the pi packages as type-only dev deps, nothing at runtime), then `just typecheck`.

## tmux panes are not the width you asked for

**Symptom.** The main pane is not `PI_COMS_MAIN_PANE_WIDTH` (default `60%`)
after `just team`.

**Cause.** tmux builds a detached session at 80x24 and scales the layout
proportionally on attach, so 60% silently becomes less. The launcher works around
this; see [team.md](team.md) for the mechanism and the measurements.

**Fix.** Launch from a real terminal (the fallback `client-resized` hook only
fires when a client attaches). If the width is still wrong, include your tmux
version (`tmux -V`) when reporting it.
