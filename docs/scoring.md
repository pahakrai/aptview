# Scoring Metrics

Every PR triggers **two parallel pipelines** — one for scoring, one for review:

```
PR opened
  │
  ├─→ Pipeline 1: SCORING (automated)
  │     BullMQ → AuditProcessor (inline | sdk | sandbox)
  │     → compliance%, efficiency%, coverage%
  │     → Stored in ai_audits → Dashboard + Desktop app
  │
  └─→ Pipeline 2: REVIEW (HITL)
        BullMQ → LangGraph (fetchDiff → generateReview → interrupt)
        → Text review → Desktop app shows diff + review
        → Human approves → Octokit posts to GitHub
```

**Scores are always computed** — the audit pipeline runs regardless of the review
mode. They appear in the desktop app's score bar, the web dashboard, and the
API endpoints.

This document explains how each score is computed, what it measures, and
how to interpret it.

## The Three Scores

| Score | Range | Meaning | Available in |
|---|---|---|---|
| `complianceScore` | 0–100 | How many coding standards did the code pass? | All modes |
| `efficiencyScore` | 0–100 | Is the code appropriately sized for the task? | All modes |
| `coverageScore` | 0–100 | Does the code cover all task requirements? | SDK + Sandbox (AI-only) |

---

## 1. Compliance Score (`complianceScore`)

Measures adherence to the organization's active coding guidelines.

### How it's computed

**Inline mode (regex):**

```
complianceScore = (passedGuidelines / totalActiveGuidelines) × 100
```

For each active `code_guideline`, the processor runs its regex pattern against every
line in the diff. A guideline is marked **failed** if the pattern matches anywhere in
the diff (a violation was found). It is marked **passed** if no match occurs.

| Scenario | Computation |
|---|---|
| 10 guidelines, 2 violated | `(8 / 10) × 100 = 80` |
| 5 guidelines, 0 violated | `(5 / 5) × 100 = 100` |
| 0 active guidelines | `null` (nothing to measure) |
| All 4 guidelines violated | `(0 / 4) × 100 = 0` |

**Sandbox mode (AI-powered):**

The CodeWhale sandbox receives the full list of guidelines and the changed code.
The AI evaluates each guideline against the full file context (not just diff hunks)
and produces a `complianceScore`. The instruction given to the AI:

> "complianceScore: % of coding standards the code followed. Count each guideline.
> If code violates it, mark failed. Score = (passed / total) × 100."

The returned value is clamped to 0–100 on the server side as a safety measure.

### Interpretation

- **100**: Every active guideline was followed. Clean code.
- **80–99**: Minor violations. Review the failed guidelines.
- **50–79**: Significant violations. Several guidelines broken.
- **0–49**: Heavy violations. The code may need refactoring before merge.
- **0**: Every guideline was violated. Likely a mismatch between standards and codebase.

---

## 2. Efficiency Score (`efficiencyScore`)

Measures whether the code is appropriately sized for the task it addresses.
This directly penalizes over-engineering — writing 500 lines when the task
called for 100.

### How it's computed

```
if (actualLoc ≤ estimatedLoc) {
  efficiencyScore = 100
} else {
  efficiencyScore = max(0, (estimatedLoc / actualLoc) × 100)
}
```

- `actualLoc`: Lines added + lines removed, counted from the diff.
- `estimatedLoc`: The LOC estimate from task decomposition (`decomposed_tasks.estimatedLoc`),
  or a conservative default of 150 in inline mode.

| actualLoc | estimatedLoc | Score | Explanation |
|---|---|---|---|
| 80 | 150 | 100 | Under budget — fully efficient |
| 150 | 150 | 100 | Exactly on budget |
| 200 | 150 | 75 | 33% over budget |
| 300 | 150 | 50 | 2× over budget — concerning |
| 600 | 150 | 25 | 4× over budget — scope creep |
| 1500 | 150 | 10 | 10× over budget — rewrite likely needed |

### Interpretation

- **100**: Code is concise and within the estimated LOC budget.
- **75–99**: Slightly over budget. Acceptable for most reviews.
- **50–74**: Over budget by 1.3–2×. Review for unnecessary complexity.
- **25–49**: Significantly over budget. Likely scope creep or over-engineering.
- **0–24**: Severely over budget. The code is doing far more than the task required.

### Why this matters

AI coding tools often generate verbose code — writing helper functions,
adding abstractions, or including unnecessary error handling that wasn't
in the requirements. The efficiency score surfaces this. A PR that passes
all guidelines but scores 30 on efficiency is a yellow flag.

---

## 3. Coverage Score (`coverageScore`)

Measures how completely the code addresses the task requirements.
This is the only AI-only metric — it requires semantic understanding
of both the task description and the changed code.

### How it's computed

**Prerequisites:**
- `taskDescription` must be provided in the `AuditRequest`.
- The audit must run in sandbox mode (`AUDIT_MODE=sandbox`).

The AI reads the task description (from Jira, Linear, or manual input)
and compares it against the changed files. Each requirement is matched
to the code. Missing or incomplete requirements deduct from the score.

The AI is instructed:

> "coverageScore: Does code cover all requirements from the task description?
> 100 = every requirement addressed. Deduct for each missing/incomplete requirement."

**Inline mode:**
- Always returns `null` — regex cannot assess requirement coverage.

### Interpretation

- **100**: Every requirement in the task description is addressed by the code.
- **80–99**: Most requirements covered. One or two minor gaps.
- **50–79**: Several requirements missing or only partially implemented.
- **0–49**: Significant gaps. The code may not fulfill the task.
- **null**: Not computable (inline mode or no task description provided).

### Example

Task description:

> "Create an email validation endpoint that accepts an email string, validates
> format via regex, checks MX records, and returns `{ valid: boolean, reason?: string }`."

If the PR implements `POST /api/validate-email` with regex validation but
**skips the MX record check**, the coverage score would be approximately 67
(two of three requirements met).

---

## Score Trends

The endpoint `GET /api/v1/audits/org/:orgId/score-trends` returns weekly
average scores over time, making it possible to track whether code quality
is improving or declining.

```
GET /api/v1/audits/org/{orgId}/score-trends?weeks=12
```

Response:

```json
{
  "organizationId": "uuid",
  "weeks": 12,
  "trends": [
    {
      "week": "2026-06-01",
      "avgCompliance": 82,
      "avgEfficiency": 71,
      "avgCoverage": 88,
      "auditCount": 14
    },
    {
      "week": "2026-06-08",
      "avgCompliance": 85,
      "avgEfficiency": 74,
      "avgCoverage": 90,
      "auditCount": 21
    }
  ]
}
```

### Query parameter

| Parameter | Default | Range | Description |
|---|---|---|---|
| `weeks` | 12 | 1–52 | Number of weeks to include |

### Aggregation

Scores are averaged per week using PostgreSQL `date_trunc('week', created_at)`.
Each data point includes the audit count so you can distinguish between
"bad week with 1 audit" and "bad week with 50 audits."

---

## Sub-Task Quantifiability

Task decomposition (`POST /api/v1/decomposition`) produces sub-tasks with
fields that enable measurement before implementation begins.

### Sub-task fields

| Field | Type | Description |
|---|---|---|
| `title` | string | Short task name |
| `description` | string | What needs to be built |
| `estimatedLoc` | integer | Estimated lines of code |
| `filesInScope` | string[] | Files to create or modify |
| `acceptanceCriteria` | string[] | Concrete, testable "done" conditions |
| `complexity` | integer (1–5) | Effort rating |
| `priority` | integer | 0 = highest |

### Complexity scale

| Complexity | Meaning | Typical LOC |
|---|---|---|
| 1 | Trivial — single function, no new files | 5–30 |
| 2 | Simple — one new file, few functions | 30–80 |
| 3 | Moderate — new file + tests, maybe touching an existing file | 80–200 |
| 4 | Complex — multiple files, new module or pattern | 200–500 |
| 5 | Very complex — architectural change, new patterns, cross-cutting | 500+ |

### How the AI decomposes

The decomposition prompt instructs the AI to:

1. Parse the task description and sprint context.
2. Identify concrete sub-tasks, each independently estimable and testable.
3. Produce acceptance criteria as a list of strings — each one should be
   answerable with "yes" or "no" during review.
4. Assign complexity based on estimated effort, not importance.
5. Estimate LOC conservatively — prefer accuracy over optimism.

The decomposition is hierarchical. A sprint decomposes into tasks
(`POST /decomposition/sprint`), and each task can decompose further into
sub-tasks (`POST /decomposition` with `parentTaskId`).

---

## Putting It All Together

A single audit now tells a complete story:

```
POST /api/v1/audits
{
  "diffContent": "...",
  "changedFiles": { "src/validator.ts": "..." },
  "taskDescription": "Create email validation endpoint"
}

→ Response (after processing):
{
  "verdict": "warning",
  "totalViolations": 3,
  "errorCount": 0,
  "warningCount": 3,
  "complianceScore": 78,      // 2 of 9 guidelines violated
  "efficiencyScore": 60,      // 250 actual LOC vs 150 estimated
  "coverageScore": 67,        // MX check missing from implementation
  "scopeCreepDetected": false
}
```

Reading this: the code passes (no errors) but has warnings. Standards compliance
could be better at 78%. The PR is 67% larger than needed — consider trimming.
And it doesn't fully cover the task requirements — the MX record check is missing.

Previously, the auditor would only see `"verdict": "warning"` with a count of
violations. Now they see _why_ and _by how much_.

---

## Scores in the Desktop App

When you select a review in the desktop app, the score bar below the monitor
shows the three metrics with live progress bars:

```
┌────────────────────────────────────────────────────────────────────┐
│    78%            60%            67%                               │
│  COMPLIANCE     EFFICIENCY     COVERAGE                            │
│  ████████░░     ██████░░░░     ███████░░░                          │
├────────────────────────────────────────────────────────────────────┤
│  ⏸ PAUSED: Awaiting Human Approval                                 │
│  [Approve & Comment] [Cancel] [Manually Trigger Review]            │
└────────────────────────────────────────────────────────────────────┘
```

- **Green (compliance)**: Standards followed by the PR
- **Blue (efficiency)**: Code size vs. estimate — penalizes over-engineering
- **Violet (coverage)**: Task requirements addressed (AI-only, blank if not computed)

Scores update automatically when the audit completes. While the audit is still
processing, the bars show `—` until data arrives.

## Audit completes independently

The scoring pipeline runs in parallel with the review pipeline. You can approve
or cancel a review while the audit is still computing scores. The score bar
updates whenever the data becomes available, even after you've posted the review
to GitHub.
