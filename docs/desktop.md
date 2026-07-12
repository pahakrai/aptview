# Desktop App

The AIGov desktop app wraps the review pipeline in a native Electron application
with a human-in-the-loop (HITL) control panel.

## Architecture

```
┌─── Terminal 1: skaffold dev ───────────────────────────────────────┐
│                                                                      │
│  Builds images → deploys to K8s → port-forwards :3000 + :5173      │
│  PostgreSQL, Redis, Backend, Frontend — all managed by Skaffold     │
└──────────────────────────────────────────────────────────────────────┘
                     │
                     │ localhost:3000
                     ▼
┌─── Electron Main Process ──────────────────────────────────────────┐
│                                                                      │
│  On startup:                                                         │
│    1. Opens BrowserWindow with HITL UI                              │
│    2. Polls /health every 3s until backend responds                 │
│    3. Shows "Connected" when reachable                              │
│    4. Shows "Backend not ready — run skaffold dev" if unreachable   │
│                                                                      │
│  On shutdown:                                                        │
│    → Window closes. Skaffold keeps running in Terminal 1.           │
└─────────────────────────────────────────────────────────────────────┘

┌─── Renderer (BrowserWindow) ───────────────────────────────────────┐
│                                                                      │
│  ┌─ Status Bar ──────────────────────────────────────────────────┐  │
│  │ ● Connected  ·  localhost:3000         [Start] [Stop] [Logs]  │  │
│  ├─ Activity Board ──────────────────────────────────────────────┤  │
│  │ org/repo  →  feat/auth → main  |  PR #42  |  by @developer    │  │
│  ├─ Config Panel ───────┬── Monitor ────────────────────────────┤  │
│  │ Model: DeepSeek ▾     │ ┌── Diff ────┐ ┌── AI Review ───────┐│  │
│  │ Mode:  HITL ◉         │ │ +42 lines  │ │ Streaming tokens...││  │
│  │        Auto ○         │ │ -3 lines   │ │                    ││  │
│  │                       │ └────────────┘ └────────────────────┘│  │
│  │ Persona:              │                                        │  │
│  │ [Focus on security]   │                                        │  │
│  ├───────────────────────┴────────────────────────────────────────┤  │
│  │ Decision Gate                                                   │  │
│  │ ⏸ PAUSED  [Approve & Comment] [Cancel] [Manually Trigger]      │  │
│  └─────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

## Installation

```bash
yarn workspace aigov-desktop install
```

## Running

**Prerequisite:** `skaffold dev` must be running in a separate terminal.

```bash
# Terminal 2
yarn workspace aigov-desktop start
# Opens the review panel, connects to localhost:3000
```

The app polls `/health` and shows connection status. If the backend is unreachable,
it displays "Backend not ready — run `skaffold dev`" with a Retry button.

## Building for distribution

```bash
yarn workspace aigov-desktop build
```

Outputs:

| Platform | Output |
|---|---|
| macOS | `dist/AIGov-1.0.0.dmg` |
| Windows | `dist/AIGov Setup 1.0.0.exe` |
| Linux | `dist/AIGov-1.0.0.AppImage` |

## UI features

### Status Bar

- **Green dot** — connected to backend, listening for reviews
- **Amber dot** — connecting, waiting for backend health check
- **Red dot** — backend unreachable, shows "run `skaffold dev`"
- **Retry Connection** — re-checks backend health (appears when disconnected)

### Activity Board

Displays real-time PR info from the latest webhook:
- Repository name (`org/repo`)
- Source branch → target branch
- PR number with badge
- Author name

### Config Panel (left sidebar)

- **Model toggle**: DeepSeek (default) or Claude
- **Review mode**: Human-In-The-Loop (pause for approval) or Automatic
- **System persona**: Editable textarea to customize review rules

### Live Output Monitor

Split-pane view:
- **Left**: Raw diff from the PR (JetBrains Mono, syntax-colored)
- **Right**: AI review text streaming in real-time from the WebSocket

### Decision Gate

- **PAUSED status**: Shown when LangGraph hits the interrupt before posting
- **Approve & Comment**: Resumes the graph, posts to GitHub via Octokit
- **Cancel Review**: Discards the review, never posts
- **Manually Trigger Review**: Re-runs analysis on current PR data

## Communication with backend

| Direction | Protocol | Purpose |
|---|---|---|
| Electron → Backend | HTTP REST | Approve/cancel reviews, fetch status |
| Backend → Electron | WebSocket (Socket.IO) | Real-time review streaming, status updates |
| Electron Main → Renderer | IPC | Engine lifecycle events (start/stop/error) |

## Cluster Debugger (Log Checker)

Click the 🔍 **Log Checker** button in the status bar to open the Cluster Debugger overlay.

```
┌─ Cluster Debugger ──────────────────────────────────────────────────┐
│ 🔍 Cluster Debugger — AI-Powered K8s Troubleshooting    Ready  [✕] │
├─ Input ──────────────────┬─ Diagnostic Results ────────────────────┤
│ Ask a question about     │                                          │
│ your cluster             │ ### Cluster Health Overview              │
│                          │ - 3 pods running, 1 CrashLoopBackOff     │
│ ┌──────────────────────┐ │                                          │
│ │ List all pods in     │ │ ### Error Analysis                       │
│ │ production. Any      │ │ - ConnectionTimeoutException (47x)       │
│ │ crashing?            │ │   → P1-CRITICAL, 15m SLA                │
│ │                      │ │                                          │
│ │ Scan logs for errors │ │ ### Root Cause                           │
│ │ in the last 15 min   │ │ - Wrong DB endpoint in ConfigMap         │
│ │                      │ │                                          │
│ │ Check config for     │ │ ### Team Routing                         │
│ │ recent deployment    │ │ - Platform Engineering, #team-platform   │
│ └──────────────────────┘ │                                          │
│                          │                                          │
│ [e.g. Scan logs for...] [⚡ Analyze]                                │
└────────────────────────────────────────────────────────────────────┘
```

**How it works:**
1. Type a question or click a suggestion chip
2. Backend sends prompt to DeepSeek with Kubetail MCP tools
3. DeepSeek calls MCP tools to fetch live K8s data (pods, logs, configs)
4. Local skills add business context (SLA priority, team routing)
5. Results stream in real-time via WebSocket

**Available MCP servers** (enable in `k8s/mcp-config.yaml`):
- Kubernetes — pod listing, log fetching, pod descriptions
- Kubetail — cross-replica log aggregation, error pattern grouping
- AWS CloudWatch — log group search and filtering
- GCP Cloud Logging — log entry listing and tailing

**Cancel:** Click ⏹ Cancel to immediately abort the running analysis
via AbortSignal (tears down the TCP connection to DeepSeek).

## Dependencies

The desktop app requires:

- **Skaffold** running in a separate terminal (`skaffold dev`)
- **Docker Desktop** running (Skaffold uses it to build images)
- **kubectl** configured (Skaffold uses it to deploy to K8s)

## File structure

```
apps/desktop/
├── package.json        # Electron + socket.io-client
├── main.js             # Electron main process (docker, spawn, health)
├── preload.js          # Secure IPC bridge
└── src/
    ├── App.html         # HITL review panel UI
    └── review-gate.js   # WS client, polling, approve/cancel logic
```
