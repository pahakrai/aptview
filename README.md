# AIGov — AI Code Governance

Human-in-the-loop code review platform for AI-assisted development. Every PR
gets scored against your coding standards, then you approve or reject the AI's
review before it reaches GitHub.

## How It Works

```
PR opened on GitHub
    │
    ├─▶ Automated Scoring
    │     DeepSeek/Claude checks every guideline
    │     → compliance%, efficiency%, coverage%
    │
    └─▶ Human-in-the-Loop Review
          AI analyzes the diff against your standards
          ──▶ pauses for your approval ──▶ posts to GitHub
```

Two pipelines, one decision gate. Scores are automatic. Reviews wait for you.

## Quick Start

```bash
# Prerequisites: Node 20+, Docker Desktop, GitHub PAT, DeepSeek API key

# 1. Install
git clone <repo> && cd codereviewer && yarn install

# 2. Configure
cp .env.example .env
# Fill in: DEEPSEEK_API_KEY, GITHUB_TOKEN, WEBHOOK_SECRET, JWT_SECRET

# 3. Start infrastructure
docker compose -f docker-compose.infra.yml up -d   # PostgreSQL + Redis

# 4. Push database
yarn db:push

# 5. Launch desktop app (starts backend automatically)
yarn workspace aigov-desktop start
```

The desktop app handles everything — Docker, migrations, backend startup, and the
review panel. No terminal commands after setup.

For detailed setup (Cloudflare Tunnel, GitHub webhooks, environment config),
see [docs/setup.md](docs/setup.md).

## Desktop App

```
┌─ Status ─────────────────────────────────────────── 3 review(s) ──────┐
│ ● Connected                                        [Stop] [Logs]      │
├─ Activity ────────────────────────────────────────────────────────────┤
│ org/api → feat/auth → main | PR #42 | by @dev           +2 more ▼    │
├──────────────────────────────────┬────────────────────────────────────┤
│ ┌── Diff ─────────────────────┐ │ ┌── AI Review ────────────────────┐ │
│ │ +42 -3 across 3 files       │ │ │ ## Code Review for PR #42       │ │
│ │                             │ │ │ ### Task                        │ │
│ │                             │ │ │ Create email validation         │ │
│ │                             │ │ │ ### Standards Applied           │ │
│ │                             │ │ │ - No console.log [error]        │ │
│ └─────────────────────────────┘ │ └─────────────────────────────────┘ │
├─ Scores ──────────────────────────────────────────────────────────────┤
│    78%            60%            67%                                   │
│  COMPLIANCE     EFFICIENCY     COVERAGE                                │
├─ Decision ────────────────────────────────────────────────────────────┤
│  ⏸ PAUSED: Awaiting Human Approval                                    │
│  [Approve & Comment]  [Cancel]                                         │
└────────────────────────────────────────────────────────────────────────┘
```

Click any review in the dropdown to switch. Scores update as audits complete.
Approve when ready — the review posts to GitHub.

## Analysis Modes

| Mode | Engine | Speed | Best For |
|---|---|---|---|
| `sdk` (desktop) | Claude Agent SDK | 15-45s | Daily use, fast AI review |
| `inline` | Regex matching | <1s | Pattern-only checks |
| `sandbox` | K8s + CodeWhale | 30-80s | Production isolation |

Desktop defaults to `sdk` — no containers, no K8s, direct API calls.

## Architecture

```
apps/
├── backend/       NestJS monolith (API + BullMQ workers)
│   ├── audits/    Scoring pipeline (inline | sdk | sandbox)
│   ├── reviews/   HITL pipeline (LangGraph + DeepSeek)
│   ├── webhooks/  GitHub PR webhook (HMAC validated)
│   └── standards/ Coding guidelines (CRUD + PDF upload)
├── frontend/      React dashboard (dark theme)
├── desktop/       Electron app (HITL review panel)
libs/              Shared types, DB client, utilities
k8s/               Kubernetes manifests (production)
docs/              Setup, scoring, CI/CD, architecture
```

## Key Features

- **Dual pipeline** — scoring runs automatically, reviews wait for human approval
- **Three analysis modes** — regex, SDK, or K8s sandbox
- **Percentage scores** — compliance, efficiency, coverage (not just pass/fail)
- **Task decomposition** — break sprints into quantifiable sub-tasks
- **PDF upload** — paste or upload coding standards
- **Cloudflare Tunnel** — expose localhost without opening ports
- **GitHub Actions** — CI/CD integration for automated scoring

## Documentation

| Doc | Covers |
|---|---|
| [docs/setup.md](docs/setup.md) | Complete setup from zero |
| [docs/architecture.md](docs/architecture.md) | System design and endpoints |
| [docs/cicd.md](docs/cicd.md) | Webhooks, GitHub Actions, Cloudflare |
| [docs/scoring.md](docs/scoring.md) | How scores are computed |
| [docs/desktop.md](docs/desktop.md) | Electron app usage |
| [docs/github-setup.md](docs/github-setup.md) | GitHub configuration |
