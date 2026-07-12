# Configuration Guide

Everything you need to configure for the code review platform to work end-to-end.

## Where to configure

```
┌─ Desktop App ──────────────────────────────────────────────────────┐
│                                                                      │
│  Settings Overlay (click ⚙ in status bar)                           │
│  ├── Repositories: target branches per repo                         │
│  ├── Model: DeepSeek / Claude                                       │
│  └── Persona: review focus instructions                             │
│                                                                      │
│  Config Panel (left sidebar)                                        │
│  ├── Model: DeepSeek / Claude                                       │
│  ├── Review Mode: HITL / Automatic                                  │
│  ├── Code Context: Changed Files Only                               │
│  ├── Target Branches: dev, main (quick view)                       │
│  └── System Persona: review instructions                            │
│                                                                      │
├─ GitHub ────────────────────────────────────────────────────────────┤
│                                                                      │
│  Repository Settings                                                │
│  ├── Webhook: Payload URL, Secret, Events                          │
│  ├── Actions Secrets: AIGOV_API_URL, AIGOV_API_KEY, etc.           │
│  └── Branch Protection (optional)                                   │
│                                                                      │
│  Personal Access Token                                              │
│  ├── Contents: Read                                                 │
│  ├── Pull requests: Read & Write                                    │
│  └── Webhooks: Read & Write (optional)                              │
│                                                                      │
├─ Skaffold / K8s ────────────────────────────────────────────────────┤
│                                                                      │
│  k8s/configmap.yaml                                                  │
│  ├── AUDIT_MODE: sdk | inline | sandbox                              │
│  ├── SDK_MODEL: claude-sonnet-4-20250514                             │
│  ├── REVIEW_TARGET_BRANCHES: dev,main                                │
│  └── Cors, K8S_NAMESPACE, etc.                                       │
│                                                                      │
│  k8s/secrets.yaml                                                    │
│  ├── DEEPSEEK_API_KEY / ANTHROPIC_API_KEY                            │
│  ├── GITHUB_TOKEN                                                   │
│  ├── WEBHOOK_SECRET                                                 │
│  ├── JWT_SECRET                                                     │
│  └── DATABASE_URL                                                   │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 1. Desktop App Settings

### 1a. Settings Overlay (⚙ icon)

Click the gear icon in the status bar to open:

**Repositories — Target Branches**

| Field | Purpose | Example |
|---|---|---|
| Per-repo branch tags | Which target branches trigger a review | `dev`, `main`, `staging` |
| Add/remove | Click `×` to remove, type + Enter to add | Add `release/*` for release branches |
| Empty list | Review all branches | Leave no tags |

Default: `dev` and `main` are pre-configured. Add `staging`, `release`, or any branch you want reviewed.

**Global Preferences**

| Field | Purpose | Options |
|---|---|---|
| Model | Which AI engine to use | `DeepSeek` (faster, cheaper) or `Claude` (thorough) |
| Persona | Instructions for the AI reviewer | Focus areas: security, performance, style |

### 1b. Config Panel (left sidebar)

| Field | Purpose | Options |
|---|---|---|
| Model | Same as settings overlay | DeepSeek / Claude |
| Review Mode | `HITL` = pause before posting, `Auto` = post immediately | HITL (default) |
| Code Context | `Changed Files Only` — just the PR diff | Changed Files Only |
| Target Branches | Quick view of current branches | dev, main |
| System Persona | Instructions for the AI reviewer | Editable text |

---

## 2. GitHub Settings

### 2a. Personal Access Token (PAT)

Go to GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens.

Create a new token:

| Setting | Value |
|---|---|
| Token name | `aigov-review-bot` |
| Resource owner | Your user or organization |
| Repository access | **Only select repositories** |
| Selected repositories | Your target repos |

Permissions:

| Permission | Level | Why |
|---|---|---|
| **Contents** | Read | Fetch file contents and PR diffs |
| **Pull requests** | Read and write | Post review comments, get PR metadata |
| **Webhooks** | Read and write | (Optional) Programmatic webhook creation |

Copy the token. You'll add it to `k8s/secrets.yaml` as `GITHUB_TOKEN`.

### 2b. Webhook

Go to your repository → Settings → Webhooks → Add webhook.

| Field | Value |
|---|---|
| **Payload URL** | `https://aigov.yourdomain.com/api/v1/webhooks/github` |
| **Content type** | `application/json` |
| **Secret** | Same value as `WEBHOOK_SECRET` in `k8s/secrets.yaml` |
| **SSL verification** | Enable |
| **Which events?** | **Let me select individual events** → **Pull requests** |
| **Active** | ✓ |

**Events triggered:** PR opened, new commits pushed, PR reopened.

**Security:** Every webhook is validated via HMAC SHA-256. The backend computes
the hash from the raw request body + your webhook secret. If they don't match,
the request is rejected with 401.

### 2c. Branch Protection (optional)

Go to repository → Settings → Branches → Add branch protection rule.

| Setting | Value |
|---|---|
| **Branch name pattern** | `main` |
| **Require a pull request before merging** | ✓ |
| **Require status checks to pass** | `Code Review` (GitHub Actions) |

This prevents merging until the automated scoring check passes.

---

## 3. GitHub Actions Settings

### 3a. Repository Secrets

Go to repository → Settings → Secrets and variables → Actions → New repository secret.

| Secret | Value | Where to find it |
|---|---|---|
| `AIGOV_API_URL` | `https://aigov.yourdomain.com` | Your Cloudflare domain |
| `AIGOV_API_KEY` | Your org API key | GET /api/v1/auth/api-keys |
| `AIGOV_ORG_ID` | UUID of your org | GET /api/v1/organizations |
| `AIGOV_REPO_ID` | UUID of linked repo | GET /api/v1/repositories |

### 3b. Workflow

The workflow at `.github/workflows/code-review.yml` triggers on:

| Event | When |
|---|---|
| `pull_request: opened` | New PR created |
| `pull_request: synchronize` | New commits pushed to PR |
| `pull_request: reopened` | Closed PR reopened |
| `workflow_dispatch` | Manual trigger from Actions tab |

### 3c. What the workflow does

1. Checks out the repo
2. Runs `git diff base...head` to collect changes
3. Reads full content of each changed file
4. Builds a JSON payload with `jq`
5. POSTs to `/api/v1/audits` with `x-api-key` header
6. Posts a PR comment confirming audit is queued

---

## 4. Skaffold / Kubernetes Settings

### 4a. ConfigMap (`k8s/configmap.yaml`)

| Key | Default | Purpose |
|---|---|---|
| `AUDIT_MODE` | `sdk` | How audits run: `inline`, `sdk`, or `sandbox` |
| `SDK_MODEL` | `claude-sonnet-4-20250514` | Model for SDK mode |
| `REVIEW_TARGET_BRANCHES` | `dev,main` | Fallback if repo has no branches configured |
| `K8S_NAMESPACE` | `codewhale-runner` | Sandbox namespace (only for sandbox mode) |
| `CORS_ORIGIN` | `https://aigov.example.com` | Allowed frontend origin |
| `REDIS_HOST` | `redis.aigov.svc.cluster.local` | Redis DNS (K8s internal) |
| `POSTGRES_HOST` | `postgres.aigov.svc.cluster.local` | Postgres DNS |

### 4b. Secrets (`k8s/secrets.yaml`)

| Key | Required | Purpose |
|---|---|---|
| `DEEPSEEK_API_KEY` | One required | DeepSeek API key |
| `ANTHROPIC_API_KEY` | One required | Claude API key |
| `GITHUB_TOKEN` | Yes | GitHub PAT for file fetching + review posting |
| `WEBHOOK_SECRET` | Yes | HMAC secret for webhook validation |
| `JWT_SECRET` | Yes | JWT signing key |
| `DATABASE_URL` | Yes | PostgreSQL connection string |

Generate a secure JWT secret:

```bash
openssl rand -base64 64
```

Generate a webhook secret:

```bash
openssl rand -hex 32
```

### 4c. Apply changes

```bash
# After editing yaml files
skaffold delete && skaffold dev

# Or apply individually
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/secrets.yaml
kubectl rollout restart deploy/backend -n aigov
```

---

### 4d. MCP Server Configuration (`k8s/mcp-config.yaml`)

The Cluster Debugger connects to MCP (Model Context Protocol) servers running
as sidecar containers. Each server is enabled via a feature flag.

| Key | Default | Purpose |
|---|---|---|
| `LOG_ANALYZER_MCP_ENABLED` | `false` | Master switch — set to `true` to enable any MCP servers |
| `LOG_ANALYZER_MCP_K8S` | `false` | Kubernetes pod/log access |
| `LOG_ANALYZER_MCP_KUBETAIL` | `false` | Cross-replica log aggregation (kubetail-mcp) |
| `LOG_ANALYZER_MCP_AWS` | `false` | AWS CloudWatch log groups |
| `LOG_ANALYZER_MCP_GCP` | `false` | Google Cloud Logging entries |
| `MCP_TRANSPORT_MODE` | `sse` | Transport: `sse` (K8s sidecars) or `stdio` (local dev) |

**MCP server endpoints** (auto-configured, localhost within the pod):
- K8s MCP: `http://localhost:8081/sse`
- AWS MCP: `http://localhost:8082/sse`
- GCP MCP: `http://localhost:8083/sse`
- Kubetail MCP: `http://localhost:8084/sse`

**Credential secrets required per server:**

| Server | Required secrets |
|---|---|
| K8s | `kubectl create secret generic kubeconfig --from-file=config=$HOME/.kube/config -n aigov` |
| AWS | AWS credentials in `k8s/secrets.yaml` (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) |
| GCP | Service account key: `kubectl create secret generic gcp-credentials --from-file=gcp-key.json=./gcp-key.json -n aigov` |
| Kubetail | Same kubeconfig secret as K8s |

**Local business skills** (always available, no config needed):
- `prioritize_by_sla` — SLA map configurable via `SLA_OVERRIDE_*=P1-CRITICAL:15m:Description`
- `route_diagnostic_to_owner` — Team routing configurable via `TEAM_ROUTE_*=TeamName:#slack:repo/path`

**Example — enable Kubetail + business skills only:**
```yaml
# k8s/mcp-config.yaml
LOG_ANALYZER_MCP_ENABLED:  "true"
LOG_ANALYZER_MCP_KUBETAIL: "true"
```
```bash
kubectl create secret generic kubeconfig --from-file=config=$HOME/.kube/config -n aigov
skaffold run
```

No manual JSON secrets needed — the backend reads these flags and auto-generates
the MCP connection config at startup.

---

## 5. Quick Setup Checklist

```
□ 1. Create GitHub PAT (Contents: Read, Pull requests: Read & Write)
□ 2. Copy PAT to k8s/secrets.yaml as GITHUB_TOKEN
□ 3. Generate WEBHOOK_SECRET (openssl rand -hex 32), add to secrets.yaml
□ 4. Generate JWT_SECRET (openssl rand -base64 64), add to secrets.yaml
□ 5. Set DEEPSEEK_API_KEY or ANTHROPIC_API_KEY in secrets.yaml
□ 6. Add webhook in GitHub repo settings
□ 7. Add GitHub Actions secrets to repository
□ 8. Run skaffold dev
□ 9. Start desktop app: yarn workspace aigov-desktop start
□ 10. Open settings (⚙) → configure target branches per repo
□ 11. (Optional) Enable Cluster Debugger: set LOG_ANALYZER_MCP_ENABLED + KUBETAIL to "true" in mcp-config.yaml
□ 12. Open a test PR → verify webhook arrives → approve review
```

## 6. Testing the Configuration

### Test webhook delivery

1. Open a PR in your repo
2. Go to Settings → Webhooks → Recent Deliveries
3. Look for HTTP 202 with `auditJobId` and `reviewThreadId`

### Test GitHub Actions

1. Go to Actions tab → Code Review
2. Click "Run workflow" → enter PR number
3. Check the run logs for successful audit submission

### Test desktop app

1. Open a PR targeting a branch in your review list
2. Watch the review appear in the desktop app
3. Scores should update in the score bar
4. Click Approve → verify the review appears on GitHub

---

## 7. Troubleshooting

| Symptom | Check |
|---|---|
| Webhook returns 401 | `WEBHOOK_SECRET` matches in GitHub and secrets.yaml |
| Webhook returns "not in review list" | Target branch isn't in the repo's `reviewBranches`. Add it in settings (⚙). |
| Desktop shows "Backend not ready" | Is `skaffold dev` running? Check `skaffold status`. |
| Review text is placeholder | Set `DEEPSEEK_API_KEY` or `ANTHROPIC_API_KEY` in secrets.yaml. |
| Scores show `—` | Audit may still be processing. Wait 15-45s and select the review again. |
| GitHub Actions fails | Check `AIGOV_API_URL` is accessible from GitHub's servers. |
| Socket.IO connection fails | Port 3000 must be forwarded. Check `skaffold dev` port-forward output. |
| Can't add branch in settings | Ensure the backend PATCH endpoint is accessible. Check browser console. |
