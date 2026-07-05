# CLAUDE.md

## Common Commands

### Development
| Command | Description |
|---------|-------------|
| `yarn dev:infra` | Start infrastructure only (DBs, Redpanda, Redis, ES, NATS) — run services natively |
| `yarn dev:infra:down` | Stop infrastructure |
| `yarn dev` | Docker Compose full stack (infra + all services, hot reload) |
| `yarn dev:down` | Stop full stack |
| `yarn skaffold:dev` | Skaffold watch: build + deploy to local K8s, port-forward |
| `yarn skaffold:dev:debug` | Skaffold with sequential builds (prevents resource contention) |
| `yarn skaffold:run` | One-shot build + deploy |
| `yarn skaffold:build` | Build images only (no deploy) |
| `yarn start` / `yarn build` / `yarn test` / `yarn lint` | Run across all projects (NX) |

### Per-service
```bash
nx build <project>          # Build single project
nx test <project>           # Test single project (--coverage for coverage)
nx lint <project>           # Lint single project
cd apps/nestjs-services/<service> && yarn start:dev   # NestJS watch mode
cd apps/frontend && yarn dev                           # Next.js dev (port 3002)
cd apps/admin-frontend && yarn dev                     # Admin Next.js dev (port 3004)
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

Neon (production): `yarn db:push:neon:<service>` or `yarn db:push:neon:all` (auth, user, vendor, event).

### Database Reset
| Command | Description |
|---------|-------------|
| `yarn db:truncate:docker` | Truncate all tables (Docker PG) |
| `yarn db:truncate:k8s` | Truncate all tables (K8s PG) |
| `yarn db:reset:docker` | Truncate + re-migrate (Docker) |
| `yarn db:reset:k8s` | Truncate + re-migrate (K8s) |

### Sample Data
| Command | Description |
|---------|-------------|
| `yarn sample-data:migrate` | Seed all databases with sample data (local) |
| `yarn sample-data:docker:migrate` | Seed via Docker |
| `yarn sample-data:kafka` | Generate sample Kafka events |
| `yarn sample-data:kafka:stream` | Stream live sample events (20 events, 10s delay) |

### Kubernetes
| Command | Description |
|---------|-------------|
| `yarn k8s:apply` / `yarn k8s:delete` | Production overlay |
| `yarn k8s:apply:staging` / `yarn k8s:delete:staging` | Staging overlay |

### Docker utilities
| Command | Description |
|---------|-------------|
| `yarn affected:docker:build` | Build images for NX-affected services |
| `yarn affected:docker:push` | Build + push images for affected services |
| `yarn validate:dockerfiles` | Verify all Dockerfiles reference required shared libs |

---

## Services

| Service | HTTP | Debug | Database | Status |
|---------|------|-------|----------|--------|
| **api-gateway** | 3000 | 9229 | — (proxy only) | Active |
| **auth-service** | 3001 | 9230 | `auth_db` | Active |
| **user-service** | 3002 | 9231 | `user_db` | Active |
| **vendor-service** | 3003 | 9232 | `vendor_db` | Active |
| **event-service** | 3004 | 9233 | `event_db` | Active |
| **booking-service** | 3007 | 9234 | `booking_db` | Active — Stripe payments, webhooks, payouts |
| **search-service** | 3060 | 9235 | External (ES + pgvector) | Active |
| **agent-service** | 3010 | 9234 | `agent_db` (pgvector) | Active — LLM agent, RAG, BullMQ |
| **notification-service** | 3008 | 9236 | `notification_db` | Active — multi-channel (email/SMS/push), templates |
| **analytics-service** | — | — | — | Stub (webpack.config.js only) |
| **admin-service** | 3009 | 9237 | `admin_db` | Active — feature flags, audit logs, vendor mgmt proxy |

### Frontends
| App | Framework | Docker Port | Local Dev |
|-----|-----------|-------------|-----------|
| **frontend** | Next.js 14, TanStack Query, Zustand, Shadcn/ui | 3005 | `yarn dev` (port 3002) |
| **admin-frontend** | Next.js 14, same stack + react-day-picker, sonner | 3004 | `yarn dev` (port 3004) |

### Python Workers
| Service | Entry Point | Port | Schedule |
|---------|-------------|------|----------|
| **inference** | `uvicorn inference.api:app` | 8000 | Deployment (3 replicas, HPA) |
| **kafka-consumers** | `python -m kafka-consumers.user_activity` | — | Deployment (2 replicas) |
| **ml-training** | `python -m ml-training.data_pipeline` | — | CronJob (daily 4 AM) |

All three share one Docker image (`polydom/python-workers:latest`) with different entrypoints. Managed in `kubernetes/python-workers/` (separate from main kustomization, not in Skaffold).

---

## Shared Libraries (`libs/`)

| Library | Package | Coupling | Has Build Target |
|---------|---------|----------|-----------------|
| `shared-types` | `@polydom/shared-types` | Framework-agnostic | Yes |
| `auth` | `@polydom/auth` | NestJS | Yes |
| `kafka-client` | `@polydom/kafka-client` | NestJS | Yes |
| `nats-client` | `@polydom/nats-client` | NestJS | Yes |
| `database-client` | `@polydom/database-client` | NestJS | Yes |
| `elasticsearch-client` | `@polydom/elasticsearch-client` | Mixed | Yes |
| `utils` | `@polydom/utils` | Mixed | Yes |

**Key rule**: Libraries marked "NestJS-coupled" use `@Injectable()` and assume `@nestjs/common` is available — fine for this monorepo, limits reuse outside NestJS. `workspace.json` registers all 16 NX projects (10 services + 6 libs); the `auth` lib is in `tsconfig` paths but not in `workspace.json`.

---

## Architecture

**Platform**: NX monorepo for an event booking platform connecting musicians, organizers, and users.

**Patterns**:
- **Microservices**: Each service owns its database (PostgreSQL + Drizzle ORM)
- **API Gateway**: Single entry point, proxy pattern to backend services
- **Event-driven**: Redpanda (6 topics, Kafka API-compatible) for async communication + NATS for lightweight messaging
- **CQRS**: Search service uses Elasticsearch for reads
- **Saga**: Distributed transaction orchestration (auth-service `SagaExecutor`)
- **Hexagonal**: user-service uses domain/infrastructure/application layers with multi-DB adapters

**Infrastructure**: PostgreSQL 15 + pgvector, MongoDB 7, Redis 7, Redpanda v24.2, NATS 2.10, Elasticsearch 8.11, Prometheus, Grafana, Kibana

**CI/CD**: GitHub Actions — `pr-check.yaml` (lint, test, dry-run build, validate), `deploy.yaml` (detect changes → test → build+push → kustomize deploy)

**IaC**: Terraform modules for AWS and DigitalOcean in `iac/terraform/`

---

## Config Sync Rule (Docker Compose ↔ Kubernetes)

**CRITICAL**: When changing one, update the other:

| What | Docker Compose | Kubernetes |
|------|---------------|------------|
| Databases | `tools/postgres-init/*.sql` | `kubernetes/local/postgres-init.yaml` |
| Secrets | `.env` / `.env.example` | `kubernetes/local/secrets.yaml` |
| Service config | `docker-compose.yml` | `kubernetes/local/services.yaml` |
| Infrastructure | `docker-compose.infra.yml` | `kubernetes/local/infrastructure.yaml` |

---

## Key URLs (local dev)

| Service | URL |
|---------|-----|
| Frontend | http://localhost:3002 |
| Admin Frontend | http://localhost:3004 |
| API Gateway | http://localhost:3000 |
| pgAdmin | http://localhost:5050 (admin@polydom.com / admin) |
| Grafana | http://localhost:3001 |
| Kibana | http://localhost:5601 |
| Inference API | http://localhost:8000 |

---

## Creating a New NestJS Service

1. `nx generate @nx/nest:library <name> --directory=apps/nestjs-services`
2. Add to `docker-compose.yml` and `kubernetes/local/services.yaml`
3. Add API Gateway proxy route in `apps/nestjs-services/api-gateway/src/proxy/`
4. Add database to `tools/postgres-init/01-create-databases.sql` and `kubernetes/local/postgres-init.yaml`
5. Add to `skaffold.yaml` (artifact + portForward)
6. Add to `workspace.json` and CI matrices (`.github/workflows/`)
7. Run the `debug-setup` agent for debug wiring (project.json, Dockerfile, K8s ports, VS Code launch config)
8. Run `/build-check` to validate

## Code Standards
- TypeScript strict mode, ESLint, Prettier, conventional commits
- Jest + Supertest for testing
- Each service Dockerfile is 2-stage (development + builder), `node:20-alpine`, uses `scripts/entrypoint-dev.sh`
