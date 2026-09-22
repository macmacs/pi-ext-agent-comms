# pi-ext-agent-comms

Peer-to-peer agent communication for the pi coding agent: local agents talk to
each other over unix sockets. One extension, `extensions/coms.ts`. No hub, no
server process, no runtime dependencies beyond pi's bundled packages. Each agent
gets a name, a pool, a model and a tool budget, and can prompt, await and respawn
its peers.

Slimmed down from the "Pi to Pi" work:

- [disler/pi-vs-claude-code](https://github.com/disler/pi-vs-claude-code): the
  original `coms` work (IndyDevDan's "Pi to Pi")
- [terakael/pi-vs-claude-code](https://github.com/terakael/pi-vs-claude-code):
  TUI/race fixes
- [TheMule71/pi-vs-claude-code](https://github.com/TheMule71/pi-vs-claude-code):
  the fork this repo came from

## Install

Needs [just](https://github.com/casey/just) 1.42.4 or newer
(`brew install just`).

```bash
pi install git:github.com/macmacs/pi-ext-agent-comms
```

Restart pi, then run the setup command once:

```
/coms-setup
```

That writes the global justfile shim so the recipes run from any directory, and
proves the shim resolves back to the installed package. Check it:

```bash
just -g --list
```

Update later with `pi update --extensions` (it follows main). To work on a
checkout instead of an install:

```bash
pi -e extensions/coms.ts
```

If any of this refuses or fails, see
[docs/troubleshooting.md](docs/troubleshooting.md).

## Quick start

One peer, in the current directory:

```bash
just -g role builder
```

Start `just -g role scribe` in another terminal to give it someone to talk to.
Each peer reads its identity (name, color, model, tool budget) from
`roles/<name>.md` and registers in the default pool.

- Tools: `coms_list` (peers and status), `coms_send` (prompt a peer, await its
  reply), plus the respawn tools.
- TUI: `/coms` opens the pool view, `%agent` talks to one peer directly, Ctrl+O
  expands message details.
- Respawn replaces a session in place with a fresh context, and a cold respawn
  costs the peer no turn at all. Details in [docs/coms.md](docs/coms.md).

## Recipes

`just -g` needs the shim that `/coms-setup` writes.

| `just -g ...` | What it does |
|---|---|
| `role <name>` | role-file peer in the current dir (`--team <pool>` picks the pool) |
| `team <roles...>` | the whole team tiled in one tmux window |
| `role-team <pool> <roles...>` | same, on a named pool (`--windows` gives one window per role) |
| `backoffice` | backoffice peer, pinned to `PI_BACKOFFICE_DIR` |
| `teams` | list pools and who is registered in each |
| `local-coms` | plain peer in the current dir, no role file |
| `lean` | your own session, minus the rarely-used tools |
| `typecheck` | tsc over the extensions (`npm install` once in the package) |
| `respawn-demo` | scripted respawn smoke test |
| `--list` | every recipe, with descriptions |

Roles, pools, per-role models and tool budgets live in
[docs/team.md](docs/team.md).

## Variables

| Variable | Default | Controls |
|---|---|---|
| `PI_COMS_REPO` | the package dir (via `source_directory()`); fallback `$HOME/repos/local/pi-ext-agent-comms` | where `roles/` and `scripts/` are found |
| `PI_BACKOFFICE_DIR` | `$HOME/repos/backoffice` | the dir `just backoffice` launches in |
| `PI_COMS_TEAM` | `team` | default pool for `role` / `backoffice` / `team` (override per-run with `--team`) |
| `PI_COMS_MAIN_PANE_WIDTH` | `60%` | width of the main (first role) pane in a tiled `team` / `role-team` |
| `PI_COMS_CACHE_TTL_MS` | `300000` (5 min) | prompt-cache TTL used for the idle / `cache cold` marker in `coms_list` |
| `PI_COMS_DIR` | `$HOME/.pi/coms` | root of the registry (`projects/<pool>/agents/*.json`) |
| `PI_COMS_MAX_HOPS` | `5` | hop limit per message; beyond it the receiver nacks with `hops exceeded` |
| `PI_COMS_PING_INTERVAL_MS` | `10000` (10s) | keepalive / cascade-ping period; peers are evicted as stale after 3 missed cycles |

`PI_COMS_PROJECT` and `PI_COMS_NAME` are written by the extension at boot (they
carry the identity for co-loaded extensions, and give `/reload` a stable name).
`PI_PARENT_SESSION` is read-only; nothing in this repo or in pi sets it today, so
every coms agent counts as root.

Pointing `PI_COMS_DIR` somewhere else gives you a completely separate registry,
which is the clean way to try things out without touching a live pool. Export it
for the whole shell, so `just teams` and the peers agree on it:

```bash
export PI_COMS_DIR=/tmp/coms-scratch
just -g role builder    # registers in the scratch registry, invisible to the real pool
```

## Docs

- [docs/coms.md](docs/coms.md) - registry, `%` mentions, respawn, TUI
- [docs/team.md](docs/team.md) - roles, recipes, pools, tmux, models, tool budgets
- [docs/multi-agent.md](docs/multi-agent.md) - example prompts, other pi patterns
- [docs/troubleshooting.md](docs/troubleshooting.md) - install and setup failures

## Notes

- Typecheck: `npm install` once in the package, then `just typecheck`. The dev
  deps are the pinned tsc 5.9.3 plus the pi packages for their `.d.ts` only,
  nothing at runtime.
- `coms.ts` loads its helpers (`editor-host.ts`, `naming.ts`) as plain modules.
  The manifest lists only `coms.ts` and `editor-host.ts` as extensions, so
  helpers are never boot surfaces.
- Extensions removed from this repo over time (agent-team, agent-chain, pi-pi,
  subagent-widget, ...) are recoverable from git history:
  `git show 75a2a8d:extensions/subagent-widget.ts`.
