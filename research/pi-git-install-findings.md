# What happens when someone runs `pi install git:github.com/macmacs/pi-ext-agent-comms`

Ticket: "Understand pi git installs" (`.scratch/agent-comms-restructure/issues/01-understand-pi-git-installs.md`).
pi version on this machine: 0.87.0. Investigated 2026-09-22.

Every claim below is tied to one of three sources:

- **DOCS** = `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/docs/packages.md`
- **SRC** = pi's shipped code: `dist/core/package-manager.js`, `dist/main.js`, `docs/environment-variables.md`
- **RUN** = a command run on this machine, output quoted

## 1. Where the clone lands, and what settings gets

**Clone path.** `$PI_CODING_AGENT_DIR/git/<host>/<path>`, which by default is
`~/.pi/agent/git/github.com/macmacs/pi-ext-agent-comms`.

- SRC: `getGitInstallRoot` returns `join(agentDir, "git")`; `getGitInstallPath` returns
  `resolveManagedPath(installRoot, source.host, source.path)`.
- RUN: install printed
  `Cloning into '/tmp/pi-scratch-agent-9fqDCc/git/github.com/macmacs/pi-ext-agent-comms'`.

**Settings entry.** A git install writes a **plain string**, not an object, and no filter:

```json
{
  "packages": ["git:github.com/macmacs/pi-ext-agent-comms"]
}
```

- RUN: `cat settings.json` after install, exact content above.
- SRC: `addSourceToSettings` appends `normalizePackageSourceForSettings(source)` as a string.
  An existing object entry is kept and only its `source` field is rewritten, so a hand-written
  filter survives a reinstall of the same source.
- DOCS confirms the identity rule: for git, identity is the repository URL **without** the ref.

**Side artifacts.**

- `pi` writes `<agentDir>/git/.gitignore` containing `*` and `!.gitignore`.
  (SRC `ensureGitIgnore`; RUN `cat` shows just those two lines.)
- A **local-path** install writes a **relative** path instead:
  `pi install /home/coder/repos/local/pi-ext-agent-comms` produced
  `"../../home/coder/repos/local/pi-ext-agent-comms"`. (RUN)

## 2. What loads from the manifest, and what breaks

**Manifest semantics.** `pi.extensions` etc. are paths relative to the package root. Arrays
support globs and `!exclusions`. A filter in settings layers **on top of** the manifest and can
only narrow it. (DOCS)

**A missing manifest path is silently skipped. No warning, no error.**

- SRC: `collectFilesFromManifestEntries` maps a plain entry to `resolve(root, entry)`, then
  `collectFilesFromPaths` does `for (const p of paths) { if (!existsSync(p)) continue; ... }`.
- RUN: with `"themes": ["./.pi/themes"]` still in the manifest and no such directory, boot
  printed `BOOT-OK` and exit 0, with no message about themes.
- So the phantom themes entry is **harmless but dishonest**. Removing it changes nothing you
  can observe.

**Any extension that fails to load is FATAL. pi exits 1.**

- SRC `dist/main.js`:
  ```js
  const hasRuntimeErrors = runtime.diagnostics.some((diagnostic) => diagnostic.type === "error");
  ...
  if (hasRuntimeErrors) {
      if (... message.includes("Failed to load extension")) console.error(EXTENSION_LOAD_FAILURE_HINT);
      process.exit(1);
  }
  ```
  The exit happens before a session starts, in print **and** interactive mode.
- RUN: boot with the shipped manifest exited 1 and printed no model output. The same command
  with `-ne` (extensions off) printed `BOOT-OK` and exit 0. That isolates the cause.

**The real boot error is a FLAG CONFLICT, not the documented hub error.**

- RUN: `coms-net.ts` fails with
  `Flag "--cname" conflicts with .../extensions/coms.ts`
  and the same for `--role`, `--purpose`, `--project`, `--color`, `--explicit`.
- The README's story ("coms-net errors on boot without a hub / no server URL") is stale. The
  reason a settings filter is needed today is that both extensions register the same six flags.

**A filter naming a file that no longer exists is harmless.**

- RUN: `extensions: ["extensions/*.ts", "!extensions/coms-net.ts"]` against a package where
  `coms-net.ts` had already been deleted gave `BOOT-OK`, exit 0.

**The destination is proven.** In the real git clone at
`<agentDir>/git/github.com/macmacs/pi-ext-agent-comms` I deleted `extensions/coms-net.ts`,
rewrote the manifest to `"extensions": ["./extensions/coms.ts", "./extensions/editor-host.ts"]`
and dropped `themes`, then booted with the **plain-string** settings entry (no filter):

```
Reply with exactly: BOOT-OK
BOOT-OK
boot exit=0
```

So "clean install, no manual settings filter" is reachable. Nothing else in the manifest needs
to change.

## 3. npm install for a git install

**It runs `npm install --omit=dev` with cwd set to the clone.** It runs on first clone when
`package.json` exists, and again every time the checkout changes. (SRC `getGitDependencyInstallArgs`,
`installGit`, `cleanAndInstallGitDependencies`.) If `npmCommand` is set in settings the args
collapse to `["install"]`.

**peerDependencies are NOT fetched from npm.**

- RUN: install printed `up to date, audited 1 package in 754ms` and
  `ls node_modules` gave `No such file or directory`. Nothing was installed at all.
- Note the two code paths differ: the npm-package path deliberately passes
  `--legacy-peer-deps` (npm), `--omit=peer` (bun) or `auto-install-peers=false` (pnpm)
  (`getNpmInstallArgs`). The git path does not, but npm still does not install the root
  project's own peer dependencies. Pi supplies the `@earendil-works/pi-*` modules through
  loader aliases instead, which is why the extension can import them with empty `node_modules`.

**devDependencies are NOT installed.** Proven consequence:
`just typecheck` cannot work on a git install.

```
$ just -f <clone>/justfile typecheck
typecheck: no local typescript found at <clone>/node_modules/typescript/bin/tsc
  run 'npm install' in <clone> first (installs the pinned tsc + pi type deps)
error: recipe `typecheck` failed with exit code 1
```
(RUN, exit 1)

**Side effect: npm rewrites `package-lock.json`, so the clone is dirty right after install.**

- RUN: `git status --short` in the fresh clone showed ` M package-lock.json`. The diff is one
  deleted line, `"hasShrinkwrap": true` on a dev entry. Cosmetic, but it means a freshly
  installed clone is never git-clean.

## 4. What `pi update --extensions` does

### Unpinned: it follows the remote default branch, and it deletes things

SRC: with no ref, `getLocalGitUpdateTarget` resolves `@{upstream}` (or falls back to
`git remote set-head origin -a` plus `origin/HEAD`), fetches
`+refs/heads/<branch>:refs/remotes/origin/<branch>`, then `ensureGitRef` runs
`git reset --hard <ref>^{commit}` followed by `cleanAndInstallGitDependencies`, which runs
`git clean -fdx` and then `npm install --omit=dev`.

RUN: I put a local commit, an untracked file, a gitignored `.env` and a `node_modules/` into the
clone, then ran `pi update --extensions`:

```
Updating git:github.com/macmacs/pi-ext-agent-comms...
'origin/HEAD' is unchanged and points to 'main'
HEAD is now at 8fd31d3 Added just lean for a lighter interactive session
Removing .env
Removing node_modules/
Removing untracked-file.txt

up to date, audited 1 package in 653ms
Updated packages
exit=0
```

What that means:

- The local commit was **destroyed**; HEAD went back to `origin/main`.
- `git clean -fdx` removed untracked **and gitignored** files (`-x` covers ignored files).
  **An `.env` placed in the clone is deleted.** `node_modules/` goes too.
- It exits 0 and prints `Updated packages`.
- It does **not** switch branch. The clone stayed on whatever branch it was on, just reset to
  the fetched commit.
- If the clone is already at the target commit, only `repairMissingGitDependencies` runs, and
  that checks the manifest's `dependencies` **only**. This package declares no `dependencies`,
  so nothing is reinstalled in the no-change case.

Practical consequence: installing devDependencies into the clone to get a `tsc` buys you a
compiler that disappears on the next upstream commit. Do not rely on it.

### Pinned to a bare commit SHA: update BREAKS

- RUN: `pi install git:github.com/macmacs/pi-ext-agent-comms@8fd31d3` succeeds. The checkout
  works because a normal clone already has every object. Settings recorded the ref verbatim:
  `"git:github.com/macmacs/pi-ext-agent-comms@8fd31d3"`.
- RUN: `pi update --extensions` then fails:
  ```
  Updating git:github.com/macmacs/pi-ext-agent-comms@8fd31d3...
  fatal: couldn't find remote ref 8fd31d3
  Error: git fetch origin 8fd31d3 failed with code 128
  exit=1
  ```
  The clone still boots, so the install is not corrupted, but the update command fails.
- Root cause proven separately against a local bare origin: `git fetch origin <tag>` succeeds,
  `git fetch origin <sha>` gives `fatal: couldn't find remote ref 8fd31d3`. A server only
  advertises refs, and a bare SHA is not one unless the server enables
  `uploadpack.allowReachableSHA1InWant`.

**Rule: if the documented install pins anything, pin a TAG or a branch. Never a bare commit
SHA.** DOCS says "Refs are pinned tags or commits", which is true for the initial clone and
misleading for every update after it.

## 5. Smoke-testing an install without touching the real settings

`PI_CODING_AGENT_DIR` overrides the whole config directory. DOCS/environment-variables.md:
"Override the config directory; default is `~/.pi/agent`". Settings, the git clones and auth all
live under it, so a scratch value isolates everything.

```bash
SC=$(mktemp -d)
export PI_CODING_AGENT_DIR="$SC"

pi install git:github.com/macmacs/pi-ext-agent-comms
pi list                                     # shows source + resolved clone path
pi -p --no-session --provider deepseek --model deepseek-flash "Reply with exactly: BOOT-OK"
pi update --extensions
pi remove git:github.com/macmacs/pi-ext-agent-comms

rm -rf "$SC"                                # also removes the clone
```

Notes from running exactly this:

- Nothing outside the scratch directory was read or written. The real
  `~/.pi/agent/settings.json` and `~/.pi/agent/auth.json` had the same md5 before and after
  every run above (`075c317bb28afbb0086622658d381495` and `99914b932bd37a50b983c5e7c90ae93b`).
- Auth comes from environment variables (`DEEPSEEK_API_KEY` and `NEURALWATT_API_KEY` were
  present), so a scratch agent dir can still reach a model. `auth.json` is literally `{}`.
- A scratch agent dir contains **no** npm-installed packages, so provider extensions are
  missing. `--provider neuralwatt` failed with `Unknown provider "neuralwatt"`. Pass a
  built-in provider instead, for example `--provider deepseek --model deepseek-flash`.
  Check what is available with `pi --list-models <name>`.
- `pi remove <source>` deletes the clone as well as the settings entry.

## 6. What a git install cannot do that a local-path install can

- **Keep devDependencies.** A local-path install runs no npm install at all. SRC: `install()`
  for `type === "local"` only checks that the path exists. So the checkout keeps whatever
  `npm install` you ran by hand, including the pinned `typescript`. A git install gets
  `--omit=dev` and an empty `node_modules`. This is the whole reason `just typecheck` works
  from a local checkout and fails from a git install.
- **Keep your edits.** A git install is reset hard and cleaned on update. A local path is never
  touched by `pi install`, `pi update` or `pi remove`.
- **Keep a `.env`.** `git clean -fdx` deletes a gitignored `.env` inside the clone.
- **Be skipped by updates.** SRC `updateConfiguredSources` collects only `npm` and `git`
  candidates, so a local-path entry is ignored by `pi update --extensions` entirely.
- **Work with a bare SHA pin.** A local path has no ref to fetch.

## What this changes for the rest of the map

- **"Lock the package shape"**: the manifest only needs `coms.ts` and `editor-host.ts` for a
  clean boot. Dropping `themes` changes nothing observable, but it should go because it is a
  lie in the manifest. A plain-string settings entry is what `pi install` writes and it is
  enough once coms-net is gone.
- **"Design /coms-setup"**: do not promise `just typecheck` on an installed package. It needs
  devDependencies that `pi install` refuses to install and that the next real update deletes.
  Either drop the check or make the recipe say so plainly.
- **Release and tag policy (still fog)**: if a ref is pinned at all, it must be a tag. Pinning
  a commit SHA makes `pi update --extensions` fail with exit 1.
- **"Verify and migrate"**: use `PI_CODING_AGENT_DIR` for the clean-state proof. Editing the
  real `~/.pi/agent/settings.json` is the last step, not the first.
- **Docs**: the README's "coms-net errors on boot without a hub / no server URL" explanation is
  wrong. The failure is duplicate flag registration, and it is fatal, not cosmetic.
