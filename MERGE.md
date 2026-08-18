# pi-ext-agent-comms

Merged multi-agent extension set for the Pi coding agent. Integrates two substantial forks of `disler/pi-vs-claude-code` plus the upstream repo itself.

## Sources merged

| Source | Branch | Adds |
|---|---|---|
| `disler/pi-vs-claude-code` | main | Base: coms, coms-net, agent-team, agent-chain, damage-control, subagent-widget, themes |
| `TheMule71/pi-vs-claude-code` | main | +30 commits: per-subagent extension whitelist, per-expert model overrides, `dispatch_agents` with concurrency, `read_agent_output` with offset/limit, timeouts (300s/600s), AbortSignal wiring, childPid race guards, orchestrator frontmatter config |
| `terakael/pi-vs-claude-code` | main | +30 commits: coms rewrite with race-condition fix, push-based gossip, `@` direct interaction, kill cascade, cascading statuses, multi-project pools, headless subagents via `pi --mode rpc`, permission gates, split editor |

## Merge resolution notes

- 3 conflict hunks across `extensions/coms.ts` and `extensions/subagent-widget.ts`
- terakael's rewrites of both files were kept wholesale (Mule's only changes there were a `themeMap.ts` import-path move, already consistent)
- Upstream's commit "add thinking and model to subagents" (both forks missed) merged clean first
- All imports normalized to the current package names: `@mariozechner/pi-*` -> `@earendil-works/pi-*`, `@sinclair/typebox` -> `typebox`
- All 25 top-level extension files verified with `bun build --no-bundle` against the installed pi packages

## Install

```bash
pi install ./pi-ext-agent-comms        # from this directory's parent
# or
pi install /Users/macmacs/pi-agen-main/pi-ext-agent-comms
```

Installs without copying; edits here take effect on next pi start. `yaml` dependency is already installed in `node_modules/`.

To narrow what loads, use the package filter form in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "/Users/macmacs/pi-agen-main/pi-ext-agent-comms",
      "extensions": ["extensions/coms.ts", "extensions/coms-net.ts", "extensions/subagent-widget.ts"]
    }
  ]
}
```

## Recommended sets

- **P2P team (terakael)**: `coms.ts`, `coms-net.ts`, `subagent-widget.ts`, `orchestrator.ts`
- **Orchestration (Mule)**: `agent-team.ts`, `agent-chain.ts`, `pi-pi.ts`
- Both sets coexist; no duplicate tool or command names.

## Usage

### coms (peer-to-peer)

- `coms_list`, `coms_send` tools: list agents in your pool, send prompts, await responses
- `coms_net_*` tools: same over the network (E2B/exe.dev sandboxes, other machines) via a Bun server
- `/coms` command: TUI pool view; `@agent` for direct interaction
- Spawn a named peer: `pi -e extensions/coms.ts --cname worker2 --project myteam`

### Subagent widget (terakael version)

- `/sub [--model provider/model] [--thinking low|medium|high|xhigh] <task>`, `/subcont <id>`, `/subrm <id>`, `/subclear`
- Spawns `pi --mode rpc` children in tmux (or headless via `PI_SUBAGENT_BACKEND=headless`), auto-joins them to the parent's coms pool
- LLM tools: `subagent_create`, `subagent_list`

### Agent team / chain (Mule version)

- `dispatch_agents` (plural, controlled concurrency), `read_agent_output` (offset/limit), `set_expert_model`
- Agents and teams from `.pi/agents/*.md`, `teams.yaml`, `agent-chain.yaml`
- `query_experts` (pi-pi) runs the expert panel from `.pi/agents/pi-pi/`

### Agents

Project-local agent definitions live in `.pi/agents/`. To use them, copy or symlink into your target project's `.pi/agents/` or `~/.pi/agent/agents/`.

## Safety

- `damage-control.ts` enforces `.pi/damage-control-rules.yaml` but does not cover subagent tool calls (upstream issue #24); subagents spawned by this set get explicit tool scoping instead
- Review the source before running third-party extension code

## Layout

- `extensions/` - 25 extension files (helpers: `naming.ts`, `lib/themeMap.ts`, `example-border-segment.ts` excluded from package loading)
- `.pi/` - agents, teams, chains, damage-control rules, skills, themes
- `specs/` - design docs (coms-net protocol, cascading-tree-ping, agent naming, etc.)
- `scripts/` - helpers
