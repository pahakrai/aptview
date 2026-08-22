# A/B Experiment Strategy

This document explains **what** the A/B experiment layer tests, **how** it
scores the results, and — most importantly — **why** each design decision was
made. It is the reasoning document for the feature, not just a usage guide.

Everything is inert unless `EXPERIMENTS_ENABLED=true` **and** an experiment is
`running`. In the default configuration the audit and review pipelines are
byte-for-byte unchanged.

---

## 1. Goal

The platform can run audits through several engines (inline regex, Claude Agent
SDK, K8s sandbox, direct DeepSeek) and many model/prompt combinations. The
question we need to answer is:

> **Which audit strategy produces the best outcome, at the best cost?**

"Best" is deliberately a composite: it includes correctness, human acceptance,
speed, and cost. A single model rarely wins all four, so the experiment computes
a weighted **composite score** that reflects the business's actual priorities.

---

## 2. What is tested

An experiment arm is a fully-resolved `AuditStrategy`:

| Field | Meaning |
|---|---|
| `engine` | `inline` \| `sdk` \| `sandbox` \| `deepseek` |
| `vendor` + `modelId` | which model produces the review |
| `temperature` / `maxTokens` | sampling parameters |
| `promptVariant` | `baseline` \| `json` \| `cot` \| `few-shot` |

### Why test the *strategy*, not just the *model*

The outcome depends on the whole pipeline — engine, model, and prompt together.
A "better" model behind a weaker prompt variant can lose. Making the arm the
full strategy means the experiment can find the best **combination**, not just
the best model in isolation.

---

## 3. Design decisions and rationale

### 3.1 One control vs N treatments

Every experiment has a `controlStrategy` (the current baseline) and a list of
`treatmentStrategies`. Treatments are judged **relative to control**, never in
absolute terms.

**Why:** an absolute score is meaningless across experiments (different repos,
guidelines, traffic). A delta vs the current baseline is directly actionable:
"does this change make things better than what we run today?"

### 3.2 Deterministic hash bucketing

Assignment is a stable hash of `(repositoryFullName, prNumber)`, gated by
`rolloutPercent`. The same PR always maps to the same bucket.

**Why:** reproducibility and consistency. A given PR is always evaluated by the
same arm across pushes, so the human decision stays comparable. It also avoids
the storage of a separate assignment table.

When both an org-specific and a global experiment are running, the
**org-specific** experiment wins — a newer global experiment never shadows an
org-level decision.

**Trade-off:** deterministic hashing is not cryptographically random, but for a
developer-facing comparison it is unbiased enough and far simpler than a
randomized-assignment registry.

### 3.3 Rollout gating

`rolloutPercent` controls what fraction of PRs enter the experiment at all.

**Why:** safety. You can start at a small percentage and ramp up only after the
arms are behaving, instead of flipping the whole audit pipeline at once.

### 3.4 Feature flag + lifecycle status

The whole layer is gated behind `EXPERIMENTS_ENABLED`, and each experiment has a
status (`draft` → `running` → `paused`/`completed`).

**Why:** an experiment must be explicitly and deliberately activated. The
default path (`disabled` / `draft`) is identical to the pre-experiment behavior,
which is the requirement for any experiment we run in production.

### 3.5 Both automated and human signals

Every bucketed PR records **two** kinds of evidence:

- **Automated** — verdict, compliance/efficiency/coverage, latency, tokens, parse
  success, and agreement with the inline baseline.
- **Human** — the reviewer's `approve` / `revise` / `cancel` decision.

**Why both:** automated scores are cheap, consistent, and available on every PR,
but they only measure what the scoring code *can* measure. The human reviewer is
the closest thing we have to ground truth. A model that looks great on automated
scores but whose reviews developers reject is not actually good — so acceptance
is a first-class metric, weighted into the composite.

### 3.6 Blinded acceptance

The reviewer sees only the review text, never which arm produced it.

**Why:** without blinding, reviewers could (even subconsciously) treat reviews
differently based on a known model name, which would bias the acceptance signal.
Blinding is free here because the review is just text.

### 3.7 Weighted composite, renormalized over available data

Five sub-scores combine into one composite using the experiment's
`metricsWeights`:

| Weight | What it rewards | Why it matters |
|---|---|---|
| `accuracy` | standards actually applied | a wrong verdict is worse than none |
| `quality` | right-sized code + requirement coverage | over/under-engineering cost |
| `acceptance` | reviewers accepted the review | human ground-truth proxy |
| `speed` | lower latency | developer experience |
| `cost` | lower spend | the business constraint |

The composite is a weighted average **over only the sub-scores that have data**,
with the weights renormalized.

**Why renormalize:** a brand-new experiment has no human decisions yet. Without
renormalization, missing acceptance would drag every composite toward zero, which
would be wrong. Renormalization keeps the score meaningful at every stage, at the
cost of making the composite mean slightly different things over time (which is
why the individual sub-scores are always shown alongside).

### 3.8 Confidence intervals and significance vs control

Each arm reports a 95% CI on its composite and score means, a Wilson 95% CI on
acceptance, and a `better` / `worse` / `inconclusive` verdict relative to control
for both composite and acceptance.

**Why:** a point estimate ("arm B is 2 points higher") is noise at small sample
sizes. The CI and the significance verdict prevent a premature "winner." A
treatment is only recommended when it has **both** reached the configured
per-arm sample target (`minSampleSize`) **and** its composite is
significantly better than control at 95% (`compositeVerdict === 'better'`,
not merely a higher mean). When no treatment qualifies, no recommendation is
shown — the business answer is "keep control".

### 3.9 Cost in dollars, not tokens

Cost is computed in USD from per-model pricing ($ per 1M input/output tokens),
not raw token counts.

**Why:** a token from `deepseek-flash` is not a token from `claude-opus`. Raw
token counts would systematically under-rank expensive models. Pricing makes
cross-vendor cost comparison meaningful. The stage-1 prices are a hardcoded
table and should be replaced with a live pricing source before cost is treated as
authoritative.

Runs whose model is **not in the pricing table contribute no cost signal**
(null), rather than a perfect score — "unknown" is not "free". If no arm has a
priced run at all, the cost sub-score falls back to token counts.

### 3.10 One observation per PR (dedupe)

A PR re-audited after a push (`synchronize`) does **not** create a second
`experiment_runs` row for the same `(experiment, repo, PR)`. The dedupe and
the human-decision correlation are keyed on the PR number stored on each run
(`experiment_runs.pr_number` + `repository_full_name`).

**Why:** without this, hot PRs would be over-represented and skew every mean. One
PR = one sample is the cleanest unit of observation for a review-quality test.

### 3.11 Eligibility is visible (`decided` vs `undecided`)

Each arm reports how many of its PRs reached a human decision and how many did
not.

**Why:** acceptance rate is only meaningful over *decided* PRs, but hiding the
undecided count would conceal selection bias. Surfacing both makes the
denominator honest.

---

## 4. Scoring methodology

### Sub-scores (0–100)

- `accuracy` = avg `complianceScore` (fallback: inline-agreement rate)
- `quality` = mean of avg `efficiencyScore` and avg `coverageScore`
- `acceptance` = human accept rate × 100
- `speed` = `1 − avgLatency / maxLatencyAcrossArms` (relative)
- `cost` = `1 − costUsd / maxCostUsdAcrossArms` (relative). Only **priced** runs
  (models in the pricing table) contribute to the cost signal; unpriced runs are
  excluded from this sub-score rather than scored as "free". When no arm has any
  priced run, cost falls back to `1 − tokens / maxTokensAcrossArms`.

### Composite

Weighted average over available sub-scores with renormalized weights.

### Statistics

- **Acceptance** — Wilson 95% interval (correct for small proportions).
- **Means / composite** — normal-approximation 95% interval (`mean ± 1.96·sd/√n`).
- **Significance vs control** — a delta is `better`/`worse` only if its 95% CI
  does not cross zero, else `inconclusive`. Composite uses a Welch-style
  standard error; acceptance uses a two-proportion standard error.

> The mean/composite intervals use the normal approximation, which is slightly
> optimistic below ~30 samples. This is acceptable for a first-stage test; swap
> in exact t/Welch p-values for production decisions on small samples.

---

## 5. Running an experiment

1. Apply the schema — `experiment_runs.pr_number` (the dedupe and
   human-decision correlation key) must exist: `yarn db:push` in dev, or run
   the corresponding migration in prod.
2. Set `EXPERIMENTS_ENABLED=true`.
3. Create an experiment — `yarn db:seed` seeds a global
   `DeepSeek V4 Pro vs Flash (demo)`, or use the Experiments page / API.
4. Set `status=running` and a `rolloutPercent` (Start button on the page).
5. Drive PRs through the webhook; review decisions on the Experiments page.

Webhook audits resolve the real `repositories` row by `fullName`, so org-scoped
experiments work; a **global** experiment (`organization_id = null`) matches any
org. When both exist, the org-specific experiment wins (see §3.2).

### Report output (`GET /experiments/:id/report`)

- Each arm reports its samples, sub-scores, composite with a 95% CI, raw
  metrics, and `minSampleReached` — a configured sample-count target, not
  statistical power.
- Treatments also carry `vsControl` with `compositeVerdict` /
  `acceptanceVerdict` (`better` / `worse` / `inconclusive`) and deltas.
- `recommendation` is present **only** when a treatment is significantly
  better than control at 95% and has reached the sample target; otherwise it is
  `null` and the answer is "keep control".
- `caveat` is a human-readable summary of the methodology limits (relative
  baselines, sample-target-not-power, no multiple-comparison correction) and is
  rendered on the Experiments page.

---

## 6. Known limitations

- **CIs use the normal approximation** — optimistic at small `n`.
- **`accuracy` is a proxy** — avg compliance, falling back to inline agreement.
  Agreeing with the inline regex baseline does not prove correctness.
- **Acceptance has selection bias** — undecided PRs are excluded from the rate
  (but counted and shown as `undecided`).
- **Speed/cost are relative within an experiment** — good for ranking arms, not
  comparable across experiments. The per-run normalization baseline is derived
  from the data accumulated *so far*, so composite scores and their CIs drift
  as more audits arrive. Treat the composite CI as a relative ranking, not a
  fixed-property interval.
- **No multiple-comparison correction** — each treatment is tested against
  control at 95%, so with N treatments the family-wise false-positive rate
  grows. The recommendation gates on significance, but treat "significantly
  better" as screening evidence, not proof, until an exact test with
  correction (or a pre-registered winner rule) is in place.
- **Sample target ≠ statistical power** — `minSampleSize` is a configured
  per-arm count that gates the winner, not a power computation (no effect
  size / variance / alpha / beta).
- **Pricing is a stage-1 table** — replace before making cost-driven decisions.
- **No sequential stopping** — the experiment keeps collecting until manually
  paused/completed; `minSampleSize` gates the winner, not collection.

## 7. Promotion criteria (preliminary → decision)

Treat the winner as a **final business decision** only after:

1. Exact significance (t/Welch for means, two-proportion z for acceptance) on
   top of the existing CIs — the composite verdict already uses a Welch-style
   standard error, but a p-value with multiple-comparison handling is the
   production-grade step.
2. A live cost model (per-model $/1M tokens) replacing the hardcoded table.
3. Sequential stopping or a pre-registered sample-size plan.
4. A documented eligibility model for acceptance (e.g., track *why* a PR was
   never decided, not just *that* it was).

---

## 8. Deliberate flow A/B — benchmark, ranking, promotion ("the plugin")

### 8.1 Agent architecture (flow) and tool chains

An experiment arm (AuditStrategy) now optionally carries three more fields:

- flow: 'sequential' | 'orchestrator' — the agent architecture being tested.
- toolChain: { skills: string[], mcp: string[] } — which skills and MCP servers an
  orchestrator arm may call through its LangGraph tool loop.
- flowGraph: a v1 preset diagram ({ flow, version: 1 }); richer node/edge editing
  (draw.io-style) lands in a later version.

- sequential = the fixed harness: diff -> guidelines -> one LLM call -> verdict.
- orchestrator = planner + tool loop (skills + MCP) -> reviewer -> verdict. Every
  LLM call in the loop is token-accounted.

Legacy arms (no flow field) behave exactly as before.

### 8.2 Deliberate benchmark runs

POST /experiments/:id/benchmark-runs runs every arm of the experiment against one
snapshot input (a pasted diff, or a linked PR). Each arm executes its own
architecture and records a run with source='benchmark' plus a full telemetry row
(total tokens across all LLM calls, cost, latency, tool-call count, verdict,
scores). Results are side-by-side comparisons of architectures, not randomized
live traffic.

GET /experiments/:id/benchmark returns per-arm telemetry, the ranking vector,
and the blended final score.

### 8.3 Manual ranking -> vector -> final score

Admins rank the N arm outputs per PR (1 = best). Each rank normalizes to
(N - rank) / (N - 1) * 100, then averages across PRs into a per-arm ranking
vector. The final score blends the automated composite with the ranking vector
using MetricsWeights.ranking (default 0.20, clamped to [0,1]). The benchmark
winner is the highest final score — a manual/blended signal, not the
significance-gated winner used for live traffic.

### 8.4 Promotion ("the plugin")

POST /experiments/:id/promote writes a new active_flows row (append-only history,
versioned, previousId rollback chain). The active flow is the architecture that
becomes the default live reviewer:

- repo-scoped rows override org-scoped rows.
- POST /experiments/active-flows/:id/revert appends a row restoring the previous
  variant.
- GET /experiments/active-flows lists promotion history.

Live resolution precedence in the audit worker:

1. a running experiment's bucketed arm (existing live data collection),
2. the promoted active flow (the plugin; repo overrides org),
3. the AUDIT_MODE env var (legacy fallback).

Promoted flows keep recording live HITL acceptance, so a choice made in the lab
stays validated in production — the flywheel.

### 8.5 Async execution, notifications, and the flywheel

Benchmark runs are asynchronous. POST /experiments/:id/benchmark-runs enqueues a
background job and returns immediately; the job status is polled via
GET /experiments/benchmark-jobs/:id (queued -> running -> completed / failed /
cancelled). Only one queued/running job is allowed per experiment — a second
enqueue returns 409. POST /experiments/benchmark-jobs/:id/cancel aborts the run
(cooperative: the worker stops between arms and aborts the in-flight LLM call).

On completion or failure a row is written to the notifications table
(GET /experiments/notifications). The Experiments page shows the live status and a
Cancel button, so an admin can kick off a run, keep working, and check back later.

Promoted flows record each reviewed PR into active_flow_runs, and human HITL
decisions (approve / revise / cancel) are folded back into those rows — so a
promoted architecture keeps accumulating live acceptance after promotion. That
closes the lab -> plugin -> keep-learning loop.

---

## 9. Revision history

Behavioral changes to the experiment layer and where each is defined above:

| Change | What changed | Defined in |
|---|---|---|
| **Winner gating** | A treatment is recommended only when it is *significantly better* than control at 95% (and reached the sample target). Previously the highest composite mean among sample-sufficient arms won even when the difference was within noise; now no recommendation = "keep control". | §3.8, §5 report output |
| **Cost signal fix** | Unknown-model runs previously scored a perfect cost sub-score (the USD→tokens fallback was dead code). Unpriced runs now contribute **no** cost signal; the token fallback applies only when no run is priced. | §3.9, §4 |
| **Org precedence** | An org-specific running experiment now wins over a global one regardless of creation order. | §3.2 |
| **Schema fix** | `experiment_runs` gained the `pr_number` column that the dedupe, human-decision correlation, and index always referenced but the table never had. Apply with `yarn db:push` / migration. | §3.10, §5 step 1 |
| **Naming** | The per-arm `powered` flag was renamed `minSampleReached` to make clear it is a configured sample count, not statistical power. | §5 report output |
| **Methodology note** | The report now returns a `caveat` stating the limits (relative baselines, sample target ≠ power, no multiple-comparison correction), rendered on the Experiments page. | §5, §6 |
| **Tests** | `experiment-stats.spec.ts` unit-tests bucketing, CIs, cost, composite renormalization, and the winner rule (`node --test apps/backend/src/modules/experiments/__tests__/experiment-stats.spec.ts`). | — |
