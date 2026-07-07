# GitHub Configuration

Everything you need to configure on the GitHub side for the webhook + review pipeline.

## Required token scopes

### Fine-grained Personal Access Token (recommended)

1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens
2. Generate new token

| Setting | Value |
|---|---|
| Token name | `aigov-review-bot` |
| Resource owner | Your user or organization |
| Repository access | Only select repositories |
| Selected repositories | Your target repos |

Permissions:

| Permission | Access | Why |
|---|---|---|
| Contents | Read | Fetch file contents, list PR files, get diffs |
| Pull requests | Read and write | Get PR metadata, post review comments |
| Webhooks | Read and write | (Optional, for programmatic webhook creation) |

### Classic PAT (legacy)

If fine-grained tokens aren't available:

| Scope | Why |
|---|---|
| `repo` | Full repository access (or `public_repo` for public repos only) |

Copy the token — you'll add it to `.env` as `GITHUB_TOKEN`.

## Webhook configuration

### Create webhook

1. Go to your repository → Settings → Webhooks → Add webhook
2. Fill in:

| Field | Value |
|---|---|
| Payload URL | `https://aigov.yourdomain.com/api/v1/webhooks/github` |
| Content type | `application/json` |
| Secret | Same as `WEBHOOK_SECRET` in `.env` |
| SSL verification | Enable |
| Which events? | Let me select → Pull requests |
| Active | ✓ |

### Events received

The webhook fires on:
- `pull_request.opened` — new PR
- `pull_request.synchronize` — new commits pushed to PR branch
- `pull_request.reopened` — closed PR re-opened

Other actions (closed, labeled, assigned, etc.) are ignored.

### HMAC validation

The backend validates every webhook using the shared secret:

```
GitHub sends:    x-hub-signature-256: sha256=<computed-hmac>
Backend computes: sha256(raw-body + WEBHOOK_SECRET)
Backend compares: constant-time comparison
```

If they don't match → 401 Unauthorized. The webhook is silently dropped.

### Testing webhooks

#### Via GitHub UI

1. Go to repo → Settings → Webhooks
2. Click on your webhook
3. Click "Recent Deliveries"
4. Find a delivery → Response should be 202 Accepted

#### Via smee.io (local testing)

```bash
npm install -g smee-client
smee -u https://smee.io/your-unique-channel -t http://localhost:3000/api/v1/webhooks/github
```

Add `https://smee.io/your-unique-channel` as the webhook URL in GitHub.

#### Via curl (manual test)

```bash
curl -X POST http://localhost:3000/api/v1/webhooks/github \
  -H "Content-Type: application/json" \
  -H "x-github-event: pull_request" \
  -H "x-hub-signature-256: sha256=..." \
  -d '{
    "action": "opened",
    "pull_request": {
      "number": 42,
      "title": "Test PR",
      "head": { "sha": "abc123", "ref": "feature/test" },
      "base": { "ref": "main" },
      "html_url": "https://github.com/org/repo/pull/42",
      "user": { "login": "developer" }
    },
    "repository": {
      "full_name": "org/repo"
    }
  }'
```

## GitHub Actions integration (optional)

For the automated scoring pipeline, add these secrets to your repo:

1. Go to repo → Settings → Secrets and variables → Actions
2. Add:

| Name | Value |
|---|---|
| `AIGOV_API_URL` | `https://aigov.yourdomain.com` |
| `AIGOV_API_KEY` | Your organization API key |
| `AIGOV_ORG_ID` | UUID of your organization |
| `AIGOV_REPO_ID` | UUID of your linked repository |

The workflow at `.github/workflows/code-review.yml` uses these automatically.

## Permissions summary

| You do | Permissions needed |
|---|---|
| Fetch PR files | `contents: read` |
| Post review comments | `pull_requests: write` |
| Receive webhooks | Webhook secret in repo settings |
| GitHub Actions workflow | Actions secrets in repo settings |
| Manual `gh` CLI usage | `gh auth login` with repo scope |

## Bot account (optional)

For a cleaner review experience, create a dedicated GitHub bot account:

1. Create a new GitHub user (e.g., `aigov-review-bot`)
2. Add it as a collaborator to your repos
3. Generate a PAT from the bot account
4. Use that PAT as `GITHUB_TOKEN`
5. Reviews will appear as posted by the bot, not your personal account
