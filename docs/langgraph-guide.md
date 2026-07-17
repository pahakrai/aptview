# LangGraph Architecture Guide for Developers

This document explains the design decisions behind the LangGraph pipelines in aigov:
the review pipeline and the log analyzer. It covers the HITL mechanism, the role of
skills vs. MCP vs. DB guidelines, and how tool-call parallelism works.

---

## Table of Contents

1. [LangGraph HITL: How the Graph Pauses and Resumes](#langgraph-hitl)
2. [Skills, MCP, and DB Guidelines: Three Layers](#skills-mcp-guidelines)
3. [Tool Call Parallelism: Who Decides What](#tool-call-parallelism)
4. [Single-Node vs. Multi-Node Architecture](#single-vs-multi)
5. [Review Pipeline: Architecture Decisions](#review-pipeline)
6. [Log Analyzer: Architecture Decisions](#log-analyzer)
7. [When to Add Skills](#when-to-add-skills)

---

## 1. LangGraph HITL: How the Graph Pauses and Resumes {#langgraph-hitl}

The review pipeline uses three LangGraph primitives to implement human-in-the-loop:

```
1. checkpointer → saves graph state after every node, keyed by thread_id
2. interruptBefore → stops execution RIGHT BEFORE a named node
3. updateState + invoke(null) → external code modifies the checkpoint, then resumes
```

### The graph topology

```
__start__
    │
    ▼
fetchDiff ────────────────────────── (pass-through, sets status='reviewing')
    │
    ▼
generateReview ◄──────────┐         (DeepSeek API + ReadFile tool loop)
    │                      │
    ├─ status='reviewing'──┘         (tool-calling phase: loop back)
    │
    └─ status='awaiting_approval'
            │
            ▼
      humanGate ✋                    (interruptBefore: ['humanGate'])
            │
    ┌───────┼──────────┐
    │       │          │
    ▼       ▼          ▼
generateReview  postToGitHub  END    (conditional routing by status)
 (revise)      (approve)    (cancel)
```

### The pause mechanism (line 372 of `review.graph.ts`)

```ts
return graph.compile({
  interruptBefore: ['humanGate'],  // graph pauses right before this node
  checkpointer,                     // MemorySaver persists state
});
```

When `generateReviewNode` sets `status = 'awaiting_approval'`, the graph routes
to `humanGate` via `afterGenerateReview()`. LangGraph sees `humanGate` is in the
`interruptBefore` list and **stops execution**. The checkpoint is saved. The
`invoke()` call returns. The BullMQ job finishes.

### The resume mechanism

The human's decision travels into the graph via `graph.updateState()`:

```ts
// Revise: inject feedback, switch status to 'reviewing'
await graph.updateState(config, {
  humanFeedback: 'Check error handling in payment.ts',
  revisionCount: currentState.revisionCount + 1,
  status: 'reviewing',
});

// Resume — graph wakes up, humanGate passes through,
// conditional edge reads the modified status and routes accordingly
await graph.invoke(null, config);
```

The graph never "knows" it was paused. It wakes up, executes `humanGateNode`
(a pass-through), then the `afterHumanGate` conditional reads the current
`status` field — which the human just modified — and routes to the correct
next node.

### Two-phase BullMQ lifecycle

```
Job 1: "review-analyze"
  graph.invoke(initialState) → runs until ✋ → saves pending review
  status: 'awaiting_approval'

Human acts in desktop app:
  Approve  → Job 2: "review-post"  → post to GitHub → graph.invoke(null)
  Revise   → Job 2: "review-revise"→ updateState → graph.invoke(null)
  Cancel   → Job 2: none (status set to 'cancelled', graph.invoke(null))
```

The graph is the state machine. BullMQ is the trigger. The human is the router.

---

## 2. Skills, MCP, and DB Guidelines: Three Layers {#skills-mcp-guidelines}

These three mechanisms serve different purposes and operate at different levels.
They don't overlap — they stack.

```
┌──────────────────────────────────────────────────────┐
│  LLM TRAINING                                        │
│  What the model knows                                │
│  General, broad, frozen at training cutoff date      │
│  Knows: Kubernetes concepts, code review patterns    │
└──────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────┐
│  SKILLS                                              │
│  How the model should think                          │
│  Narrow, specific, procedural                        │
│  Encodes: methodology, process, LLM behavior rules   │
│  "Start with pod status, follow the error chain,     │
│   check resources last, group by root cause"         │
│  Developer-written, version-controlled               │
└──────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────┐
│  MCP                                                 │
│  What the model can reach                            │
│  Domain-wide: your private infrastructure            │
│  Bridge from LLM context → your network              │
│  Tools: kubetail, kubectl, config readers            │
│  Live data: YOUR cluster state, right now            │
└──────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────┐
│  DB GUIDELINES                                       │
│  What the model should check                         │
│  Flat list of rules with severity                    │
│  Org-admin editable, per-org, per-repo               │
│  "No console.log [error]"                            │
│  "Max function length: 50 [warning]"                 │
└──────────────────────────────────────────────────────┘
```

### The key distinction

| Layer | Answers | Who edits | How often |
|---|---|---|---|
| **Training** | "What is Kubernetes?" | Model provider | Rarely |
| **Skills** | "How do I diagnose a crash loop?" | Developer | Per workflow |
| **MCP** | "What's wrong with this specific pod?" | SRE / DevOps | Real-time data |
| **DB Guidelines** | "Which rules apply to this code?" | Org admin | Per project |

### How they work together

In the log analyzer:

1. **Training** gives the LLM the concept of `CrashLoopBackOff`
2. **Skill** tells it "diagnose pods first, then check config, then trace dependencies"
3. **MCP** provides `kubetail` and `kubectl` to fetch actual pod state
4. **Skill** also says "never `kubectl exec`, read-only access, redact secrets from output"

The skill wraps the MCP tools. MCP opens the door to your infrastructure.
Skills are the security guard at that door, deciding what's allowed.

### Can skills contain rules?

Yes. Skills can contain both process and rules:

```
Process (steering):                 Rules (constraints):
────────────────────                ────────────────────
1. Start with pod status            • Never kubectl exec
2. Follow the error chain           • Read-only namespace access
3. Check resources last             • Redact secrets from output
4. Group by root cause              • Max 15-minute log window
```

The DB guidelines handle *code-level* rules. Skills handle *LLM-behavior* rules
and methodology. They can overlap — the boundary is pragmatic, not absolute.

---

## 3. Tool Call Parallelism: Who Decides What {#tool-call-parallelism}

Tool-call parallelism operates at two distinct layers. They are independent.

### Layer 1: Inside a single node (the LLM's domain)

When the LLM returns `tool_calls`, it bundles independent calls together:

```json
{
  "tool_calls": [
    { "function": { "name": "ReadFile", "arguments": { "path": "auth.ts" } } },
    { "function": { "name": "ReadFile", "arguments": { "path": "payment.ts" } } }
  ]
}
```

The LLM decides:

- **Which tools to call** — based on the task and available tools
- **Whether to batch or split** — independent calls are bundled; dependent calls
  go in separate turns
- **The arguments** — file paths, parameters, queries

The LLM does NOT decide how the tools execute. That's your code.

### Layer 2: Tool execution within a batch (your code's domain)

Current implementation (sequential within a batch):

```ts
for (const tc of choice.tool_calls) {
  const content = await fetchFileContent(tc);  // one at a time
}
```

Could be parallel within a batch (tools in the same batch are always independent):

```ts
const results = await Promise.all(
  choice.tool_calls.map(tc => fetchFileContent(tc))
);
```

This is an optimization, not a change in behavior. The LLM already signaled
independence by batching. Your code honors that signal.

### Layer 3: Across graph nodes (your design's domain)

This is where LangGraph gives you the parallelism lever:

```
Sequential (you draw it):            Parallel (you draw it):

securityReview                       fetchDiff
    │                                ├──────────┬──────────┐
    ▼                                ▼          ▼          ▼
styleReview                      security   performance   style
                                       │          │          │
                                       └──────────┼──────────┘
                                                  ▼
                                             mergeReviews
```

You control graph-topology parallelism by how you draw edges. LangGraph executes
the graph as drawn — no automatic parallelization. You fan out nodes to run them
concurrently. You chain them to run sequentially.

### Summary of control

```
Who decides?                     What?
──────────                       ─────
LLM                              Which tools to call
LLM                              Batch vs. split across turns
You (code)                       Sequential vs. parallel within a batch
You (graph edges)                Sequential vs. parallel across nodes
```

---

## 4. Single-Node vs. Multi-Node Architecture {#single-vs-multi}

### When to use a single node

Use when the task is **interdependent** — each step informs the next.

```
Single generateReview node:
  LLM reads diff → "I need auth.ts"
  LLM reads auth.ts → "auth.ts calls payment.process() — I need payment.ts"
  LLM reads payment.ts → "found the issue, writing review"
```

The LLM follows a reasoning chain. Splitting into parallel nodes would fragment
that understanding. You'd lose the ability to drill deeper based on findings.

### When to use multiple nodes

Use when the task is **decomposable** — independent checks that can run concurrently.

```
Multi-node (parallel specialists):
  securityReview  →  checks for vulnerabilities (independent of style)
  performanceReview → checks for bottlenecks (independent of security)
  styleReview     →  checks for conventions (independent of performance)

  mergeReviews    →  combines findings, deduplicates, resolves conflicts
```

### The rule of thumb

```
Problem is interdependent?   →  Single node, let the LLM decide the order
Problem is decomposable?     →  Multiple nodes, you draw the parallel edges
```

---

## 5. Review Pipeline: Architecture Decisions {#review-pipeline}

### Why single-node (no parallel specialists)

Code review is inherently interdependent. You can't check if `auth.ts` is correct
without understanding `payment.ts` that it calls. The LLM needs to follow a
reasoning chain: read → understand → drill deeper → evaluate.

A single `generateReviewNode` with a `ReadFile` tool loop gives the LLM full
control over its reasoning strategy. It can batch independent reads, split
dependent ones, re-read files with new context — all within one node.

### Why DB guidelines, not skills

The reviewer is a single-pass LLM call. It checks code against known rules.
Guidelines as a flat list (`- **No console.log** [error]`) are sufficient
because:

- The LLM's base training already covers *how* to review code
- The task is well-defined (check diff against rules, produce markdown)
- The output is for human consumption, not downstream parsing

Skills would add methodology (e.g., "check security first, then style"). That
matters when you have multiple specialists or structured output. For a single
reviewer, the LLM's default code-review behavior is adequate.

### Why HITL (not automated posting)

The governance value is in the human gate. AI review is fallible — it can miss
context, misinterpret intent, or flag false positives. The interrupt before
`humanGate` ensures no review reaches GitHub without human approval.

The two-phase BullMQ lifecycle (analyze → await → post) enforces this gate at
the infrastructure level. The graph won't proceed past `humanGate` until an
external trigger modifies the checkpoint state.

### When skills would add value

Skills become necessary if the review pipeline evolves to:

- **Parallel specialists** — security reviewer, performance reviewer, style
  reviewer, each needing different behavioral instructions
- **Structured output** — JSON findings for API consumption, not just markdown
  for human reading
- **Multi-pass methodology** — first pass scans for patterns, second pass
  does deep analysis, third pass synthesizes

---

## 6. Log Analyzer: Architecture Decisions {#log-analyzer}

### Why single-node (with a rich toolbox)

Diagnosis is inherently sequential. You can't know you need to check Redis until
you see a connection-refused error in the payment-service logs:

```
Turn 1: kubetail payment-service
    → "connection refused to redis:6379"
    → LLM: "It's not payment — it's Redis."

Turn 2: kubetail redis
    → "OOMKilled, restarted 47 times"
    → LLM: "Memory exhaustion. Check limits."

Turn 3: kubectl describe pod redis-7f8b9
    → "limits: memory=128Mi, workload needs ~500Mi"
    → LLM: "Root cause found."
```

Each tool call depends on the previous result. Parallelizing the diagnosis
itself would be nonsense — you'd be checking Redis before knowing Redis is
involved.

### Why skills are necessary here

The log analyzer has an open-ended problem space. The user asks "why is X
crashing?" and the LLM navigates a toolbox across a cluster. Without a skill,
the LLM might:

```
Turn 1: kubectl get all pods      ← too broad
Turn 2: kubetail all namespaces   ← noisy
Turn 3: kubectl describe random   ← guessing
```

With a skill:

```
Skill says: "Start narrow, follow the error chain, check resources last."
Turn 1: kubetail target-service   ← focused
Turn 2: follow the error          ← directed
Turn 3: check root cause          ← conclusive
```

Skills give the LLM a diagnostic playbook. Without it, the LLM has tools but no
methodology.

### Why MCP is necessary here

The LLM's training data is frozen. It has no access to your cluster. MCP bridges
that gap with live tools:

- `kubetail` — real-time log fetching
- `kubectl` — pod status, configs, resource limits
- Custom tools — whatever your infrastructure exposes

These are facts the model cannot possibly know from training. MCP provides them
at runtime.

### Skills + MCP interaction

Skills govern HOW MCP tools are used:

```
Skill: "Read-only access. Never kubectl exec."
Skill: "Redact secrets and PII from all output."
Skill: "Group findings by root cause, not by pod name."
```

MCP opens the door to your cluster. Skills are the policies that control what
goes through that door and in what form.

---

## 7. When to Add Skills {#when-to-add-skills}

### Skills are necessary when:

| Situation | Why |
|---|---|
| The LLM needs a **methodology**, not a checklist | "Diagnose in this order" can't be a DB row |
| The task is **open-ended** with multiple valid approaches | The LLM needs a decision framework |
| Multiple **specialist agents** run in parallel | Each needs different behavioral instructions |
| Output must be **structured** for downstream parsing | Guidelines can't enforce JSON schemas |
| The domain is **niche** (Terraform, SQL plans, etc.) | The LLM's training may lack depth |
| LLM behavior needs **hard constraints** | "Never produce output over 2000 tokens" |

### Skills are NOT necessary when:

| Situation | Why |
|---|---|
| The task is a **single well-defined pass** | The LLM's training covers it |
| Rules can be expressed as a **flat list** | DB guidelines suffice |
| Output is for **human consumption** | Markdown is forgiving |
| The LLM's default behavior is **adequate** | Don't over-engineer |

### The test

Can you express what the LLM needs to do as a bullet list of rules?
→ Yes → use DB guidelines.
→ No → you need a process description → use skills.

---

## Files Referenced

| File | Purpose |
|---|---|
| `apps/backend/src/modules/reviews/review.graph.ts` | Review LangGraph: state, nodes, routing, checkpointer |
| `apps/backend/src/modules/reviews/review.processor.ts` | BullMQ worker: analyze, revise, post jobs |
| `apps/backend/src/modules/reviews/reviews.service.ts` | In-memory review store + queue enqueuing |
| `apps/backend/src/modules/reviews/reviews.controller.ts` | REST + WebSocket: start, action, list endpoints |
| `apps/backend/src/modules/log-analyzer/log-analyzer.graph.ts` | Log analyzer LangGraph: tool-augmented diagnosis |
| `apps/desktop/src/review-gate.js` | Desktop HITL UI: approve, revise, cancel, notes |
| `apps/desktop/src/App.html` | Desktop layout: reviewer controls, decision gate |
| `apps/backend/src/database/schema.ts` | `code_guidelines` table: org-specific rules |
