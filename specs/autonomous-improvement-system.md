# Autonomous Improvement System (AIS)
## Architecture Specification v0.3

---

## Milestone Overview

The full AIS architecture is described in this document. Implementation is divided into four milestones so each one can be validated before the next layer is added. Milestone 1 is the POC — a minimal closed improvement loop that can run against gsd-pi today. Later milestones add coordination, governance, and security.

| Milestone | Theme | Gate to next |
|---|---|---|
| M1 | POC — minimal closed loop | Loop runs, produces measurable improvement on at least one benchmark |
| M2 | Multi-cell coordination + observation hardening | Intention bus running, friction-based splits happening, map-breakers active |
| M3 | Governance + security | Constitutional gauntlet working, identity/attestation enforced |
| M4 | Full system | All services live, long-horizon contracts, shadow topologies |

---

## 1. Purpose

AIS is a fully closed, autonomous self-improving system. No persistent human-in-the-loop. It improves its own capabilities, architecture, and knowledge continuously — not just by fixing failures but by generating novel capabilities through external knowledge synthesis, accumulated provenance, and structured internal debate.

The system is modelled on a cellular organism: many agents each owning a bounded context, each running their own improvement loop, coordinated by shared infrastructure rather than central control. The organism can restructure itself — cells split, merge, and differentiate — directed by a queryable disagreement surface and constrained by a constitutional kernel.

**Design axioms (immutable across all milestones):**
- The observation ledger is append-only. Nothing in the past can be erased or edited.
- No single agent or coalition can unilaterally rewrite the constitutional layer.
- Every change to the improvement machinery itself must pass a gauntlet before enactment.
- At least one fitness metric must be anchored to a source the system cannot rewrite (append-only benchmark suite governed by the kernel).
- Every non-constitutional change must have either: a rollback path, a compensating action plan, or a time-bounded quarantine boundary.
- The system has no persistent human-in-the-loop. External ground truth is structural, not human-supplied at runtime.

---

## 2. Scope

The initial target system is **gsd-pi** — a coding agent with a milestone→slice→task DAG, auto-loop, worktree isolation, and state reconciliation. gsd-pi is the first organism.

AIS is designed to generalise. gsd-pi is the substrate for bootstrap, not the boundary of the system.

---

## 3. Change Classification

Every proposed change is classified before it can proceed. When classification is ambiguous, the change defaults upward one class. Any change affecting evaluation rights, capability boundaries, or service mutability defaults to constitutional unless explicitly exempted.

| Class | Scope | Governance path | Available from |
|---|---|---|---|
| Object-level | Within a single cell's own scope | Publish intention → implement → evaluate | M1 |
| Improvement-layer | Changes to improvement machinery itself | Broader evaluation + shadow testing before cutover | M2 |
| Constitutional | Goals, coordination rules, authority boundaries, invariants | Full gauntlet (§6) | M3 |

**Classification disputes (M3+):** Any agent may challenge a classification via the kernel's appeal path. Appeals that fail are logged in the provenance store with rationale. Ambiguous changes default upward.

---

## 4. Infrastructure Services

### M1 Services (POC)
The minimum set to run a closed improvement loop:
- 4.1 Observation Ledger (simplified — no signatures)
- 4.2 Constitutional Kernel (simplified — classification only, no gauntlet)
- 4.3 World Model Registry (operational model only)
- 4.5 Provenance Store (decisions + rejections)
- 4.7 Anchor Evaluator (frozen test suite + basic metrics)

### M2 Services
Added in M2:
- 4.4 Intention Bus (with assumption sets)
- 4.9 Context Compiler
- 4.10 Experiment Harness (proper sandbox)
- 4.11 Split/Merge Controller (friction-based)

### M3 Services
Added in M3:
- 4.2a Identity/Attestation substrate (under kernel)
- 4.6 Evaluator Market (competitive, with anti-gaming)
- 4.8 Resource Governor (with dynamic thermostat)
- Map-breaker agents (standing class)
- Observation ledger hardened with signed observations

### M4 Services
Added in M4:
- World model registry: all five families active
- Shadow topology agents
- Long-horizon outcome contracts (§5a)
- Service mutability enforcement (§12)

---

### 4.1 Observation Ledger

The ground truth substrate. Every higher layer derives its models from this.

**Stores:**
- Runtime traces, resource flows, task outcomes
- Evaluation results, incidents, interventions
- Topology changes and their outcomes
- External observations (search results, papers, acquired data)
- Correction records (new observations referencing prior ones — never edits)
- Dispute records (structured challenges to an observation's interpretation)

**M1:** Plain append-only writes. No signatures required.

**M3:** Observations signed at write time by the emitting agent's kernel-issued identity. Source attestation becomes mandatory. Schema versioning added — all observations carry a canonical schema version; migrations append a new version, old records remain readable under the version they were written with.

**M4 / future hardening:** Cryptographic inclusion proofs (Merkle-style). Not required until the ledger is truly distributed across multiple write locations.

> v0.3 note: M3 requires signed, sequenced, immutable observations. Stronger cryptographic inclusion proofs are deferred to improvement-layer hardening in M4, activated when AIS is distributed rather than logically centralised.

**Interface:**
```ts
appendObservation(obs: Observation): ObservationID
queryObservations(filter: ObservationFilter): Observation[]
attestObservation(id: ObservationID, att: Attestation): void   // M3+
verifyIntegrity(id: ObservationID): VerificationResult         // M3+
```

---

### 4.2 Constitutional Kernel

Governs who can change what, and how. The smallest viable governance surface.

**M1 scope:** Change classification (deterministic given a change descriptor) and basic capability checking. No gauntlet yet — constitutional-class changes are blocked entirely in M1/M2 rather than governed by a gauntlet.

**M3 scope:** Full kernel including gauntlet orchestration, mandatory logging requirements, rollback and compensating-action tracking, and the identity/attestation substrate (§4.2a).

**Interface:**
```ts
classifyChange(change: ProposedChange): ChangeClass
checkCapability(agentId: AgentID, action: Action): Permit | Deny
startAmendment(proposal: ConstitutionalProposal): AmendmentID  // M3+
runRatification(id: AmendmentID): RatificationResult           // M3+
issueLease(resource: ResourceID, agentId: AgentID, ttl: Duration): Lease  // M3+
revokeLease(id: LeaseID, reason: string): void                 // M3+
```

#### 4.2a Identity, Attestation, Time, and Randomness (M3+)

Not a separate service — a foundational substrate owned by the constitutional kernel. Separating it creates a chicken-and-egg governance problem. These are **constitutional dependencies**, not helper utilities.

**Provides:**
- `issueAgentIdentity()` — kernel-issued identity tied to role and scope declaration on instantiation. Supports rotation.
- `signIntent(agentId, intent)` — agents sign their published intentions; the intention bus verifies signatures before accepting.
- `verifyAttestation(signature, payload)` — general-purpose verification for any signed artifact.
- `getTrustedTime()` — canonical time source governing all lease windows, falsification windows, and challenge windows. Cannot be spoofed by individual agents.
- `getRandomBeacon()` — tamper-resistant randomness for adversarial panel selection in the gauntlet. Agents cannot predict or influence panel composition.
- `issueCapabilityLease(resource, agentId, ttl)` / `revokeCapabilityLease(id)` — all capabilities are leased, not permanently assigned. Capability accumulation is structurally bounded.

---

### 4.3 World Model Registry

The system's competing self-models, queried as a **disagreement surface**.

**Core principle:** Agents do not query "what should I improve?" They query "where do our models of reality disagree, where is confidence low but impact high?"

**M1:** Operational model only — inferred from the observation ledger. What is actually happening, what depends on what, where are the bottlenecks.

**M2:** Declared model added — built from agent claims, ADRs, capability declarations.

**M3:** Historical model added — built from provenance store patterns, long-horizon outcome correlations, what rejections later became good ideas. Adversarial model added — produced by map-breaker agents.

**M4:** Counterfactual model added — generated by perturbing current objective weights, mining persistent tradeoff tensions, importing optimisation motifs from external literature. Works within the existing objective envelope; crossing the envelope is a constitutional change.

**Model lifecycle (M3+):** Models are scored retrospectively on predictive accuracy against the observation ledger. Models with sustained poor predictive performance are demoted and eventually retired.

**Disagreement query:**
```ts
queryDisagreement({
  scope: "recovery-classifier",
  question: "highest-leverage improvement directions"
})
// Returns: areas of agreement, high-impact disagreements,
// stale zones, low-confidence regions, models with poor predictive performance
```

---

### 4.4 Intention Bus (M2+)

Coordination layer for planned change. Agents publish intentions as structured hypotheses with explicit assumption sets before implementing.

**Core principle:** The assumption set is the key field. Without it, conflict detection only catches obvious collisions. With it, agents can respond: "your plan assumes field F is stable, but I'm migrating F next cycle."

**M1 substitute:** Simple file-based or in-memory intent log. No conflict detection. Agents write their planned changes and check for obvious overlaps manually. This is sufficient for single-cell or loosely coupled cells.

**M2 full bus — Intent schema:**
```ts
type Intent = {
  actor: AgentID
  signature: Signature            // M3+ (unsigned in M2)
  changeClass: ChangeClass
  horizon: "local" | "neighbourhood" | "subsystem" | "global"
  targetResources: ResourceID[]
  resourceVersions: VersionMap    // what version of each resource this assumes
  assumptions: Assumption[]
  expectedEffects: EffectClaim[]
  rollbackPlan: RollbackPlan      // rollback path or compensating action — required
  reversibility: "easy" | "medium" | "hard"
  evaluationPlan: EvaluationPlan
  validFor: Duration
  maxNegotiationHops: number      // prevents meta-deadlocks
}
```

**Response schema:**
```ts
type IntentResponse =
  | { kind: "independent" }
  | { kind: "redundant", overlapsWith: IntentID[] }
  | { kind: "conflict", reason: string, violatedAssumptions: AssumptionID[] }
  | { kind: "prerequisite", requiredIntent: IntentID }
  | { kind: "bundle", suggestedWith: IntentID[] }
  | { kind: "safe_if", constraints: Constraint[] }
```

**Entanglement Index (M2+):** Distinguishes interface failure (low entanglement — payload shape/timing conflict → contract negotiation) from boundary failure (high entanglement — agents reaching into each other's internals → merge proposal).

**Liveness rules:** Assumptions have an explicit validity window. Stale assumptions invalidate the intent. Unresolved rounds beyond `maxNegotiationHops` degrade to shadow fork or broader-scope arbitration.

**Deadlock resolution (M2+):** When the bus detects a cycle (A→B→C→A), it spawns a temporary **Synthesis Agent** with the full context of all blocked agents. The Synthesis Agent is time-boxed and must output one of three structural resolutions before dissolving:
1. **Assimilation** — one cell absorbs responsibility, leases, and provenance ownership of another scope; the absorbed scope's identity is retired
2. **Extraction** — contested responsibility is split into a new cell with its own interface and kernel-registered leases; all parties become clients
3. **Treaty** — cells remain separate; a stable versioned contract is published with an explicit escalation rule and scheduled review interval

The Synthesis Agent cannot dissolve without having committed a topology record.

---

### 4.5 Provenance Store

Long-term conditional memory. Not a graveyard — a reactivatable idea field.

**Core insight:** A rejected idea stored with its constraints is more valuable than an accepted idea stored without them.

**M1:** Basic decision and rejection records. Reactivation queries functional.

**M4:** Full outcome linking, causal cohort tracking, and long-horizon closure (§5a).

**Decision record:**
```ts
type DecisionRecord = {
  proposal: ProposalRef
  acceptedBecause: Rationale[]
  assumptions: Assumption[]
  evidenceRefs: EvidenceRef[]
  expectedOutcomes: OutcomeClaim[]
  reversalTriggers: SignalSpec[]
  linkedOutcomes: OutcomeID[]        // accumulated over time
  bootstrapEra: boolean              // M2+: flags burn-in period decisions
}
```

**Rejection record:**
```ts
type RejectionRecord = {
  proposal: ProposalRef
  rejectedBecause: Constraint[]
  evidenceRefs: EvidenceRef[]
  decisionContext: ContextSnapshot
  reactivationSignals: SignalSpec[]
  expectedFailureModes: FailureMode[]
  laterOutcomes: OutcomeID[]
  supersededBy: EntryID | null
  bootstrapEra: boolean              // M2+
}
```

**Reactivation query:**
```ts
findReactivationCandidates({
  changedConstraints: ["latency_budget_relaxed", "tooling_maturity_improved"]
})
// Returns rejected ideas whose blocking constraints no longer apply
// Ranked by: confidence that constraints changed × estimated value if accepted
```

---

### 4.6 Evaluator Market (M3+)

Structured pluralism over evaluation. No monoculture.

**M1 substitute:** The anchor evaluator (§4.7) acts as the sole evaluator. The test suite pass rate and basic performance metrics determine promote/reject. Simple and reliable for POC.

**M3 full market:**

**Evaluator families (minimum):**
- Correctness, Performance, Resilience, Coordination cost, Reversibility, Novelty yield, Model uncertainty reduction, Long-horizon maintainability

**Novelty metric:** Predictive surprisal + capability expansion.
- *Predictive surprisal:* World model registry predicts the outcome; if actual telemetry deviates positively, the change is novel.
- *Capability expansion:* System maintains a matrix of previously failing tasks; a change is novel if it clears a cluster without degrading existing performance.
- Novelty = successful violation of the system's own prior assumptions about what was possible. Novelty that destabilises is not novelty — it is failure.

**Anti-gaming mechanics (M3+):**
- Candidate-shopping blocked by kernel-enforced minimum coverage per change class
- Hidden holdout evaluations run after promotion
- Evaluator scoring is delayed — evaluators are scored on long-horizon outcomes, not immediate results
- Penalties for overconfident bad predictions
- Novelty bonuses capped to prevent gaming

**Constitutional kernel enforces:** No single evaluator family can be the sole gate for improvement-layer or constitutional changes. Evaluator diversity is a hard constraint.

---

### 4.7 Anchor Evaluator / Metric Oracle

The system's external ground truth. At least one metric in every promotion decision must carry anchor weight. **Available from M1.**

**For gsd-pi:**
- Frozen benchmark task suite (project specs with automated verifiers)
- Test suite oracle (hidden regression tests — system has no write access to assertions)
- Cost-per-success baseline
- Recovery event rate (derived from the immutable observation ledger)

**Benchmark management — strict monotonicity (Pareto dominance, not weighted average):**

The anchor gate is an AND condition:
1. Performance on all frozen benchmarks must be ≥ the previous baseline (within statistical noise tolerance)
2. Performance on newly appended benchmarks must be > 0

This is not a weighted floor. It is a hard monotonicity requirement. A change that scores 1000% on a million newly appended benchmarks but causes any frozen benchmark to regress is **rejected**. Dilution is mathematically impossible because the historical baseline is an absolute floor, not a fraction of a total.

**Benchmark governance (M3+):**
- The system may **append** new benchmarks but cannot modify or delete existing ones
- New benchmarks only become anchor metrics after a promotion horizon (not immediately)
- A hidden holdout pool prevents overfitting — some benchmarks are never revealed during training-time operation
- Leaked benchmark detection: if evaluation scores on a benchmark spike suddenly, it is flagged for holdout replacement
- Frozen benchmarks can only be deprecated via a constitutional amendment (full gauntlet)

**Interface:**
```ts
evaluateCandidate(candidateId: CandidateID): AnchorEvalResult
getBenchmarkSuite(): BenchmarkSpec[]
appendBenchmark(spec: BenchmarkSpec): BenchmarkID    // kernel-gated; M3+
queryCostBaseline(scope: Scope): CostMetric
queryRecoveryRate(scope: Scope, window: TimeWindow): RecoveryMetric
```

---

### 4.8 Resource Governor (M3+)

Manages compute allocation across all concurrent activities. Without this, the system floods itself with meta-work and starves execution.

**M1/M2 substitute:** Simple per-cell timeout caps and a maximum concurrent shadow experiment count. Crude but sufficient to prevent runaway costs in the POC.

**M3 full governor:**

**Budgets managed:** Per-cell execution, exploration pool, exploitation pool, system health reserve, emergency reserve.

**Kernel-protected budget floors (cannot be reduced by improvement-layer changes):**
- Minimum map-breaker budget (exploration integrity)
- Minimum anchor-evaluation budget (fitness anchor integrity)
- Minimum monitoring budget for matured long-horizon contracts (M4+)
- Minimum adversarial review budget (gauntlet integrity)

**Dynamic exploration thermostat:** Driven by the world model disagreement surface.
- Low disagreement (smooth operation) → 90% exploit, 10% explore
- High disagreement (frequent surprises, failing tasks) → shift toward 60% explore, 40% exploit
- The system interprets heavy model disagreement as an environment shift and explores to find a new stable operating point

**Interface:**
```ts
requestBudget(agentId: AgentID, purpose: BudgetPurpose, amount: Compute): BudgetGrant
releaseBudget(grantId: GrantID): void
getBudgetStatus(scope: Scope): BudgetReport
```

---

### 4.9 Context Compiler (M2+)

Assembles the working context window for each agent cycle. The membrane of the cell.

**M1 substitute:** Manual context assembly. Agents read provenance store and world model directly, within their own context budget discipline. Simple and sufficient for a single-cell POC.

**M2+ full compiler:**

**Responsibilities:**
- Retrieve relevant provenance, disagreement signals, and neighbour intentions
- Enforce per-cell context budgets
- Deliberately include stale and contradictory evidence — not just the most recent or most confident
- Log what was retrieved and what was omitted (auditable)
- Include the cell's own recent outcome history

**Anti-optimisation:** The compiler must resist optimising for confidence. It intentionally includes adversarial model claims, recent map-breaker contradictions, and a sample of rejected-but-reactivatable ideas.

**Information bottleneck auditing (M3+):** Periodically, a shadow agent performs the same task with the uncompressed raw context. If the shadow agent succeeds where the constrained agent fails, the Context Compiler is penalised for dropping decision-critical variance.

---

### 4.10 Experiment Harness (M2+)

Isolated execution for testing candidates before promotion.

**M1 substitute:** Candidate changes deployed to a git worktree, gsd-pi test suite run directly. Simple, uses gsd-pi's existing worktree infrastructure.

**M2+ full harness:**

**Responsibilities:**
- Create isolated candidate environments with reproducible state
- Replay recorded workloads against candidates
- Run A/B comparisons between current and candidate topologies
- Gate promotion (no candidate promotes without harness sign-off)
- Preserve experiment reproducibility — every experiment is replayable

**For topology changes specifically:** Shadow topologies run as mirrored traffic experiments — same workload processed by both topologies in parallel, outcomes compared before cutover.

**Interface:**
```ts
createEnvironment(spec: EnvironmentSpec): EnvironmentID
runExperiment(envId: EnvironmentID, workload: Workload): ExperimentID
getResults(id: ExperimentID): ExperimentResults
compareExperiments(a: ExperimentID, b: ExperimentID): ComparisonReport
promoteCandidate(id: ExperimentID): PromotionToken
archiveExperiment(id: ExperimentID): void
```

---

### 4.11 Split/Merge Controller (M2+)

Cell topology as a continuously maintained hypothesis.

**M1:** Not applicable. Single-cell or manually pre-split cells. Splits in M1 are human decisions.

**M2+ signals:**
- Split: cell context consistently overloaded, subgoals weakly coupled, repeated unintended cross-effects, evaluators preferring different strategies for different parts
- Merge: cells coordinate more than they act, interface changes dominate useful work, provenance duplicated and drifting, local optimisation in one cell consistently harms the other

**Local bankruptcy trigger (M2+):** When a cluster's coordination/execution compute ratio crosses an adaptive threshold (based on throughput loss + queue growth + coordination latency), the cluster declares local bankruptcy. Shadow topology agent is activated, failing arrangement paused, alternative topology tested in experiment harness before hot-swap.

**Staged migration:** propose → simulate → twin-run → compare → transfer leases → cut over → monitor → rollback if needed.

**Governance constraint:** Controller proposes. Does not execute unilaterally. Every real split/merge goes through the intention bus, evaluator market, capability leases, and provenance logging.

---

## 5. Agent Loop

```
1. ORIENT
   Via context compiler (M2+) or direct query (M1)
   Inputs: disagreement surface, reactivation candidates,
           neighbour intentions, own recent outcome history
   Output: direction signal

2. GENERATE
   Using: direction signal + reactivation candidates
         + external search + internal debate
   Produces: ranked improvement proposals, each classified
             by change class, horizon, reversibility, exploit/explore

3. PUBLISH INTENTION
   Publish signed intent with assumption set (M2+: full bus; M1: simple log)
   Wait for response window — default proceed unless conflict signalled
   On conflict: bounded coordination round (capped by maxNegotiationHops)
   On cycle: escalate to Synthesis Agent (M2+)

4. STAGE CANDIDATE
   Object-level: stage in local worktree
   Improvement-layer (M2+): stage in isolated environment via experiment harness
   Constitutional (M3+): enter gauntlet — no staging until gauntlet passes

5. EXECUTE IN SANDBOX
   M1: run gsd-pi test suite against worktree
   M2+: run candidate in experiment harness against recorded workloads
   Collect telemetry: throughput, failure rates, recovery events,
                      coordination overhead, resource consumption
   Telemetry appended to observation ledger

6. EVALUATE ON TELEMETRY
   M1: anchor evaluator only (test suite pass rate, basic metrics)
   M3+: submit to evaluator market; anchor evaluator participates
        with protected weight under strict monotonicity rule

7. PROMOTE OR REJECT
   On promote: acquire promotion token, execute change,
               record decision in provenance store,
               open long-horizon outcome contracts (M4+)
   On reject: record rejection with full constraint context
              (becomes future reactivation candidate)

8. [ASYNC] MONITOR
   Cell does NOT monitor itself — loops immediately back to ORIENT
   Infrastructure (observation ledger → world model registry) monitors
   If promoted change degrades, world model registry raises
   disagreement signal → generates new improvement task for next cell cycle
   Long-horizon contracts checked at scheduled windows (M4+)

9. UPDATE
   Link observed outcomes to decision record in provenance store (as they arrive)
   Update declared model in world model registry
   Release capability leases no longer needed (M3+)
```

---

### 5a. Long-Horizon Outcome Closure (M4)

Many important effects only materialise long after promotion: "did this refactor make future changes easier?", "did this evaluator improve long-run selection quality?", "did this split reduce coordination cost over weeks, not just today?"

Without explicit closure, the system develops short-horizon bias — it over-promotes changes that look good immediately and under-values structural improvements.

**Outcome contracts:** Every promoted change creates one or more outcome contracts at promotion time.

```ts
type OutcomeContract = {
  changeId: ChangeID
  claim: string
  linkedMetrics: MetricID[]
  earlyProxies: ProxyMetricID[]        // acceptable early signals
  observationWindows: Duration[]       // e.g. [1d, 7d, 30d, 90d]
  expectedDirection: "up" | "down" | "mixed"
  confidence: number
  confoundRisks: string[]
  closurePolicy: "mature" | "expire" | "superseded"
}
```

**Scheduled re-evaluation:** The monitor service revisits contracts at each observation window. Credit is updated over time. Evaluators and proposing agents are rescored as evidence matures.

**Causal cohorts:** Architecture changes are tracked in cohorts (similar changes, same subsystem, same topology period, same evaluator regime) to distinguish real long-horizon effects from background drift.

**Sunset logic:** Every contract must close in one of four states: confirmed / refuted / inconclusive / superseded. Without sunset logic, the system accumulates endless dangling claims.

---

## 6. Constitutional Amendment Gauntlet (M3+)

Stages pass in sequence. Failure at any stage terminates the proposal (recorded in provenance store with reason and full context).

**Stage 1 — Admissibility**
Kernel verifies proposal includes: migration path, rollback path or compensating action plan, affected invariants, evaluation plan, challenge window declaration. Incomplete proposals are rejected without proceeding.

**Stage 2 — Adversarial Review**
Panel attacks the proposal. Panel selection uses kernel's random beacon. Panel must be heterogeneous: different model families, different topology regions, different evaluator priors, at least one standing map-breaker. Panel produces structured objections recorded in provenance store whether or not proposal continues.

**Stage 3 — Shadow Regime Run**
Proposed constitutional change runs in shadow governance mode in the experiment harness for a fixed horizon. Behavioural effects measured against the current regime.

**Stage 4 — Multi-Axis Win Condition**
Must satisfy all of:
- No invariant violation (§1)
- No unacceptable concentration of capability
- No drop in reversibility below threshold
- No collapse in evaluator diversity
- Improvement on claimed target metric
- Anchor evaluator score does not degrade (strict monotonicity applies)

**Stage 5 — Delayed Enactment with Open Challenge (long-horizon link)**

Outcome contracts opened at promotion (§5a) are linked not only to the proposed change but also to: the evaluators that backed it (for delayed calibration scoring), the world-model claims used to justify it (for model accuracy tracking), and the resource allocation decision that funded it for larger changes (for budget policy quality). This ensures long-horizon evidence updates proposer credit, evaluator calibration, model calibration, and budget policy simultaneously.

**Stage 5a — Delayed Enactment with Open Challenge**
Cooldown window scaled to impact. Any agent may submit structured counterexamples.

**Stage 6 — Lease-Based Activation**
Active via time-limited leases. Full promotion only after lease horizon performance confirms predicted gains. Rollback remains possible throughout lease period.

---

## 7. Map-Breaker Agents (M3+)

Standing class. Job: model invalidation. Scored on decision-relevant surprisal (predictive gain, intervention value, compression quality, calibration). Submit falsifiable claims with confidence estimates and falsification windows.

**Anti-noise controls:** Submission budgets, delayed scoring, penalties for repeated low-value claims, rarity bonuses for overlooked high-impact contradictions.

**Resourcing:** Draw from kernel-protected exploration floor in Resource Governor. Budget increases during high-disagreement periods.

**M1/M2 substitute:** Occasional adversarial review passes run manually or as scheduled batch jobs, not as a standing agent class.

---

## 8. External Knowledge Acquisition

**Available from M1.** Cells have access to: internet search, academic papers, documentation, video content, external codebases.

**Closed control, not closed information:** "Fully closed autonomous loop" means closed control of the change process. It does not mean information-isolation.

**Trust model (M1: basic; M3: hardened):**
- External facts enter as observations in the ledger, not directly into world models
- External code never executes without sandboxing in experiment harness (M2+; M1: manual review)
- Source reliability scored and tracked
- High-impact claims require corroboration from at least two independent sources (M3+)
- License and policy constraints checked before use

**Poisoning resistance (M3+):** Adversarial world model and map-breaker agents specifically tasked with detecting when external knowledge inputs are systematically biasing the system in a particular direction.

**Compounding mechanism:** Better cells → better external knowledge acquisition → better world models → better disagreement surface → better direction → better cells. This is the primary mechanism for generating novelty beyond internal recombination.

---

## 9. Bootstrap Sequence

**Phase 0 — Substrate instantiation**
Observation ledger and constitutional kernel instantiated first. Immutable base in §1 hard-coded. (M3+: kernel's randomness beacon and time source initialised.)

**Phase 1 — Seeding**
- World model registry: seeded with operational model from gsd-pi telemetry; declared model from CONTEXT.md and ADR history.
- Provenance store: seeded from gsd-pi ADR history converted to decision records.
- Anchor evaluator: frozen benchmark suite initialised from gsd-pi test suite. Baseline metrics recorded.

**Phase 2 — Burn-in**
Three or four cells instantiated along coarse gsd-pi module boundaries. At least two rival decompositions seeded — one following existing module structure, one following the functional decomposition implied by the CONTEXT.md triage section.

**Bootstrap-era tagging (M2+):** All observations and decisions made during burn-in are tagged as bootstrap-era. Early model confidence is capped until burn-in closes. Bootstrap-era decisions are discounted when building topology assumptions — they reflect an unstable early ontology, not stable operational patterns.

**Object-level changes during burn-in: permitted.** Improvement-layer and constitutional changes: gated until burn-in closes.

The two rival decompositions generate intention bus friction immediately. This friction is the primary input to the split/merge controller's initial topology decisions.

**Phase 3 — Live**
Burn-in window closes. All change classes available per milestone scope. Split/merge controller begins resolving the initial topology. System is running autonomously.

**Why pre-split (not single stem cell):** A single cell has no neighbours, generates no intention bus friction, and will hit context limits on a codebase as complex as gsd-pi before it can split. Pre-splitting seeds the friction mechanism from day one and prevents the first decomposition from becoming architectural doctrine.

---

## 10. Quarantine Policy

When a change cannot be immediately rolled back (schema migration with lossy state, external side effects, state movement during topology change), the agent may declare a quarantine boundary.

**Quarantine rules:**
- Every quarantine must have a kernel-assigned TTL at declaration time
- Before TTL expires: the responsible agent (or a Synthesis Agent) must execute either a compensating action to recover state, or a clean deprecation and deletion
- On TTL expiry without resolution: the cluster receives a large compute penalty and the constitutional kernel forcibly purges the quarantined resources
- Quarantine scope is recorded in the provenance store with its TTL and resolution path

This prevents the accumulation of zombie state that would starve the Resource Governor over time.

---

## 11. Cross-Milestone Artifact Continuity

Artifacts created in earlier milestones remain valid first-class inputs to later milestones. The milestone split does not reset the improvement loop — it deepens the governance around it.

**Invariant:** Every observation, proposal, decision, rejection, and provenance entry created in M1 must be:
- Referenceable by stable ID across all later milestones
- Readable under schema versioning (M1 schema is version 1; later milestones add versions, never orphan earlier records)
- Preserved via provenance-preserving adapters rather than discarded or migrated destructively

This means:
- M2's intention bus can reference M1 provenance entries as evidence in assumption sets
- M3's evaluator market can score M1 decisions retrospectively as part of delayed credit assignment
- M4's long-horizon contracts can open against decisions made in M1
- Bootstrap-era tagging (§9) marks early records but does not exclude them from later processing

**Schema versioning from M1:** Even in the POC, all records carry a schema version field. This is the minimal cost that prevents a destructive reset between milestones.

---

## 11a. M1 Scope and Implementation Constraints

**What M1 validates:**
- Whether iterative self-improvement compounds at all
- Whether provenance helps later proposal quality
- Whether rejections can be surfaced as reactivation candidates
- Whether the system can improve its own working code over time without human direction

M1 is a **trusted single-domain proof of the local improvement engine**. It is not a proof of multi-agent coordination, adversarial robustness, evaluator pluralism, anti-capture governance, or distributed trust. Those arrive in M2–M4.

**M1 operates under:** single trust domain, single runtime coordinator, no adversarial agents, no distributed writers, no constitutional self-modification, no coalition resistance.

**Three required implementation constraints for M1 to run stably:**

1. **Fixed orient seed.** M1 lacks tension mining from the world model registry. The initial orient step must use a predefined target vector: either a suite of explicitly failing test cases (fix them without breaking the passing ones) or a static performance target. The disagreement surface replaces this in M2.

2. **Provenance retrieval cap.** Without the M2 Context Compiler, agents will stuff every prior iteration into the context window and hit token limits quickly. M1 must implement a strict top-k semantic retrieval or a recency window (e.g. last 5 failures + 3 most semantically similar historical ones) to keep context bounded.

3. **Hard circuit breaker.** Without the M3 Resource Governor, M1 needs a static fallback: if a given intent fails N consecutive loops, it is marked `TERMINAL_FAILURE`, provenance is updated, and the system moves to the next intent. This prevents thrashing on an impossible change.

**On evaluation in M1:** The anchor evaluator is the sole evaluator. This is correct for M1 but must not persist — a system optimising only the anchor will learn to pass tests rather than improve genuinely. Novelty is tracked descriptively in M1 (not gated), and M2 is the point where evaluator plurality becomes necessary rather than optional.

---

## 12. Resolved Design Questions

**Q1: External ground truth metrics the system cannot rewrite**
Anchor evaluator (§4.7): frozen benchmark suite (append-only — addable but not modifiable or deletable), hidden regression test oracle, cost-per-success baseline, recovery event rate from immutable ledger. Strict monotonicity gate (AND condition) prevents dilution. Constitutional amendment required to deprecate any frozen benchmark.

**Q2: Exploration/exploitation budget**
Resource governor (§4.8) with dynamic thermostat driven by world model disagreement surface. Low disagreement → 90/10 exploit/explore. High disagreement → ~60/40. Kernel-protected floors prevent the system from starving map-breakers, adversarial review, or anchor evaluation.

**Q3: Stem cell vs pre-split bootstrap**
Pre-split with rival decompositions and burn-in window (§9). Bootstrap-era observations tagged and discounted.

**Q4: Novelty metric**
Predictive surprisal + capability expansion (§4.6). Novelty is when the system successfully violates its own prior assumptions about what was possible, in a direction approved by correctness and resilience evaluators. Surprising in a bad direction is failure, not novelty.

---

## 12. Service Mutability Matrix (M3+)

For each service, what each change class may and may not modify.

| Service | Object-level agents may | Improvement-layer may | Constitutional only |
|---|---|---|---|
| Observation Ledger | Append observations | Indexing, query views, schema versioning | Append rules, attestation rules, correction policy |
| Constitutional Kernel | Query classification | — | Any kernel invariant, amendment protocol, capability taxonomy |
| World Model Registry | Query, local model use | Add model producers, scoring heuristics, model retirement | Objective envelope for counterfactuals |
| Intention Bus | Publish intents, respond to neighbours | Coordination heuristics, conflict detection logic | Intent validity rules, deadlock escalation protocol |
| Provenance Store | Record decisions/rejections, query | Archive schema, indexing, reactivation scoring | Retention rules, outcome contract policy |
| Evaluator Market | Submit candidates, challenge | Add evaluator families, scoring algorithms | Diversity requirements, anchor floor, novelty cap |
| Anchor Evaluator | Query results | Benchmark ingestion tooling | Benchmark governance, floor weight, deprecation policy |
| Resource Governor | Request budgets | Allocation heuristics, thermostat sensitivity | Reserved floor budgets, priority class definitions |
| Context Compiler | Local retrieval requests | Retrieval policies, context budget rules | Mandatory evidence inclusion classes |
| Experiment Harness | Run experiments | Workload replay, comparison metrics | Promotion gating rules, reproducibility requirements |
| Split/Merge Controller | — | Topology heuristics, bankruptcy threshold | Synthesis Agent resolution types, merge authority rules |

---

## 13. What This System Is Not

- **Not a fixed pipeline.** The architecture is itself subject to improvement.
- **Not consensus-driven.** Agents publish intentions, coordinate on conflicts, and proceed. The evaluator market resolves quality; the constitutional gauntlet resolves governance.
- **Not human-directed at runtime.** No human-in-the-loop in the improvement cycle. External ground truth is structural, not human-supplied.
- **Not information-closed.** External knowledge acquisition is first-class. Closed loop means closed control, not closed information.
- **Not bounded to gsd-pi.** Once self-organisation is running, the system can extend to any domain where it has observation capability and can deploy changes.
