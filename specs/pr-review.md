# Specification: PR Review Extension (`pr-review.ts`)

## 1. Overview

**PR Review** is a Pi extension that runs an automated, multi-model peer review on a Git
branch. Before any review work starts, a dedicated context agent investigates the PR —
reading the Jira ticket, Confluence spec, diff stat, and commit log — and writes a
`CONTEXT.md` file. Then, for each review aspect (security, DRY, SRP, etc.) two AI agents
running different models are spawned in side-by-side tmux panes. They investigate the diff
independently, then debate findings over coms (Pi's P2P Unix socket messaging layer).
A final synthesis pass compiles everything into a single review document.

The goal is adversarial review: two agents on different models catching things one would
miss, fact-checking each other's claims, and being forced to commit to a position on paper.

## 2. Architecture

```
Orchestrator (pr-review.ts)
│
├── runContextAgent()        → spawns Pi subprocess, writes CONTEXT.md + sentinel
├── scanAspects()            → .claude/agents/*-agent.md (searches one level deep)
│
├── for each aspect:
│   ├── spawnPairInTmux()
│   │   ├── pane A  →  pi --model rakuten-bedrock/claude-sonnet-4-6  [driver]
│   │   └── pane B  →  pi --model rakuten-codex/gpt-5.4             [analyst]
│   │
│   └── waitForAgents() → polls ~/.pi/coms/projects/pr-review-{aspect}/agents/
│
├── pollSentinels()          → watches .done/{aspect} files
│
└── runSynthesis()           → compiles findings/ into REVIEW.md
```

The context agent runs and completes before any pair is spawned. Every pair agent receives
the `CONTEXT.md` path in its system prompt and is told to read it before investigating.

## 3. Invocation

```bash
pi -e extensions/coms.ts -e extensions/pr-review.ts \
   --cname pr-orchestrator --project pr-review
```

Then from the Pi chat:

```
review_pr({ ticket: "4876", agents_root: "/path/to/pr-review/master" })
```

`agents_root` is the directory that contains (or has a subdirectory containing)
`.claude/agents/`. It defaults to `cwd` if omitted.

## 4. Tool Parameters

| Parameter      | Required | Default                                        | Description                                          |
|----------------|----------|------------------------------------------------|------------------------------------------------------|
| `ticket`       | yes      | —                                              | Worktree subdirectory name under `cwd` (e.g. `4876`) |
| `agents_root`  | no       | `cwd`                                          | Dir containing (or parent of) `.claude/agents/`      |
| `reviews_root` | no       | sibling of worktree parent, e.g. `.../reviews` | Where output directories are written                 |
| `aspects`      | no       | all                                            | Limit by short name, e.g. `["dry", "srp"]`           |

## 5. Aspect Definitions

Aspects are discovered by scanning for `*-agent.md` files under `{agents_root}/.claude/agents/`.
If that exact path doesn't exist, `scanAspects` searches one level of subdirectories, so
passing a parent like `/pr-review/master` still finds agents in `airflow-dags-v2/.claude/agents/`.

Each agent file must have frontmatter with at least `name`. The `-agent` suffix is stripped
from the filename to produce the short name: `dry-agent.md` → short name `dry`.

The existing agents in `airflow-dags-v2`:

| Short name      | Focus                                      |
|-----------------|--------------------------------------------|
| `abstractions`  | Unnecessary abstraction, over-engineering  |
| `airflow-api`   | Correct Airflow API usage                  |
| `deprecated-api`| Deprecated Airflow / Python APIs           |
| `dry`           | Code duplication                           |
| `process`       | Process and workflow correctness           |
| `robustness`    | Error handling, fault tolerance            |
| `security`      | Security and secrets                       |
| `srp`           | Single responsibility                      |
| `testing`       | Test coverage and correctness              |
| `type-safety`   | Type annotations and safety                |
| `yagni`         | Premature complexity                       |

## 6. Context Gathering

Before any pair spawns, `runContextAgent` runs as a dedicated step. It:

1. Mechanically gathers a seed: branch name, `git log development..HEAD --oneline`,
   `git diff development...HEAD --stat`, and the PR description from Bitbucket REST
   (`BITBUCKET_BEARER_TOKEN` env var).
2. Spawns a Pi subprocess (`pi --no-extensions -p --mode json`) with the seed and
   instructions to follow all links — Jira ticket, Confluence spec pages, child pages.
3. The subprocess writes `CONTEXT.md` to `{outdir}/` and touches `.context-done` when done.
4. The orchestrator polls for `CONTEXT.md` or `.context-done` every 2 seconds. Once found,
   the subprocess is killed and the review continues.
5. If no `CONTEXT.md` is written within 10 minutes, the subprocess is killed and the seed
   data is written as a fallback so pairs are never left with nothing.

Progress is streamed back as `onUpdate` messages showing each tool call the context agent makes.

Diagnostic log: `/var/folders/.../T/pr-review-context.log` (exact path: `os.tmpdir()/pr-review-context.log`).
Prompt written to: `{outdir}/context-agent-prompt.txt` for inspection.

## 7. Pair Agent Roles

The two models play asymmetric roles to avoid a coms deadlock:

**Agent A — Driver (Claude Sonnet)**
- Owns the conversation and the findings file.
- Investigates the diff, then opens the debate with `coms_send` + `coms_await`.
- Sends as many rounds as needed; challenges Agent B's claims.
- Writes the findings file and sentinel when satisfied.

**Agent B — Analyst (GPT-5.4)**
- Responds only — never initiates contact.
- When a message arrives from Agent A it triggers a new turn automatically. Agent B
  investigates, produces its analysis as plain text, and stops. The response is sent back
  automatically by coms when the turn ends (`agent_end` hook).
- **Does not call `coms_send`, `coms_list`, or `coms_await`** under any circumstances.
  Doing so would deadlock: both agents would be stuck in `coms_await` simultaneously,
  and the `agent_end` auto-reply would never fire.

Each pair is registered under its own coms project (`pr-review-{aspect}`) so `coms_list`
only ever shows one peer — the designated partner. Using `project="*"` is explicitly
forbidden in both system prompts.

## 8. System Prompt Structure

Each agent's system prompt (written to a temp `.md` file and passed via `--append-system-prompt`) contains:

1. **Domain expertise** — body of the aspect's `.md` file (frontmatter stripped)
2. **Collaboration rules** — investigate claims yourself, push back with specific evidence,
   don't concede without reason, document genuine disagreements
3. **What to review** — working directory, `development...HEAD` diff range, starting command
4. **Context** — path to `CONTEXT.md` with instruction to read it before investigating
5. **Findings template** — exact format to write, path to write to, sentinel to create
6. **Role section** — driver vs analyst instructions (distinct per agent)

## 9. Findings Format

Agent A writes to `findings/{aspect}-findings.md` when the conversation is complete:

```markdown
# {Aspect} Findings

**Pair:** claude-sonnet-4-6 (A) x gpt-5.4 (B)
**Status:** CONSENSUS | AGREE_TO_DISAGREE

---

## Findings

### N. Short title

**File:** `path/to/file.py:line` (or N/A)
**Severity:** BLOCKER | MAJOR | MINOR | INFO
**Agreed by:** Both | A only | B only

Description of the issue — the what and the why.

**Suggested fix:** What to change.

---

## Disagreements

### Topic

**A:** A's position.
**B:** B's position.
**Evidence examined:** What files/lines each checked.
**Unresolved because:** The root of the disagreement.

---

## Notes

Contextually useful observations that don't rise to a finding.
```

After writing, Agent A creates `{sentinelDir}/{aspect}` to signal completion.

## 10. Output Layout

```
{reviews_root}/
└── {ticket}/
    └── {head-hash-12}/
        ├── CONTEXT.md                    ← written by context agent
        ├── .context-done                 ← context agent sentinel
        ├── context-agent-prompt.txt      ← prompt sent to context agent (inspectable)
        ├── .done/
        │   ├── dry                       ← pair sentinel (presence = pair done)
        │   └── srp
        ├── findings/
        │   ├── dry-findings.md
        │   └── srp-findings.md
        └── REVIEW.md                     ← synthesized final document
```

`reviews_root` defaults to two levels up from the worktree + `/reviews`. For a worktree
at `.../FPBS/gcp-composer-resources/4876`, reviews land at `.../FPBS/reviews/4876/{hash}/`.

## 11. Synthesis

Once all pairs complete (or timeout), the orchestrator spawns a Pi subprocess in batch
mode using the orchestrator's own model. It reads all `findings/*.md` files plus
`CONTEXT.md` and compiles them into `REVIEW.md`, deduplicating findings across aspects,
ordering by severity, and preserving all `AGREE_TO_DISAGREE` items.

## 12. Timeouts and Error Handling

| Stage              | Timeout    | Behaviour on expiry                              |
|--------------------|------------|--------------------------------------------------|
| Context agent      | 10 minutes | Killed; seed data written as fallback CONTEXT.md |
| Agent registration | 2 minutes  | Pair marked `error: registration timeout`        |
| Pair discussion    | 45 minutes | Pair marked `error: timeout`; others continue    |

Errored pairs are shown in the widget but don't block synthesis.

## 13. Widget

A status widget below the editor shows live pair progress:

```
 PR Review   2/4 done  1 discussing

 v dry              done  142s
 v srp              done  187s
 * security         discussing  94s
 o yagni            pending
```

Updates every 5 seconds while pairs are running.

## 14. Models

| Role        | Default model                                    | Override env var          |
|-------------|--------------------------------------------------|---------------------------|
| Agent A     | `rakuten-bedrock/us.anthropic.claude-sonnet-4-6` | `PR_REVIEW_MODEL_A`       |
| Agent B     | `rakuten-codex/gpt-5.4`                          | `PR_REVIEW_MODEL_B`       |
| Context     | orchestrator's own model                         | —                         |
| Synthesis   | orchestrator's own model                         | —                         |

## 15. Dependencies

- **coms.ts** — must be loaded alongside this extension (`-e coms.ts -e pr-review.ts`).
  Provides inter-agent messaging to spawned pair agents.
- **tmux** — must be running. New windows open in the current session.
- **`jira` CLI** — used by context agent to fetch ticket details. Outputs JSON.
- **`confluence` CLI** — used by context agent. Writes XML to `/tmp/confluence/{id}/page.xml`.
- **`BITBUCKET_BEARER_TOKEN`** — env var for PR description fetch. Optional but recommended.
- **`git`** — used by both context agent and pair agents in the worktree.

## 16. Known Limitations

- **Driver-only findings.** Only Agent A (Claude) writes the findings file. If Claude
  stalls or produces poor analysis, Agent B's (GPT's) perspective may be underweighted.
- **No mid-debate tool sharing.** Agents investigate independently and share findings
  via text. They can't pass file contents directly — each agent reads the code itself.
- **Synthesis quality.** The synthesis agent only sees findings files, not discussion
  transcripts. Nuance from the debate may not carry through.
- **tmux window name collisions.** Window names are `pr-{aspect}`. Running two reviews
  in parallel against the same aspects will collide.
- **Context agent subprocess lingers.** Pi doesn't always exit cleanly after `-p` mode.
  The sentinel poller kills it once CONTEXT.md appears, but the process may remain briefly.
