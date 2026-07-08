# Complete Setup Guide

From zero to working AI code review platform with HITL approval workflow.

## Prerequisites

- **Node.js 20+** and **Yarn 4** (`corepack enable`)
- **Docker Desktop** (for PostgreSQL + Redis)
- **GitHub account** with repository admin access
- **Cloudflare account** (free tier, for exposing localhost)
- **API key**: DeepSeek OR Anthropic (Claude)

## Step 1 — Clone and install

```bash
git clone <your-repo-url>
cd codereviewer
yarn install
```

## Step 2 — Environment configuration

Create `.env` in the project root:

```bash
# Required
DATABASE_URL=postgresql://aigov:aigov123@localhost:5432/aigov
REDIS_HOST=localhost
REDIS_PORT=6379
JWT_SECRET=$(openssl rand -base64 64)

# API keys (at least one required)
DEEPSEEK_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# GitHub integration
GITHUB_TOKEN=ghp_...        # PAT with contents:read + pull_requests:write
WEBHOOK_SECRET=your-secret  # For HMAC validation

# Review modes
AUDIT_MODE=sdk   # inline | sdk | sandbox
DECOMP_MODE=inline
```

## Step 3 — Start the platform (Skaffold)

**For local development:**

```bash
# Terminal 1 — keep this running
skaffold dev
# → Builds images, deploys to Docker Desktop K8s, port-forwards :3000 + :5173
# → Watches for changes, auto-rebuilds
```

**For staging/production:**

```bash
skaffold run -f skaffold.prod.yaml
# → Builds images with git commit SHA tags
# → Pushes to container registry
# → Deploys to your production cluster
# → No port-forward (use Ingress/Cloudflare)
```

**Two Skaffold configs:**

| File | Purpose | Image tag | Port-forward | Watch |
|---|---|---|---|---|
| `skaffold.yaml` | Dev | `dev` (fixed) | :3000, :5173 | Yes |
| `skaffold.prod.yaml` | Staging/Prod | Git SHA | None | No |

Skaffold handles everything:

| Skaffold does | What happens |
|---|---|
| Builds images | `aigov-backend:dev` + `aigov-frontend:dev` |
| Deploys to K8s | PostgreSQL, Redis, Backend, Frontend |
| Pushes DB schema | Backend startup runs migrations |
| Port-forwards | `localhost:3000` → backend, `localhost:5173` → frontend |
| Watches for changes | Auto-rebuilds on source file changes |

Verify:

```bash
curl http://localhost:3000/api/v1/health
# → { "status": "ok", "timestamp": "...", "uptime": ... }

curl http://localhost:3000/docs
# → Swagger UI with all endpoints
```

**Alternative without Skaffold** — use Docker Compose instead:

```bash
docker compose -f docker-compose.infra.yml up -d   # PostgreSQL + Redis
yarn db:push                                        # Push schema
yarn workspace backend dev                          # Backend on :3000
yarn workspace frontend dev                         # Frontend on :5173
```

## Step 4 — Set up Cloudflare Tunnel

### 7a. Install cloudflared

```bash
# macOS
brew install cloudflare/cloudflare/cloudflared

# Linux
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
chmod +x cloudflared
sudo mv cloudflared /usr/local/bin/

# Windows (PowerShell as Admin)
winget install cloudflare.cloudflared
```

### 7b. Authenticate and create tunnel

```bash
cloudflared tunnel login
cloudflared tunnel create aigov
cloudflared tunnel route dns aigov aigov.yourdomain.com
cloudflared tunnel run aigov
```

The tunnel creates an outbound connection to Cloudflare's edge. No inbound ports needed.
Traffic goes: `https://aigov.yourdomain.com` → Cloudflare → `localhost:3000`

### 7c. Verify

```bash
curl https://aigov.yourdomain.com/api/v1/health
# → { "status": "ok" }
```

## Step 5 — Configure GitHub Webhook

### 8a. Create a GitHub Personal Access Token

Go to GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens

| Setting | Value |
|---|---|
| Repository access | Select your repositories |
| Contents | Read |
| Pull requests | Read and write |
| Webhooks | Read and write |

Copy the token. Add it to `.env`:

```bash
GITHUB_TOKEN=github_pat_...
```

### 8b. Generate webhook secret

```bash
openssl rand -hex 32
```

Copy the output. Add it to `.env`:

```bash
WEBHOOK_SECRET=<the-hex-string>
```

### 8c. Add webhook in GitHub

1. Go to your repo → Settings → Webhooks → Add webhook
2. **Payload URL**: `https://aigov.yourdomain.com/api/v1/webhooks/github`
3. **Content type**: `application/json`
4. **Secret**: same hex string from step 8b
5. **Events**: Pull requests
6. **Active**: ✓

### 8d. Test the webhook

1. Open a test PR in your repo
2. Go to Settings → Webhooks → Recent Deliveries
3. Should show HTTP 202 Accepted with `auditJobId` and `reviewThreadId`

```json
{
  "status": "accepted",
  "prNumber": 42,
  "repository": "org/repo",
  "sourceBranch": "feature/test",
  "targetBranch": "main",
  "author": "developer",
  "commitSha": "abc123...",
  "auditJobId": "...",
  "reviewThreadId": "..."
}
```

## Step 6 — Start the Desktop App

```bash
# Terminal 2 (while skaffold dev is running in Terminal 1)
yarn workspace aigov-desktop start
```

The app will:
1. Open the HITL review panel
2. Poll `/health` until the backend is reachable
3. Show "Connected" when Skaffold has the backend running
4. Show "Backend not ready — run `skaffold dev`" if unreachable

## Step 7 — Test the full flow

```bash
# 1. Open a PR in your GitHub repo
# 2. Webhook arrives at your Cloudflare-proxied backend
# 3. HMAC validation passes
# 4. Two pipelines start simultaneously:
#    - Audit (scoring) via BullMQ
#    - Review (HITL) via LangGraph
# 5. Desktop app shows:
#    - Activity board: repo, branch, PR#, author
#    - Review list: all pending reviews (click to switch)
#    - Monitor: diff (left) + AI review text (right)
#    - Score bar: compliance%, efficiency%, coverage%
#    - Decision gate: Approve/Cancel buttons
# 6. Click "Approve & Comment" → review posts to GitHub
# 7. Scores continue updating if audit is still running
```

## How it works — Dual pipeline

Every PR triggers two independent pipelines:

| Pipeline | Queue | Engine | Output | Where to see it |
|---|---|---|---|---|
| **Scoring** | BullMQ `audits` | AuditProcessor (inline/sdk/sandbox) | compliance%, efficiency%, coverage% | Desktop score bar, Web dashboard |
| **Review** | BullMQ `reviews` | LangGraph (3 nodes + interrupt) | Text review (markdown) | Desktop monitor, GitHub PR comment |

**Scoring is automatic.** The audit runs in one of three modes (`AUDIT_MODE`):
`inline` (regex), `sdk` (Claude SDK), or `sandbox` (K8s CodeWhale).

**Review is human-in-the-loop.** LangGraph generates the review text, then
pauses. You read it, edit or reject it, then click Approve to post.

**Both run on every PR.** You can't have one without the other. The scoring
happens even if you cancel the review.

## Troubleshooting

| Problem | Check |
|---|---|
| Docker containers won't start | `docker ps`, ensure Docker Desktop is running |
| DB migration fails | Check `DATABASE_URL` in `.env`, ensure PostgreSQL is healthy |
| Backend won't start | `yarn workspace backend build` first, check port 3000 is free |
| Webhook returns 401 | Verify `WEBHOOK_SECRET` matches GitHub webhook secret |
| Cloudflare tunnel fails | `cloudflared tunnel list`, verify DNS record |
| Desktop app shows "Docker not running" | Start Docker Desktop, wait 30 seconds, restart app |
| Review text is placeholder | Set real `DEEPSEEK_API_KEY` or `ANTHROPIC_API_KEY` in `.env` |
| Socket.IO connection fails | Check backend is running, port 3000 not blocked by firewall |


## Quick reference — all environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `REDIS_HOST` | Yes | `localhost` | Redis host for BullMQ |
| `REDIS_PORT` | Yes | `6379` | Redis port |
| `JWT_SECRET` | Yes | — | JWT signing key |
| `DEEPSEEK_API_KEY` | One required | — | DeepSeek API key |
| `ANTHROPIC_API_KEY` | One required | — | Anthropic API key |
| `GITHUB_TOKEN` | Yes | — | GitHub PAT for API access |
| `WEBHOOK_SECRET` | Yes | — | HMAC secret for webhook validation |
| `AUDIT_MODE` | No | `inline` | `inline` \| `sdk` \| `sandbox` |
| `DECOMP_MODE` | No | `inline` | `inline` \| `sandbox` |
| `SDK_MODEL` | No | `claude-sonnet-4-20250514` | Model for SDK mode |
| `K8S_NAMESPACE` | No | `codewhale-runner` | Sandbox namespace |
| `CORS_ORIGIN` | No | `http://localhost:5173` | Frontend origin |
