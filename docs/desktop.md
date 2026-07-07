# Desktop App

The AIGov desktop app wraps the review pipeline in a native Electron application
with a human-in-the-loop (HITL) control panel.

## Architecture

```
┌─── Electron Main Process ──────────────────────────────────────────┐
│                                                                      │
│  On startup:                                                         │
│    1. docker compose up (PostgreSQL + Redis)                        │
│    2. yarn db:push (migrations)                                     │
│    3. Spawns NestJS backend (child process)                         │
│    4. Polls /health until 200                                       │
│    5. Opens BrowserWindow with HITL UI                              │
│                                                                      │
│  On shutdown:                                                        │
│    → SIGTERM to NestJS child process                                │
│    → Docker containers stay running                                 │
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

## Running in development

```bash
yarn workspace aigov-desktop start
# Opens the Electron window directly
```

Or with dev flags:

```bash
yarn workspace aigov-desktop dev
# Opens with DevTools enabled
```

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

### Service Control Bar

- **Start Review Engine** — starts Docker containers, runs migrations, spawns backend
- **Stop Review Engine** — gracefully stops NestJS (Docker stays running)
- **Status indicator** — green = connected, amber = starting, red = stopped/error
- **Logs button** — opens dialog with log location info

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

## Dependencies

The desktop app requires:

- **Docker Desktop** running (for PostgreSQL + Redis)
- **Node.js 20+** (for spawning the backend)
- **Backend built**: `yarn workspace backend build` before first run

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
