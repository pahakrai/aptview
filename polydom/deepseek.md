# Polydom — Event Booking Platform for Casual Musicians

## Overview

Polydom is a comprehensive event booking platform connecting casual musicians and activity organizers with users looking for local events. Three user roles: **Common Users**, **Vendors** (Event Organizers), and **System Administrators**.

## Technology Stack

### Frontend
- **Next.js 14+** with App Router
- **Shadcn/ui** component library
- **TanStack Query** for server state
- **Zustand** for client state
- **Stripe** for payment processing
- **Tailwind CSS** for styling

### Backend Microservices (NestJS)
All services use **Drizzle ORM** with per-service PostgreSQL databases (local via Docker, production via Neon serverless).

| Service | Port | Debug | Database | Status |
|---------|------|-------|----------|--------|
| **api-gateway** | 3000 | 9229 | gateway_db (proxy only) | Active |
| **auth-service** | 3001 | 9230 | auth_db | Active |
| **user-service** | 3002 | 9231 | user_db | Active |
| **vendor-service** | 3003 | 9232 | vendor_db | Active |
| **event-service** | 3004 | 9233 | event_db | Active |
| **search-service** | 3060 | 9235 | External (ES + pgvector) | Active |
| **agent-service** | 3010 | 9234 | agent_db (pgvector) | Active — LLM agent, RAG, BullMQ |
| **booking-service** | — | — | booking_db | DB layer only (no app bootstrap) |
| **notification-service** | — | — | notification_db | Stub (webpack.config.js only) |
| **analytics-service** | — | — | analytics_db | Stub (webpack.config.js only) |
| **admin-service** | — | — | admin_db | Stub (webpack.config.js only) |

### Frontends
| App | Framework | Docker Port | Local Dev |
|-----|-----------|-------------|-----------|
| **frontend** | Next.js 14, TanStack Query, Zustand, Shadcn/ui | 3005 | `yarn dev` (port 3002) |
| **admin-frontend** | Next.js 14, same stack + react-day-picker, sonner | 3004 | `yarn dev` (port 3004) |

### Python Workers
| Component | Entry Point | Port | Schedule |
|-----------|-------------|------|----------|
| **inference** | `uvicorn inference.api:app` | 8000 | Deployment (3 replicas, HPA) |
| **kafka-consumers** | `python -m kafka-consumers.user_activity` | — | Deployment (2 replicas) |
| **ml-training** | `python -m ml-training.data_pipeline` | — | CronJob (daily 4 AM) |

All three share one Docker image (`polydom/python-workers:latest`) with different entrypoints.

### Data Infrastructure
- **PostgreSQL 15 + pgvector** — primary relational database, per-service databases
- **MongoDB 7** — flexible document storage
- **Redis 7** — caching, session storage, rate limiting
- **Elasticsearch 8.11** — full-text search, geospatial queries
- **Redpanda v24.2** — Kafka API-compatible event streaming (6 topics)
- **NATS 2.10** — lightweight messaging

### DevOps
- **Docker** — containerization (node:20-alpine, 2-stage builds)
- **Kubernetes** — orchestration (Kustomize overlays: local, staging, production, home-lab)
- **Skaffold** — K8s dev loop (watch → build → deploy)
- **GitHub Actions** — CI/CD (pr-check.yaml, deploy.yaml)
- **Monitoring** — Prometheus, Grafana, Kibana
- **Terraform** — IaC (AWS, DigitalOcean, home-lab modules)

## Architecture Patterns

- **Microservices**: Each service owns its database, exposes well-defined APIs
- **API Gateway**: Single entry point, proxy pattern, rate limiting, circuit breaking
- **Event-Driven**: Redpanda for async communication (6 topics: `user-activities`, `booking-events`, `vendor-events`, `notification-events`, `ml-training`)
- **CQRS**: Search service uses Elasticsearch for reads, PostgreSQL for writes
- **Saga**: Distributed transaction orchestration (auth-service `SagaExecutor`)
- **Hexagonal**: user-service uses domain/infrastructure/application layers with multi-DB adapters
- **Per-service DB**: Each microservice manages its own schema, migrations, and seed data via Drizzle ORM
- **Data Sync**: Events published to Redpanda → consumers update local copies; direct API calls for real-time needs

## Repository Structure (NX Monorepo)

```
polydom/
├── nx.json                          # NX workspace config (19.8.0)
├── workspace.json                   # 16 NX projects (10 services + 6 libs)
├── package.json                     # Root package (yarn@4.14.1 workspaces)
├── tsconfig.base.json              # Base TypeScript config (strict mode)
├── docker-compose.yml              # Full stack (infra + services, hot reload)
├── docker-compose.infra.yml        # Infrastructure only
├── skaffold.yaml                   # K8s dev loop config
├── apps/
│   ├── frontend/                   # Next.js consumer app
│   ├── admin-frontend/             # Next.js admin panel
│   ├── nestjs-services/           # 11 NestJS microservices
│   │   ├── api-gateway/
│   │   ├── auth-service/
│   │   ├── user-service/
│   │   ├── vendor-service/
│   │   ├── event-service/
│   │   ├── booking-service/
│   │   ├── search-service/
│   │   ├── agent-service/
│   │   ├── notification-service/
│   │   ├── analytics-service/
│   │   └── admin-service/
│   └── python-workers/            # Python ML services
│       ├── inference/
│       ├── kafka-consumers/
│       ├── ml-training/
│       ├── schemas/
│       └── Dockerfile
├── libs/
│   ├── shared-types/              # @polydom/shared-types — framework-agnostic
│   ├── auth/                      # @polydom/auth — NestJS-coupled
│   ├── kafka-client/              # @polydom/kafka-client — NestJS-coupled
│   ├── nats-client/               # @polydom/nats-client — NestJS-coupled
│   ├── database-client/           # @polydom/database-client — NestJS-coupled
│   ├── elasticsearch-client/      # @polydom/elasticsearch-client — mixed
│   └── utils/                     # @polydom/utils — mixed
├── kubernetes/
│   ├── base/                      # Common K8s manifests
│   ├── local/                     # Local K8s dev environment
│   ├── home-lab/                  # Home lab deployment
│   ├── python-workers/            # Python workers manifests (separate kustomization)
│   └── overlays/
│       ├── production/
│       └── staging/
├── iac/terraform/                 # Terraform modules
│   ├── aws/
│   ├── digitalocean/
│   └── home-lab/
├── scripts/
│   ├── sample-data/               # Seed data generation and migration
│   ├── entrypoint-dev.sh          # Dev container entrypoint
│   ├── entrypoint-prod.sh         # Production container entrypoint
│   └── docker-build-affected.mjs  # NX-affected Docker build
└── tools/
    ├── postgres-init/             # SQL scripts for DB creation/truncation
    ├── scripts/                   # Setup and utility scripts
    └── seed-data/                 # Seed data utilities
```

## Shared Libraries

| Library | Package | Coupling | Has Build Target |
|---------|---------|----------|-----------------|
| `shared-types` | `@polydom/shared-types` | Framework-agnostic | Yes |
| `auth` | `@polydom/auth` | NestJS | Yes |
| `kafka-client` | `@polydom/kafka-client` | NestJS | Yes |
| `nats-client` | `@polydom/nats-client` | NestJS | Yes |
| `database-client` | `@polydom/database-client` | NestJS | Yes |
| `elasticsearch-client` | `@polydom/elasticsearch-client` | Mixed | Yes |
| `utils` | `@polydom/utils` | Mixed | Yes |

**Key rule**: Libraries marked "NestJS-coupled" use `@Injectable()` and assume `@nestjs/common` is available. The `auth` lib is in `tsconfig` paths but **not** registered in `workspace.json`.

## Service Details

### api-gateway (Active)
Main entry point. Request routing to microservices, authentication verification, rate limiting, circuit breaker, retry logic. Swagger at `/api-docs`.

### auth-service (Active)
JWT authentication, RBAC (user/vendor/admin roles), OAuth2 (Google, Facebook), bcrypt password hashing, token refresh mechanism. Saga executor for distributed transactions.

### user-service (Active)
User profile CRUD, preferences (musical interests, location, notification settings), activity history tracking. Hexagonal architecture with domain/infrastructure/application layers.

### vendor-service (Active)
Vendor onboarding, registration, document verification, venue management, payment settings, performance analytics.

### event-service (Active)
Event CRUD, scheduling (date/time, recurrence), ticket inventory, capacity management, dynamic pricing, discount codes.

### booking-service (DB layer only)
Reservations, Stripe payment processing, booking confirmation, QR codes, cancellation/refunds. Database schema exists but no application bootstrap.

### search-service (Active)
Elasticsearch full-text search, geospatial queries, faceted search, personalized ranking. CQRS read model.

### agent-service (Active)
LLM agent with RAG (Retrieval Augmented Generation), pgvector for embeddings, BullMQ for job queues, MCP (Model Context Protocol) integration, knowledge base management.

### notification-service (Stub)
Planned: Email/SMS/push/in-app notifications, templates, scheduling. Only webpack.config.js exists.

### analytics-service (Stub)
Planned: User activity tracking, Kafka event streaming, reporting dashboards. Only webpack.config.js exists.

### admin-service (Stub)
Planned: System overview, user management, content moderation, financial reports. Only webpack.config.js exists.

## Development Workflows

### Prerequisites
- Node.js 20+, Yarn 4.14.1
- Docker & Docker Compose (or Podman)
- (Optional) Kubernetes cluster for K8s path

### Path A: Infrastructure in Docker, Services Natively
Fastest for backend development. Infrastructure runs in Docker, services run on host with hot reload.

```bash
yarn install
cp .env.example .env
yarn dev:infra                    # Start PostgreSQL, Redpanda, Redis, ES, NATS, MongoDB

# Per-service (separate terminals)
nx serve api-gateway
nx serve auth-service
nx serve user-service
nx serve vendor-service
nx serve event-service
```

Then run DB pushes and seeds per service, or use `yarn sample-data:migrate` for all at once.

Stop: `yarn dev:infra:down` + Ctrl+C in each terminal.

### Path B: Docker Compose (Everything in Containers)
One command, hot reload via volume mounts. No host Node.js needed.

```bash
yarn install
cp .env.example .env
yarn dev                           # Start everything
yarn dev:down                      # Stop
```

### Path C: Kubernetes (Local Cluster)
Infrastructure in Docker Compose, app services in K8s. Requires Docker Desktop/Minikube/Kind.

```bash
yarn install && cp .env.example .env
yarn k8s:dev:up                    # Start infra + deploy to K8s
yarn k8s:dev:down                  # Tear down
```

### Skaffold (K8s Hot Reload)
Watch → build → deploy to local K8s with port-forward.

```bash
yarn skaffold:dev                  # Auto-build on file changes
yarn skaffold:dev:debug            # Sequential builds (prevents resource contention)
yarn skaffold:run                  # One-shot build + deploy
```

## Common Commands

### Global (all projects)
```bash
yarn start       # nx run-many --target=serve --all
yarn build       # nx run-many --target=build --all
yarn test        # nx run-many --target=test --all
yarn lint        # nx run-many --target=lint --all
yarn format      # nx format:write
```

### Per-service
```bash
nx build <project>                 # Build single project
nx test <project> --coverage       # Test single project with coverage
nx lint <project>                  # Lint single project
```

### Database (per service)
`yarn db:<action>:<service>` where `<service>` = `auth`, `user`, `vendor`, `event`, `booking`, `agent`.

| Action | Description |
|--------|-------------|
| `generate` | Generate Drizzle migrations from schema |
| `migrate` | Run pending migrations |
| `seed` | Seed database with sample data |
| `studio` | Open Drizzle Studio UI |
| `push` | Push schema directly (dev only) |

Neon (production): `yarn db:push:neon:<service>` or `yarn db:push:neon:all`.

### Database Reset
```bash
yarn db:truncate:docker           # Truncate all tables (Docker PG)
yarn db:truncate:k8s              # Truncate all tables (K8s PG)
yarn db:reset:docker              # Truncate + re-migrate (Docker)
yarn db:reset:k8s                 # Truncate + re-migrate (K8s)
```

### Sample Data
```bash
yarn sample-data:migrate          # Seed all databases (local)
yarn sample-data:docker:migrate   # Seed via Docker
yarn sample-data:kafka            # Generate sample Kafka events
yarn sample-data:kafka:stream     # Stream live sample events (20 events, 10s delay)
```

### Kubernetes
```bash
yarn k8s:apply         # Production overlay
yarn k8s:delete         # Production overlay
yarn k8s:apply:staging  # Staging overlay
yarn k8s:delete:staging  # Staging overlay
yarn k8s:apply:homelab  # Home lab overlay
yarn k8s:delete:homelab  # Home lab overlay
```

### Docker Utilities
```bash
yarn affected:docker:build        # Build images for NX-affected services
yarn affected:docker:push         # Build + push images for affected services
yarn validate:dockerfiles         # Verify Dockerfiles reference required shared libs
```

## Key URLs (local dev)

| Service | URL |
|---------|-----|
| Frontend | http://localhost:3002 |
| Admin Frontend | http://localhost:3004 |
| API Gateway + Swagger | http://localhost:3000 / http://localhost:3000/api-docs |
| pgAdmin | http://localhost:5050 (admin@polydom.com / admin) |
| Grafana | http://localhost:3001 (admin/admin) |
| Kibana | http://localhost:5601 |
| Prometheus | http://localhost:9090 |
| Inference API | http://localhost:8000 |
| Auth Service | http://localhost:3001 |
| User Service | http://localhost:3002 (backend) |
| Vendor Service | http://localhost:3003 |
| Event Service | http://localhost:3004 (backend) |

## CI/CD

### PR Checks (`pr-check.yaml`)
On PR to `main`:
- **Lint & Test**: `yarn lint` + `yarn test` across all projects
- **Detect Changes**: NX affected detection, Python worker change detection
- **Build Images (dry-run)**: Build affected Docker images without pushing
- **Validate Kustomize**: `kubectl kustomize` on base, production, staging overlays
- **Validate Dockerfiles**: Check shared lib references

### Deploy (`deploy.yaml`)
On push to `main`:
1. Detect changes (same as PR)
2. Run tests
3. Build and push Docker images
4. Kustomize deploy to Kubernetes

## Config Sync Rule (Docker Compose ↔ Kubernetes)

**CRITICAL**: When changing one, update the other:

| What | Docker Compose | Kubernetes |
|------|---------------|------------|
| Databases | `tools/postgres-init/*.sql` | `kubernetes/local/postgres-init.yaml` |
| Secrets | `.env` / `.env.example` | `kubernetes/local/secrets.yaml` |
| Service config | `docker-compose.yml` | `kubernetes/local/services.yaml` |
| Infrastructure | `docker-compose.infra.yml` | `kubernetes/local/infrastructure.yaml` |

## Code Standards
- TypeScript strict mode, ESLint, Prettier
- Conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`)
- Jest + Supertest for testing
- Each service Dockerfile: 2-stage (development + builder), `node:20-alpine`, uses `scripts/entrypoint-dev.sh` / `scripts/entrypoint-prod.sh`
- NX build cache: `build`, `lint`, `test`, `e2e` are cacheable; `production` input excludes spec/test/story files

## Creating a New NestJS Service

1. `nx generate @nx/nest:library <name> --directory=apps/nestjs-services`
2. Add to `docker-compose.yml` and `kubernetes/local/services.yaml`
3. Add API Gateway proxy route in `apps/nestjs-services/api-gateway/src/proxy/`
4. Add database to `tools/postgres-init/01-create-databases.sql` and `kubernetes/local/postgres-init.yaml`
5. Add to `skaffold.yaml` (artifact + portForward)
6. Add to `workspace.json` and CI matrices (`.github/workflows/`)
7. Wire up debug config (project.json, Dockerfile, K8s ports, VS Code launch config)
8. Run build check to validate

## File Locations Quick Reference

| Concern | Path |
|---------|------|
| NX workspace config | `nx.json`, `workspace.json` |
| Root package | `package.json` |
| Base TypeScript | `tsconfig.base.json` |
| Docker Compose (full) | `docker-compose.yml` |
| Docker Compose (infra only) | `docker-compose.infra.yml` |
| Skaffold config | `skaffold.yaml`, `skaffold.frontend.yaml` |
| K8s base | `kubernetes/base/` |
| K8s local dev | `kubernetes/local/` |
| K8s overlays | `kubernetes/overlays/` |
| K8s python workers | `kubernetes/python-workers/` |
| Terraform IaC | `iac/terraform/` |
| CI/CD workflows | `.github/workflows/` |
| Seed data scripts | `scripts/sample-data/` |
| DB init SQL | `tools/postgres-init/` |
| Entrypoint scripts | `scripts/entrypoint-dev.sh`, `scripts/entrypoint-prod.sh` |
| Python config | `apps/python-workers/config.py` |
| Agent instructions | `CLAUDE.md`, `deepseek.md` |
| DB setup guide | `DATABASE_SETUP.md` |
