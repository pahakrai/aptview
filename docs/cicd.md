# CI/CD Integration

Every PR triggers an AI-powered code review. This document explains how to set it up.

## Architecture

```
PR opened on GitHub
  → GitHub Actions workflow runs
    → Collects diff + changed files from the PR
    → POST /api/v1/audits → your aigov backend
      → Backend enqueues audit (BullMQ)
        → AuditProcessor runs (inline / sdk / sandbox)
          → Scores stored in PostgreSQL
            → Results visible in dashboard
              → Optional: PR comment posted
```

## Setting up GitHub Actions

### 1. Add repository secrets

In your GitHub repo: Settings → Secrets and variables → Actions → New repository secret

| Secret | Value |
|---|---|
| `AIGOV_API_URL` | Your backend URL (e.g. `https://aigov.example.com`) |
| `AIGOV_API_KEY` | Organization API key from the platform |
| `AIGOV_ORG_ID` | UUID of your organization |
| `AIGOV_REPO_ID` | UUID of the linked repository |

### 2. Workflow triggers

The workflow at `.github/workflows/code-review.yml` runs on:

- `pull_request: [opened, synchronize, reopened]` — every PR
- `workflow_dispatch` — manually trigger for any PR

### 3. How it works

1. **Checkout** — clones the repo with full history
2. **Get PR info** — extracts PR number, title, commit SHA
3. **Collect diff** — `git diff base...head`
4. **Collect changed files** — reads full content of each changed file
5. **Submit audit** — `POST /api/v1/audits` with diff + files
6. **Post comment** — notifies the PR author that review is in progress

---

## Exposing your local backend (Cloudflare Tunnel)

If your backend runs locally (kind/minikube/docker-desktop), use Cloudflare Tunnel to expose it:

### Install cloudflared

```bash
# macOS
brew install cloudflare/cloudflare/cloudflared

# Linux
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
chmod +x cloudflared
sudo mv cloudflared /usr/local/bin/
```

### Create tunnel

```bash
# Authenticate
cloudflared tunnel login

# Create tunnel
cloudflared tunnel create aigov

# Configure tunnel
cat > ~/.cloudflared/config.yml << 'EOF'
tunnel: <tunnel-id>
credentials-file: /root/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: aigov.example.com
    service: http://backend.aigov.svc.cluster.local:3000
  - service: http_status:404
EOF

# Run tunnel
cloudflared tunnel run aigov
```

### Or run as a K8s deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cloudflared
  namespace: aigov
spec:
  replicas: 1
  selector:
    matchLabels:
      app: cloudflared
  template:
    spec:
      containers:
        - name: cloudflared
          image: cloudflare/cloudflared:latest
          args: ["tunnel", "run", "aigov"]
          env:
            - name: TUNNEL_TOKEN
              valueFrom:
                secretKeyRef:
                  name: cloudflare-tunnel
                  key: token
```

---

## Local development flow

```bash
# 1. Start local K8s cluster
kind create cluster --name aigov

# 2. Deploy everything
kubectl apply -f k8s/namespaces.yaml
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/secrets.yaml
kubectl apply -f k8s/postgres.yaml
kubectl apply -f k8s/redis.yaml
kubectl apply -f k8s/rbac.yaml
kubectl apply -f k8s/backend.yaml
kubectl apply -f k8s/frontend.yaml

# 3. Push DB schema
kubectl exec -n aigov deploy/backend -- yarn db:push

# 4. Expose via Cloudflare Tunnel
cloudflared tunnel run aigov

# 5. Trigger a test audit
curl -X POST https://aigov.example.com/api/v1/audits \
  -H "Content-Type: application/json" \
  -H "x-api-key: $AIGOV_API_KEY" \
  -d '{ ... }'
```

---

## Mode selection

Set `AUDIT_MODE` in `k8s/configmap.yaml` to choose how audits run:

| Mode | Best for | Setup |
|---|---|---|
| `inline` | Pattern-only checks, zero infra | Nothing needed |
| `sdk` | AI-powered, fast, local dev | Set `ANTHROPIC_API_KEY` in secrets |
| `sandbox` | Multi-tenant SaaS, full isolation | Configure `K8S_NAMESPACE` + runner image |

For local development: `AUDIT_MODE=sdk`. For production SaaS: `AUDIT_MODE=sandbox`.
