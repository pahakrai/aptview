# AI Code Governance Platform

A SaaS platform governing the requirement→task→code pipeline for AI-assisted development.

## Quick Start

```bash
# 1. Install dependencies
yarn install

# 2. Start infrastructure (PostgreSQL + Redis)
yarn dev:infra

# 3. Push database schema
yarn db:push

# 4. Seed development data
yarn db:seed

# 5. Start backend (http://localhost:3000)
yarn workspace backend dev

# 6. Start frontend (http://localhost:5173)
yarn workspace frontend dev
```

Or start everything with Docker:

```bash
yarn dev
```

## Project Structure

```
aigov/
├── apps/
│   ├── frontend/          React + Vite + Tailwind
│   └── backend/           NestJS monolith (all modules)
├── libs/
│   ├── shared-types/      TypeScript interfaces and enums
│   ├── database-client/   Drizzle ORM client
│   └── utils/             Shared utilities
├── scripts/               Development scripts
├── tools/                 Development tooling
├── docs/                  Architecture docs
├── docker-compose.yml     Full dev environment
└── docker-compose.infra.yml  Infrastructure only
```

## API Documentation

Start the backend and visit `http://localhost:3000/docs` for Swagger UI.

## Key Features

- **Pattern-Based Auditing**: Define regex patterns as coding standards. Every PR is checked against active patterns.
- **Scope Creep Detection**: Measure actual LOC vs estimated LOC to catch AI over-engineering.
- **Task Decomposition**: Break Jira/Linear tasks into scoped file boundaries.
- **Graduated Enforcement**: `advisory → scope_only → full` — adopt without velocity shock.
- **Proactive Standards Context**: Generate paste-able Markdown for AI coding tools.

## Architecture

See [docs/architecture.md](docs/architecture.md) for full details.

## License

Proprietary — all rights reserved.
