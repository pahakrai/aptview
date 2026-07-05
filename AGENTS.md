# aigov — Project Agent Instructions

This file provides guidance to AI agents (CodeWhale, Claude Code, etc.) when working with code in this repository.

## Project Overview

AI Code Governance Platform — a SaaS that governs the requirement→task→code pipeline for AI-assisted development.

- **Backend**: NestJS monolith (`apps/backend`)
- **Frontend**: React + Vite + Tailwind (`apps/frontend`)
- **Shared libs**: TypeScript types, database client, utilities (`libs/`)
- **Package manager**: Yarn 4 (node-modules linker)
- **Monorepo tool**: Nx 19

## Build and Development Commands

```bash
# Install dependencies
yarn install

# Start all services (Docker)
yarn dev

# Start infrastructure only (PostgreSQL + Redis)
yarn dev:infra

# Run backend in watch mode (local)
yarn workspace backend dev

# Run frontend in dev mode (local)
yarn workspace frontend dev

# Database
yarn db:generate       # Generate Drizzle migrations
yarn db:migrate        # Run migrations
yarn db:seed           # Seed dev data
yarn db:push           # Push schema directly (dev only)

# Build all
yarn build

# Lint all
yarn lint

# Test all
yarn test
```

## Architecture Overview

### Modules (apps/backend/src/modules/)

| Module | Purpose |
|--------|---------|
| `auth` | API key validation, JWT, organization-scoped auth |
| `organizations` | Org CRUD, enforcement mode, settings |
| `repositories` | Repository linking, webhook configuration |
| `audits` | AI audit ingestion, pass/fail verdicts, PR comment generation |
| `decomposition` | Task decomposition engine, scope boundaries, feedback loop |
| `standards` | Code guidelines CRUD, violation pattern detection |
| `webhooks` | GitHub / Jira / Linear webhook ingestion, validation |

### Data Flow

```
GitHub PR webhook
  → webhooks module validates & enqueues
    → Redis queue (Bull/BullMQ)
      → audits module: spins ephemeral Docker sandbox
        → analyzes code diff against org standards
          → returns pass/fail + scope creep report
            → posts PR comment via GitHub API
              → stores audit record in PostgreSQL
```

### Key Tables (apps/backend/src/database/schema.ts)

- `organizations` — tenants
- `repositories` — linked repos per org
- `code_guidelines` — org-specific coding standards
- `ai_audits` — audit results per PR
- `scope_violations` — detected scope creep events
- `decomposed_tasks` — Jira/Linear task → file boundaries
- `decomposition_feedback` — developer ratings of decomposition quality
- `enforcement_events` — enforcement mode change history
- `api_keys` — org-scoped API tokens

## Commit Messages

Use conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`
