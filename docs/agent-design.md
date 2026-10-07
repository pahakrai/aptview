# Agent Design & Configurable A/B Testing

This page clarifies what the "agent design" capability is, what can be
configured, and how A/B experiments are configured. It supersedes any earlier
scattered notes about a "design page".

---

## 1. What an "agent structure" is

An agent structure is a named, reusable design of the code-review agent's
architecture. One structure bundles every variable you might want to change:

| Variable | Meaning |
|---|---|
| flow | 'sequential' (fixed harness) or 'orchestrator' (planner + tool loop) |
| flowGraph | a node/edge DAG. v1 ships two presets; a draw.io-style editor later emits the same shape |
| toolChain | which skills and MCP servers the orchestrator arm may call |
| model | engine, vendor, modelId, temperature, maxTokens, promptVariant |

All of these are captured by the AuditStrategy type (engine, vendor, modelId,
temperature, maxTokens, promptVariant, flow, toolChain, flowGraph).

### The two presets

- sequential = fixed harness: diff -> guidelines -> one LLM call -> verdict.
- orchestrator = planner -> tool loop (skills + MCP) -> reviewer -> verdict.
  Every LLM call in the loop is token-accounted.

---

## 2. Designing structures (new)

Structures are stored in the agent_structures table and managed by the
/agent-structures API:

| Method | Endpoint | Purpose |
|---|---|---|
| GET | /agent-structures | list structures (optionally by organizationId) |
| GET | /agent-structures/:id | fetch one |
| POST | /agent-structures | create (name, description, strategy) |
| PATCH | /agent-structures/:id | edit name/description/strategy/isActive |
| DELETE | /agent-structures/:id | remove |

GET /tool-catalog returns the available skills and MCP servers an orchestrator
structure may reference in its toolChain (skills + MCP are still introduced via
the structure's toolChain.skills and toolChain.mcp arrays).

This is the "design page" backend: design multiple structures, save them, and
edit their variables (flow, graph, tools, model, temperature, prompt)
independently of any experiment.

---

## 3. Selecting two structures for an A/B test

POST /experiments/from-structures takes one control structure and N treatment
structure ids, and creates an experiment that runs them head-to-head (default
N=1, but you can compare 2 or more treatments):

    {
      "name": "orchestrator vs sequential",
      "controlStructureId": "uuid of structure A",
      "treatmentStructureIds": ["uuid of structure B", "uuid of structure C"],
      "rolloutPercent": 100,
      "minSampleSize": 50,
      "metricsWeights": { "accuracy": 0.35, "quality": 0.35, "acceptance": 0.15, "speed": 0.075, "cost": 0.075 }
    }

The backend resolves the structures into control/treatment strategies, stores
the snapshots, and records control_structure_id + treatment_structure_ids for
provenance (which designs this experiment actually ran). Live review traffic is
then deterministically bucketed (control vs treatments) per PR.

---

## 4. Turning A/B on or off (the toggle)

Two levels:

1. Master switch = the persisted 'experiments_enabled' setting, configurable at
   runtime via PUT /settings/experiments_enabled { "value": "true" | "false" }
   (no redeploy). isEnabled() reads that first, then falls back to the
   EXPERIMENTS_ENABLED env var (default off).
2. Per-experiment status = draft -> running -> paused/completed. A running
   experiment (with the master switch on) activates bucketing; pausing stops new
   traffic from being bucketed while keeping collected data.

---

## 5. End-to-end flow

    design structures (multiple)          /agent-structures
        -> pick two                        /experiments/from-structures
        -> set EXPERIMENTS_ENABLED=true    (config page toggle)
        -> set experiment status=running
        -> live PR traffic bucketed by variant  (resolveArm)
        -> collect runs + HITL decisions        (experiment_runs, review_telemetry)
        -> rank + promote                       (admin_rankings, active_flows)
        -> stats (p-value, Cohen d, Wilson)     (Python /analyze -> eval_summaries)

---

## 6. What the Experiments page does today (clarification)

The frontend Experiments page is the closest thing to a configuration page and
currently provides:

- Create an experiment (name, rollout %, min sample, treatment flow + skills/MCP).
- Live A/B report (per-arm composite, confidence intervals, significance-gated winner).
- Deliberate benchmark panel (run all arms on a pasted diff, rank, promote).
- Methodology caveat note.

With this change, the reusable-structure layer (/agent-structures) plus the
two-structure selection (/experiments/from-structures) are the backend that the
"design page" and "configuration page" UI should call.
