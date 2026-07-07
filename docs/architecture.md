# Architecture: AI Code Governance Platform

## Overview

A SaaS platform governing the requirement→task→code pipeline for AI-assisted development. Unlike code review tools that react to bad code, this platform prevents it by:

1. **Sharpening requirements** before they reach the AI
2. **Defining task boundaries** (which files, max LOC)
3. **Enforcing code standards** via automated audits

## System Architecture

```
┌─────────────────────────────────────────────────┐
│                    Frontend                      │
│              React + Vite + Tailwind             │
│         Dashboard | Audits | Standards | Settings │
└──────────────────────┬──────────────────────────┘
                       │ HTTP (REST)
                       ▼
┌─────────────────────────────────────────────────┐
│                NestJS Backend (Monolith)          │
│                                                   │
│  ┌──────────┐ ┌──────────────┐ ┌─────────────┐  │
│  │   Auth   │ │ Organizations │ │ Repositories │  │
│  └──────────┘ └──────────────┘ └─────────────┘  │
│  ┌──────────┐ ┌──────────────┐ ┌─────────────┐  │
│  │  Audits  │ │ Decomposition │ │  Standards  │  │
│  └────┬─────┘ └──────┬───────┘ └─────────────┘  │
│       │              │                           │
│  ┌────┴──────────────┴─────┐  ┌────────────────┐ │
│  │   BullMQ (Redis Queue)  │  │    Webhooks    │ │
│  └─────────────────────────┘  └────────────────┘ │
└──────────────────────────────────────────────────┘
         │                   │
    ┌────▼────┐          ┌───▼───┐
    │PostgreSQL│          │ Redis │
    └─────────┘          └───────┘
```

## Data Flow

```
GitHub PR webhook
  → webhooks module validates & enqueues
    → Redis queue (BullMQ)
      → Audit processor: pattern analysis
        → Returns pass/fail + scope creep report
          → Stores audit record in PostgreSQL
```

## HITL Review Pipeline (Desktop App)

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Electron Desktop App                            │
│  Service Control | Status | Activity Board | HITL Gate | Config    │
└────────────────────────────┬────────────────────────────────────────┘
                             │ WebSocket + HTTP
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        NestJS Backend                                 │
│                                                                       │
│  Webhook → HMAC Validation                                           │
│      │                                                                │
│      ├─→ BullMQ 'audits' queue → AuditProcessor (scoring)            │
│      │     └─→ PostgreSQL: ai_audits (compliance%, efficiency%)       │
│      │                                                                 │
│      └─→ BullMQ 'reviews' queue → ReviewProcessor                     │
│            └─→ LangGraph Pipeline:                                    │
│                  fetchDiff → generateReview → INTERRUPT               │
│                      │                                                │
│                      ▼ (human clicks Approve)                         │
│                  postToGitHub → Octokit → PR comment                  │
│                                                                       │
│  Checkpoints: Redis (MemorySaver)                                    │
│  Streaming:   Redis Pub/Sub → WebSocket → Electron                   │
└───────────────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

1. **Monolith, not microservices**: Single NestJS app with feature modules. Simpler to develop and deploy until you have 100+ customers. The module boundaries are clean — extracting a service later is a refactor, not a rewrite.

2. **Drizzle ORM, not Prisma**: Better SQL control, lighter, no code generation step. Schema is defined as TypeScript tables — single source of truth.

3. **Redis-backed job queue (BullMQ)**: Audits and decomposition are async jobs. Redis is fast, simple, and sufficient for this workload.

4. **Graduated enforcement**: `advisory → scope_only → full`. Teams adopt without velocity shock, then progressively tighten governance.

5. **Ephemeral Docker sandbox placeholder**: The audit processor currently runs inline. In production, this should use ephemeral Docker containers with gVisor/Firecracker for security isolation.

## Database Schema (9 tables)

- `organizations` — tenants with enforcement mode
- `repositories` — linked repos with webhook secrets
- `api_keys` — org-scoped API tokens (SHA-256 hashed)
- `code_guidelines` — regex-based coding standards
- `ai_audits` — audit results per PR (verdict, violation counts, scope creep)
- `scope_violations` — detected scope creep events
- `decomposed_tasks` — AI-generated task breakouts with file boundaries
- `decomposition_feedback` — developer quality ratings
- `enforcement_events` — audit log of mode changes

## API Endpoints

```
POST   /api/v1/auth/api-keys              Create API key
POST   /api/v1/auth/api-keys/revoke       Revoke API key

POST   /api/v1/organizations              Create org
GET    /api/v1/organizations/:id          Get org
GET    /api/v1/organizations/slug/:slug   Get by slug
PATCH  /api/v1/organizations/:id/enforcement  Change enforcement mode

POST   /api/v1/repositories               Link repo
GET    /api/v1/repositories/org/:orgId    List repos
GET    /api/v1/repositories/:id           Get repo
PATCH  /api/v1/repositories/:id           Update repo

POST   /api/v1/audits                     Trigger audit
GET    /api/v1/audits/repo/:repoId        List audits (paginated)
GET    /api/v1/audits/:id                 Get audit
GET    /api/v1/audits/:id/violations      Get scope violations
GET    /api/v1/audits/org/:orgId/stats    Org aggregate stats

POST   /api/v1/decomposition              Decompose task
GET    /api/v1/decomposition/org/:orgId   List tasks
GET    /api/v1/decomposition/:id          Get task
POST   /api/v1/decomposition/:id/feedback Submit feedback

POST   /api/v1/standards                  Create guideline
GET    /api/v1/standards/org/:orgId       List guidelines
GET    /api/v1/standards/:id              Get guideline
PATCH  /api/v1/standards/:id              Update guideline
DELETE /api/v1/standards/:id              Delete guideline
GET    /api/v1/standards/org/:orgId/context   Get Markdown context
GET    /api/v1/standards/org/:orgId/violations/top  Top violations

POST   /api/v1/webhooks/github            GitHub PR webhook (HMAC validated)
POST   /api/v1/webhooks/jira              Jira issue webhook
POST   /api/v1/webhooks/linear            Linear issue webhook

POST   /api/v1/reviews/start              Start HITL review (webhook → LangGraph)
POST   /api/v1/reviews/:id/approve        Approve review → post to GitHub
POST   /api/v1/reviews/:id/cancel         Cancel review → discard
GET    /api/v1/reviews/pending            List pending reviews
GET    /api/v1/reviews/:id                Get review status + text

GET    /api/v1/audits/:id/scores          Get compliance/efficiency/coverage scores
GET    /api/v1/audits/org/:orgId/score-trends  Weekly score averages
GET    /api/v1/decomposition/:id/sub-tasks     List quantifiable sub-tasks
POST   /api/v1/decomposition/sprint       Decompose a sprint into tasks
```
