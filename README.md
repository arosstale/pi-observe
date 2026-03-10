# π-observe — Observability Dashboard for Pi

Real-time observability dashboard for the Pi coding agent. Captures every tool call, message, and error — serves a live-updating dashboard in your browser.

Inspired by [Daniel Miessler's PAI Observability](https://github.com/danielmiessler/Personal_AI_Infrastructure) (Vue + Bun + SQLite + WebSocket). This is the Pi version: zero external dependencies, self-contained HTML, append-only JSONL log.

## Install

```bash
pi install npm:pi-observe
```

## Usage

```bash
/observe          # Open dashboard in browser (http://localhost:4040)
/observe status   # Event count, file size, server status
/observe clear    # Rotate log file
```

The dashboard auto-opens on first `/observe`. It polls every 3 seconds for live updates.

## What It Tracks

| Event | Details |
|-------|---------|
| **Session start** | Working directory, timestamp |
| **Tool calls** | Tool name (bash, read, write, edit, etc.), command/path summary |
| **Messages** | Agent response summaries (first 100 chars) |
| **Errors** | Failed operations |
| **Blocked** | Sentinel/damage-control blocks |

## Dashboard

The dashboard shows:
- **Stats bar** — total events, tool calls, errors, blocked, uptime, log size
- **Event timeline** — chronological feed with type badges and summaries
- **Tool usage chart** — horizontal bar chart of most-used tools
- **Session info** — current session ID, start time, event count

Dark theme. Auto-refreshes every 3s. Responsive.

## Architecture

```
Pi Session
  │
  ├─ session_start hook → event.jsonl
  ├─ tool_call hook     → event.jsonl  
  ├─ message_end hook   → event.jsonl
  │
  └─ HTTP server (localhost:4040)
       ├─ GET /           → dashboard HTML
       └─ GET /api/events → JSON (events + stats)
```

- **Log:** `~/.pi/observe/events.jsonl` (append-only, rotates at 10MB)
- **Server:** Node http module, starts on session_start, port 4040
- **Dashboard:** Self-contained HTML with inline CSS/JS, polls `/api/events`
- **Zero deps:** No Vue, no SQLite, no WebSocket, no build step

## Comparison with Miessler's PAI Observability

| Feature | PAI Observability | π-observe |
|---------|------------------|-----------|
| Frontend | Vue.js + Tailwind | Self-contained HTML |
| Backend | Bun + SQLite + WebSocket | Node http + JSONL |
| Install | Clone + bun install + build | `pi install npm:pi-observe` |
| Files | ~100 source files | 1 file (extension.ts) |
| Swimlanes | ✅ Per-agent swim lanes | Event timeline (single lane) |
| Themes | ✅ Full theme system with sharing | Dark mode only |
| HITL | ✅ Human-in-the-loop requests | ❌ (pi has native confirms) |
| Live updates | WebSocket push | 3s polling |
| Data store | SQLite | JSONL file |

## License

MIT
