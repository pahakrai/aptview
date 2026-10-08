# Agent Design & Configurable A/B Testing

This page is the reference for the "agent design" capability: what a structure
is, how you design one (form or canvas), how skills/MCP are configured, and how
a structure gets into an A/B experiment.

---

## 1. What an "agent structure" is

An agent structure is a named, reusable design of the code-review agent's
architecture. It bundles every variable you might change into one saved object
(the AuditStrategy):

| Variable | Meaning |
|---|---|
| engine / vendor / modelId | which engine + model produces the review |
| temperature / maxTokens | sampling parameters |
| promptVariant | baseline / json / cot / few-shot |
| flow | 'sequential' (fixed harness) or 'orchestrator' (planner + tool loop) |
| toolChain | the tools an orchestrator arm may call (skills, mcp, toolConfig) |
| flowGraph | a node/edge DAG; v1 ships two presets (sequential, orchestrator) |

The two presets:

- sequential = diff -> guidelines -> one LLM call -> verdict.
- orchestrator = planner -> tool loop (skills + MCP) -> reviewer -> verdict.
  Every LLM call in the loop is token-accounted.

---

## 2. Designing structures — two editors

Structures are stored in the agent_structures table and managed by the
/agent-structures API (GET list, GET :id, POST, PATCH, DELETE).

The **Agent Structures page** has two editors over the same model — switch with
the **Form / Canvas** toggle:

### 2.1 Form editor

Pick flow, engine/vendor/model, temperature, max tokens, and prompt variant;
toggle skills and MCP on/off; and set each tool's config in the "Tool
configuration" panel. Fast, precise, keyboard-friendly.

### 2.2 Canvas editor (visual builder, React Flow)

A "Lego blocks" view of the same thing:

- The **agent** is one container node showing model/temp/prompt, with two
  colored input slots (blue = MCP data, red = skills/guardrails).
- A **palette** on the left lists Native skills (red) and MCP connectors (blue);
  drag them onto the canvas.
- Link a connector/guardrail to the matching slot on the agent (connections are
  validated: MCP -> blue slot, skill -> red slot).
- Click any node to edit it in the **side panel** (agent: model/prompt; tool:
  its config fields).
- **Save workflow** compiles the layout back into the same AuditStrategy JSON.
  The canvas is a view over the model — pixel positions are never stored.

---

## 3. Skills and MCP — two tiers, each with its own config

GET /tool-catalog returns the catalog. Every tool (skill or MCP) declares a
configSchema (a list of typed fields), so the UI renders a per-tool config form
and the runner reads the values from toolChain.toolConfig[name].

### 3.1 Native skills (guardrails, red)

Compiled, in-process code. The frontend only selects them by name (skill_id);
the runner resolves the name to the hardcoded handler in tool-catalog.ts.
Built-ins today:

- search_guidelines — search configured coding standards (config: maxResults,
  defaultQuery).
- assess_diff_size — added/removed line counts (config: countContextLines).
- tenant_scope_guard — hard-locks MCP tool calls to the current tenant by
  rewriting args (injects tenant_id). It runs **automatically before every MCP
  call**, using session context the canvas author never sees.

Each skill declares an enforcement policy: strict_block, sanitize_or_halt, or
advisory. tenant_scope_guard defaults to strict_block (blocks the call if no
tenant context is available).

### 3.2 MCP connectors (external data, blue)

External servers (k8s, aws, gcp, kubetail). Their config is saved per structure:
transport (sse/stdio), url/command/args, plus scope fields (namespace, region,
etc.). Secrets are stored as **references** (secretRef, e.g.
env:AWS_ACCESS_KEY_ID), resolved from the environment at runtime — never raw
keys in the JSON.

POST /mcp/discover probes an MCP server and returns its tool list, so the UI's
"Discover tools" button shows a read-only capability list the moment you enter
a URL.

---

## 4. Selecting structures for an A/B test

POST /experiments/from-structures takes one control structure and N treatment
structure ids and creates an experiment:

    {
      "name": "orchestrator vs sequential",
      "controlStructureId": "uuid A",
      "treatmentStructureIds": ["uuid B", "uuid C"],
      "rolloutPercent": 100,
      "minSampleSize": 50,
      "metricsWeights": { ... }
    }

The backend resolves the structures into control/treatment strategies, stores
snapshots, and records control_structure_id + treatment_structure_ids for
provenance. Live traffic is deterministically bucketed per PR.

### 4.1 Load a structure into an experiment (shortcut)

From either editor, each structure card has **A/B: control** and
**A/B: treatment** buttons. They navigate to /experiments?control=<id> or
/experiments?treatment=<id>; the Experiments page pre-selects that structure in
its "Create from agent structures" form (treatment is appended to the treatment
list; control replaces the control selection). From there you add the remaining
arm(s), name it, and create the experiment.

---

## 5. Turning A/B on or off (the toggle)

1. Master switch = the persisted experiments_enabled setting
   (PUT /settings/experiments_enabled { "value": "true" | "false" }, no
   redeploy), falling back to the EXPERIMENTS_ENABLED env var (default off).
2. Per-experiment status = draft -> running -> paused/completed.

The Experiments page has a "Live A/B testing" toggle that writes the master
switch.

---

## 6. End-to-end flow

    design structures (form or canvas)     /agent-structures
        -> load into experiment            /experiments?control=|treatment=
        -> pick control + N treatments     /experiments/from-structures
        -> toggle experiments on           /settings/experiments_enabled
        -> set experiment status=running
        -> live PR traffic bucketed        (resolveArm)
        -> collect runs + HITL decisions   (experiment_runs, review_telemetry)
        -> rank + promote                  (admin_rankings, active_flows)
        -> stats                           (Python /analyze -> eval_summaries)

---

## 7. What the pages do

- **Agent Structures** (Form + Canvas) — design/reuse/edit/delete structures,
  configure per-tool settings, and jump straight into an A/B experiment.
- **Experiments** — live A/B report, deliberate benchmark, promotion, and the
  "Create from agent structures" form (control + N treatments) with the
  structure shortcut pre-fill.
