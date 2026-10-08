# Quick Reference — HITL Review & A/B Experiments

A fast re-entry map for the two features this project revolves around:
the **human-in-the-middle code review** and the **A/B experiment ("deliberate
flow")** layer that decides which model/architecture to promote.

Deeper dives (prefer these when you need the rationale, not just the map):

- [reviews.md](reviews.md) — the HITL review pipeline, end-to-end
- [experiments.md](experiments.md) — why the A/B layer is designed the way it is
- [scoring.md](scoring.md) — the audit/scoring pipeline and its three engines
- [architecture.md](architecture.md) — module/data-flow overview

---

## 1. The mental model in one diagram

```
GitHub PR (opened / synchronize / reopened, targeting a reviewed branch)
        │  webhook POST /webhooks/github  (HMAC-signed, INBOUND only)
        ▼
WebhooksService.processGitHubWebhook()
        ├─▶ Audit pipeline   → "audits" queue  (scoring, no human gate)
        └─▶ Review pipeline  → "reviews" queue (HITL, human gate)
                  │
                  ▼
LangGraph (buildReviewGraph, compiled with interruptBefore + MemorySaver)
        fetchDiff → generateReview (DeepSeek + ReadFile tool) → humanGate ✋
                  │  (graph pauses, checkpoint saved by threadId)
                  ▼
        human clicks: approve | revise (≤3) | cancel
                  │
                  ▼
        approve → "review-post" job → postComment() → comment on PR (REST API)
                  └─ optionally starts Phase 2 → generateTests → testHumanGate ✋
```

Key idea: **the human sits between LLM generation and the GitHub side effect.**
The gate is enforced by LangGraph `interruptBefore: ['humanGate','testHumanGate']`,
not by convention — `postToGitHub` physically cannot run until a human acts.

---

## 2. The webhook (the "hook") — inbound trigger only

- Handled by `webhooks.controller.ts` → `webhooks.service.ts`.
- **Only `pull_request` events** (`opened`, `synchronize`, `reopened`). A plain
  `push` event is ignored entirely.
- Branch filter is on the PR **target** (`base.ref`), compared against the repo's
  `reviewBranches` setting (default `['dev']`). `feature/x → dev` runs;
  `dev → main` is skipped unless `main` is in the list.
- Validates HMAC `x-hub-signature-256` against the raw body.
- Fetches the diff (`listPRFiles`) and full changed-file contents (`fetchFiles`),
  then enqueues **two** parallel jobs: audit (scoring) + review (HITL).

Direction matters:

| Direction | Mechanism |
|---|---|
| GitHub → aigov | Webhook (inbound) |
| aigov → GitHub | GitHub REST API via Octokit + `GITHUB_TOKEN` (outbound) |
| Human → GitHub | Manual **Approve** click on the PR itself |

The webhook never writes back. Outbound writes (post comment, commit test file)
use the REST API.

---

## 3. What "accept" actually does

`POST /api/v1/reviews/:id/action` with `{ action: 'approve', notes?, generateTests?, testTypes? }`.

1. `ReviewsService.approveReview(...)` — marks review `posting`, writes a durable
   `review_decisions` row (`action='approve'`), enqueues a `review-post` job.
2. `ReviewProcessor.processPostJob` — rehydrates the paused graph checkpoint by
   `threadId`, builds the final comment (`reviewText` + optional
   `### Reviewer's Notes`), and posts it via `postComment()` →
   `octokit.issues.createComment`.
3. If `generateTests` + `testTypes` were set, it resumes the graph through
   Phase 2 (`generateTests → reviewTests → testHumanGate ✋`) and waits for a
   **second** human decision (`approve-tests` / `cancel-tests`).

Important distinctions:

- **Accept = post the AI review as a plain PR comment.** It is a top-level
  markdown comment, **not** line-inline annotations, **not** a `REQUEST_CHANGES`
  or `APPROVE` review event.
- **Accept does NOT auto-approve the PR.** The `postReview()` method with
  `event: 'APPROVE'` exists in `review-commenter.ts` but is never called in this
  flow. GitHub approval is always a manual human action.
- The comment is advisory — it does not block merging by itself.

---

## 4. What the AI review sees

Initial context is **changed files only** (diff + full contents + a changed-file
listing), with prompt-side truncation (~8KB diff, ~4KB repo context).

But the LLM also gets a `ReadFile` tool (`fetchFileContent` at the PR head SHA),
so it can pull in **any other file by path** on demand, up to 10 tool round-trips.
It's "changed files first, with the ability to reach out" — not a closed diff.

---

## 5. A/B experiments — what's tested and the metrics

An experiment arm is a full `AuditStrategy` (`libs/shared-types`):

```
engine · vendor · modelId · temperature · maxTokens · promptVariant
flow ('sequential' | 'orchestrator') · toolChain (skills + mcp + toolConfig) · flowGraph
```

So it tests the **agent architecture**, not just the model.

### Metrics (weighted composite, 0–100)

Default weights (`DEFAULT_METRICS_WEIGHTS`):

- **accuracy** (0.35) — from `complianceScore`; fallback `agreedWithInline` → 100/0
- **quality** (0.35) — average of `efficiencyScore` + `coverageScore`
- **acceptance** (0.15) — human approve rate (`approve`=100, `revise`=0)
- **speed** (0.075) — `1 - latency / maxLatency`, normalized vs slowest arm
- **cost** (0.075) — token cost in USD (hardcoded `MODEL_PRICING`), normalized vs max
- **ranking** (optional, default 0.20) — admin manual 1..N ordering, blended into `finalScore`

### Where the raw scores come from (important nuance)

- **User defines**: the *criteria* (`code_guidelines` — regex/severity/description)
  and the *weights* (`metricsWeights`).
- **AI engines (`sandbox`/`sdk`)**: `complianceScore`, `efficiencyScore`,
  `coverageScore` are **self-reported by the LLM** in its JSON, then clamped to
  0–100. The guidelines are injected into the prompt under
  `## Coding Standards (check these)`, with a hardcoded "Scoring Guide" telling
  the LLM the formula. The LLM grades its own output.
- **`inline` engine**: `complianceScore` = deterministic regex match against
  guidelines; `efficiencyScore` = LOC heuristic vs a hardcoded 150-line estimate;
  `coverageScore` = always `null`.

The only **independent** signals in the composite are `acceptance` (real human
decisions) and `agreedWithInline` (agreement vs the deterministic regex verdict),
plus objective `speed`/`cost` measurements.

### Two A/B modes

1. **Live experiment** — deterministic FNV-1a hash bucketing of PRs
   (`rolloutPercent`), one `experiment_runs` row per audited PR. Winner via
   `selectWinner`: must reach `minSampleSize`, have a composite, **and** be
   significantly better than control at 95% (`deltaVerdict`). Otherwise
   "keep control".
2. **Deliberate benchmark** — runs every arm side-by-side against a chosen
   snapshot input; blends automated composite with admin ranking
   (`blendFinalScore`); winner = highest `finalScore` via `pickHighestScore`
   (not significance-gated).

### Promotion flywheel

```
experiment → benchmark → admin ranking → PROMOTE → active_flows ("the plugin")
                                              → active_flow_runs keeps accumulating
                                                live HITL acceptance post-promotion
```

`active_flows` is append-only (versioned, `previousId` rollback chain; repo-scoped
overrides org-scoped).

---

## 6. Where data lives

- **PostgreSQL** (pgvector/pg15, Drizzle ORM via `DATABASE_URL`): all durable
  records — `experiment_runs`, `review_decisions`, `active_flows`,
  `active_flow_runs`, `admin_rankings`, `benchmark_jobs`, `ai_audits`,
  `code_guidelines`, etc. Raw metrics are persisted here:
  - speed ← `experiment_runs.latencyMs`
  - cost ← `experiment_runs.promptTokens` + `completionTokens`
  - acceptance ← `review_decisions` (backfilled into `experiment_runs.humanDecision/humanAccepted`)
- **Redis**: BullMQ queues only (`audits`, `reviews`, `benchmarks`) — transient job transport.
- **In-process memory** (not durable): the HITL pending state — `ReviewsService`
  `Map` + LangGraph `MemorySaver` checkpoints. **Lost on restart.**

The 0–100 sub-scores (acceptance/speed/cost) are **not** stored — they're
recomputed on the fly in `getReport()` each time you view the report.

---

## 7. Gotchas to remember

1. **Backend must stay up (same process) from webhook → accept.** The paused
   review state is in-memory; a restart drops the checkpoint and "accept" fails
   with `No checkpoint found for thread`. Move to Redis/Postgres to survive
   redeploys.
2. **Frontend doesn't need to be open.** The review is generated by backend
   workers. A browser is only needed when a human wants to click accept.
3. **Speed/cost baselines drift.** They're normalized against "largest seen so
   far," so a run's score can change as slower/cheaper runs arrive.
4. **`MODEL_PRICING` is hardcoded** — swap for a live table before treating cost
   as authoritative.
5. **AI scores are self-assessed** in `sandbox`/`sdk` modes (the model grades its
   own output); only acceptance and `agreedWithInline` are independent checks.
6. **The webhook is inbound-only.** Everything written back to GitHub goes through
   the REST API, and the PR is never auto-approved.

---

## 8. Key files

- `apps/backend/src/modules/webhooks/webhooks.service.ts` — webhook trigger + filters
- `apps/backend/src/modules/reviews/review.graph.ts` — LangGraph state machine + gates
- `apps/backend/src/modules/reviews/review.processor.ts` — BullMQ workers (analyze/revise/post/test-post)
- `apps/backend/src/modules/reviews/reviews.service.ts` — in-memory pending reviews + decisions
- `apps/backend/src/modules/reviews/reviews.controller.ts` — REST/WS HITL actions
- `apps/backend/src/modules/reviews/review-commenter.ts` — Octokit write-back (comments, commits)
- `apps/backend/src/modules/audits/audit.processor.ts` — scoring engines (inline/sdk/sandbox)
- `apps/backend/src/modules/experiments/experiments.service.ts` — A/B resolve/report/winner
- `apps/backend/src/modules/experiments/experiment-stats.ts` — pure stats (CI, significance, winner)
- `apps/backend/src/modules/experiments/experiment-ranking.ts` — ranking blend + promotion pick
- `apps/backend/src/modules/experiments/promotions.service.ts` — active-flows promotion/rollback
- `apps/backend/src/modules/flow-runner/` — flow-graph.ts (graph interpreter), tool-catalog.ts (skills/MCP + guard skills), flow-runner.service.ts (executor), mcp-discovery.controller.ts (MCP probe)
- `apps/frontend/src/pages/AgentCanvas.tsx` — React Flow visual agent builder (Form/Canvas editors over the same AuditStrategy)
- `apps/backend/src/database/schema.ts` — all tables
- `libs/shared-types/src/index.ts` — `AuditStrategy`, `MetricsWeights`, flow/toolchain types
