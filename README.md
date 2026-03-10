# π-observe — Unified Observability Dashboard for Pi

Real-time observability across **Pi sessions, pi-pai events, and Claude Code** — all in one dashboard.

Inspired by [Daniel Miessler's PAI Observability](https://github.com/danielmiessler/Personal_AI_Infrastructure) and [Nico Bailon's pi ecosystem](https://github.com/nicobailon).

## Install

```bash
pi install npm:pi-observe
```

## Usage

```bash
/observe          # Open dashboard at http://localhost:4040
/observe status   # Event counts by source, file size, server status
/observe clear    # Rotate log file
```

## Unified Event Sources

| Source | How It Works |
|--------|-------------|
| **Pi sessions** | Hooks: `session_start`, `tool_call`, `message_end` — captured automatically |
| **pi-pai events** | Goal changes, ratings, learnings, loop phases — via `logPaiEvent()` export |
| **Claude Code** | Scans `~/.claude/projects/` JSONL files every 30s for cross-agent visibility |
| **External agents** | `POST /api/event` — any agent can push events via HTTP |

## Dashboard Features

- **Source filter** — toggle Pi / PAI / Claude Code / Subagent events
- **Unified timeline** — all events chronologically with source indicators (● Pi, ◆ PAI, ◈ Claude)
- **Tool usage chart** — horizontal bar chart of most-used tools
- **Source breakdown** — events per source with colored bars
- **Stats bar** — total events, tool calls, errors, blocked, per-source counts, uptime
- **Session info** — current session ID, start time, log size
- **Auto-refresh** — polls every 3 seconds
- **Dark theme** — because obviously

## External Event Ingestion

Any agent can push events:

```bash
curl -X POST http://localhost:4040/api/event \
  -H "Content-Type: application/json" \
  -d '{"type":"tool_call","source":"claude-code","tool":"bash","summary":"npm test"}'
```

## Architecture

```
Pi Session ─────────────────┐
  ├─ session_start          │
  ├─ tool_call              ├──→ ~/.pi/observe/events.jsonl
  └─ message_end            │         │
                            │    HTTP Server (:4040)
pi-pai ─────────────────────┤    ├─ GET /           → Dashboard HTML
  ├─ goal changes           │    ├─ GET /api/events → JSON (events + stats)
  ├─ ratings/learnings      │    └─ POST /api/event → External ingestion
  └─ loop phases            │
                            │
Claude Code ────────────────┘
  └─ ~/.claude/projects/ JSONL scan (every 30s)
```

## Integration with Nico's Ecosystem

- **pi-powerline-footer** — compatible token tracking format
- **pi-coordination** — task dispatch/completion events
- **pi-review-loop** — review iteration events
- **pi-subagents** — delegation events

## License

MIT
