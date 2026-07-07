# CI/CD & Webhook Integration

Two pipelines run in parallel when a PR is opened:

1. **Scoring Pipeline** — automated scoring via BullMQ (compliance%, efficiency%, coverage%)
2. **HITL Review Pipeline** — human-in-the-loop via LangGraph (approve/cancel before posting)

## Architecture

```
PR opened on GitHub
  │
  ├─→ Option 1: GitHub Webhook (recommended for HITL)
  │     POST /api/v1/webhooks/github
  │     → HMAC validation
  │     → Enqueues Audit (scoring) + Review (HITL)
  │
  └─→ Option 2: GitHub Actions (automated scoring only)
        .github/workflows/code-review.yml
        → POST /api/v1/audits
        → Scores stored in PostgreSQL
```

## Option 1 — GitHub Webhook (HITL flow)

### Prerequisites

1. Cloudflare Tunnel running (see docs/setup.md Step 7)
2. `GITHUB_TOKEN` and `WEBHOOK_SECRET` in `.env`
3. Backend accessible at your Cloudflare domain

### Flow

```
Developer opens PR
  → GitHub sends webhook to https://aigov.yourdomain.com/api/v1/webhooks/github
    → HMAC validation (SHA-256, constant-time comparison)
      → PASS: continue
      → FAIL: 401 Unauthorized
    → Extract metadata (repo, branches, author, diff_url)
    → Start TWO parallel pipelines:

Pipeline 1: Audit (scoring)
  → BullMQ queue 'audits'
  → AuditProcessor: inline | sdk | sandbox
  → Scores stored in ai_audits table
  → Dashboard shows compliance%, efficiency%, coverage%

Pipeline 2: Review (HITL)
  → BullMQ queue 'reviews'
  → LangGraph: fetchDiff → generateReview → INTERRUPT
  → Desktop app shows review text + Approve/Cancel
  → Human clicks Approve
    → POST /api/v1/reviews/:id/approve
    → LangGraph resumes: postToGitHub
    → Octokit posts review to PR
```

### Testing webhooks locally

Use smee.io to proxy webhooks to localhost:

```bash
# Install smee client
npm install -g smee-client

# Create a channel at https://smee.io
# Run the proxy
smee -u https://smee.io/your-channel -t http://localhost:3000/api/v1/webhooks/github

# Add https://smee.io/your-channel as webhook URL in GitHub
```

## Option 2 — GitHub Actions (scoring only)

### Workflow file

`.github/workflows/code-review.yml` triggers on:

- `pull_request: [opened, synchronize, reopened]`
- `workflow_dispatch` (manual trigger)

### Required secrets

In your GitHub repo: Settings → Secrets and variables → Actions → New repository secret

| Secret | Value |
|---|---|
| `AIGOV_API_URL` | `https://aigov.yourdomain.com` |
| `AIGOV_API_KEY` | Organization API key from platform |
| `AIGOV_ORG_ID` | UUID of your organization |
| `AIGOV_REPO_ID` | UUID of the linked repository |

### What the workflow does

1. Checks out the repo with full history
2. Runs `git diff base...head` to collect the diff
3. Reads full contents of each changed file
4. Builds a JSON payload with `jq`
5. POSTs to `/api/v1/audits` with `x-api-key` auth
6. Posts a PR comment confirming audit is queued

### Manual trigger

```
gh workflow run "Code Review" -f pr_number=42
```

## Cloudflare Tunnel for production

### Local machine

```bash
cloudflared tunnel login
cloudflared tunnel create aigov
cloudflared tunnel route dns aigov aigov.yourdomain.com
cloudflared tunnel run aigov
# Runs in foreground — use tmux/screen or create a systemd service
```

### K8s deployment

The tunnel can run as a pod in your cluster:

```bash
# Get token
cloudflared tunnel token aigov

# Create secret
kubectl -n aigov create secret generic cloudflare-tunnel \
  --from-literal=token=<tunnel-token>

# Deploy
kubectl apply -f k8s/cloudflared.yaml
```

### Nginx / reverse proxy alternative

If you prefer a traditional reverse proxy instead of Cloudflare Tunnel:

```nginx
server {
    listen 443 ssl;
    server_name aigov.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
    }

    # WebSocket support for real-time review streaming
    location /reviews/ {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

## GitHub token scopes

| Scope | Purpose |
|---|---|
| `contents: read` | Fetch file contents, list PR files |
| `pull_requests: read` | Get PR metadata, diff |
| `pull_requests: write` | Post review comments |
| `webhooks: read & write` | (Only needed if creating webhook programmatically) |

## Running locally with Skaffold

Skaffold provides a production-like local development environment using the same
K8s manifests you'd deploy to a real cluster.

```bash
# Terminal 1 — starts the platform
skaffold dev

# Terminal 2 — opens the review panel
yarn workspace aigov-desktop start
```

Skaffold manages the full stack:

| Component | K8s Resource | Port |
|---|---|---|
| PostgreSQL | StatefulSet + PVC | 5432 (cluster-internal) |
| Redis | Deployment | 6379 (cluster-internal) |
| Backend | Deployment (2 replicas) | 3000 (port-forwarded) |
| Frontend | Deployment (2 replicas) | 5173 (port-forwarded) |

The backend connects to PostgreSQL and Redis via K8s DNS:
- `postgres.aigov.svc.cluster.local:5432`
- `redis.aigov.svc.cluster.local:6379`

## Security notes

- Webhook HMAC uses SHA-256 with constant-time comparison (prevents timing atacks)
- `rawBody: true` in NestJS config preserves the raw request body for HMAC
- The webhook secret must match exactly between GitHub and `.env`
- API endpoints are protected by `x-api-key` header (Passport `api-key` strategy)
- Review posting uses Octokit with the same `GITHUB_TOKEN`
