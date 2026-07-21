# AIGov — AI Code Governance

Human-in-the-loop code review platform for AI-assisted development. Every PR
gets scored against your coding standards, then you approve or reject the AI's
review before it reaches GitHub.

## How It Works

```
PR opened on GitHub
    │
    ├─▶ Pipeline 1: Automated Scoring
    │     DeepSeek/Claude checks every guideline
    │     → compliance%, efficiency%, coverage%
    │     → Stored in database, shown on dashboard
    │
    └─▶ Pipeline 2: HITL Review (Human-in-the-Loop)
          │
          ├─ Phase 1: Code Review
          │   AI analyzes the diff against your standards
          │   ──▶ pauses in desktop app for your approval
          │   ──▶ you approve/revise/cancel
          │   ──▶ posts review comment to GitHub
          │
          └─ Phase 2: Test Generation (optional)
              AI generates unit/integration tests
              ──▶ AI reviews the generated tests
              ──▶ pauses in desktop app for your approval
              ──▶ you approve → test file committed to PR branch
              ──▶ GitHub Actions CI runs the tests automatically
              ──▶ ✅ pass → merge  |  ❌ fail → fix → re-run → merge
```

Three actors, three competencies:
- **AI** writes (fast, tireless, pattern-aware)
- **Human** judges (context, intent, business logic)
- **CI** verifies (deterministic, reproducible, blocks bad merges)

## Quick Start

```bash
# Prerequisites: Node 20+, Docker Desktop, kubectl, Skaffold, GitHub PAT, DeepSeek API key

# 1. Install dependencies
git clone <repo> && cd codereviewer && yarn install

# 2. Configure environment
cp .env.example .env
# Fill in: DEEPSEEK_API_KEY, GITHUB_TOKEN, WEBHOOK_SECRET, JWT_SECRET

# 3. Start the platform (Terminal 1 — keep running)
skaffold dev
# → Builds images, deploys to K8s, port-forwards :3000 + :5173
# → Watches for changes, auto-rebuilds
# For staging/prod: skaffold run -f skaffold.prod.yaml

# 4. Launch the desktop app (Terminal 2)
yarn workspace aigov-desktop start
# → Opens review panel, connects to backend
```

Skaffold manages the entire stack — PostgreSQL, Redis, backend, frontend.
The desktop app is a pure UI client. No Docker commands needed.

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

Skaffold deploys the backend with `AUDIT_MODE=sdk` by default — fast, direct API calls to DeepSeek/Claude. Switch to `sandbox` for production isolation.

## Architecture

```
apps/
├── backend/       NestJS monolith (API + BullMQ workers)
│   ├── audits/    Scoring pipeline (inline | sdk | sandbox)
│   ├── reviews/   HITL pipeline (LangGraph + DeepSeek)
│   ├── log-analyzer/  Cluster debugger (LangGraph + MCP tools)
│   ├── webhooks/  GitHub PR webhook (HMAC validated)
│   └── standards/ Coding guidelines (CRUD + PDF upload)
├── frontend/      React dashboard (dark theme)
├── desktop/       Electron app (HITL review panel + cluster debugger)
libs/              Shared types, DB client, utilities
k8s/               Kubernetes manifests + MCP server configs
docs/              Setup, scoring, reviews, architecture, configuration
```

## Key Features

- **Dual pipeline** — scoring runs automatically, reviews wait for human approval
- **Two-phase review** — Phase 1: code review with revision loop. Phase 2: AI generates tests, human approves, CI verifies
- **Three analysis modes** — regex, SDK, or K8s sandbox
- **Percentage scores** — compliance, efficiency, coverage (not just pass/fail)
- **Cluster Debugger** — AI-powered K8s troubleshooting via Kubetail MCP + DeepSeek
- **MCP server integration** — Kubernetes, AWS CloudWatch, GCP Cloud Logging, Kubetail
- **Local business skills** — SLA-based priority, cross-cloud trace correlation, team routing
- **Task decomposition** — break sprints into quantifiable sub-tasks
- **PDF upload** — paste or upload coding standards
- **Cloudflare Tunnel** — expose localhost without opening ports
- **GitHub Actions** — CI/CD integration for automated scoring

## Documentation

| Doc | Covers |
|---|---|
| [docs/setup.md](docs/setup.md) | Complete setup from zero |
| [docs/configuration.md](docs/configuration.md) | **All settings — desktop UI, GitHub, K8s** |
| [docs/architecture.md](docs/architecture.md) | System design and endpoints |
| [docs/cicd.md](docs/cicd.md) | Webhooks, GitHub Actions, Cloudflare |
| [docs/scoring.md](docs/scoring.md) | How scores are computed |
| [docs/desktop.md](docs/desktop.md) | Electron app usage |
| [docs/github-setup.md](docs/github-setup.md) | GitHub configuration |
