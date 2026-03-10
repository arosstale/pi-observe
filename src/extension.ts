/**
 * π-observe v1.0 — Observability Dashboard for Pi
 *
 * Inspired by Miessler's PAI Observability (Vue + Bun + SQLite + WebSocket).
 * Pi version: captures events via pi hooks → writes JSONL log → serves
 * a self-contained HTML dashboard via local HTTP server. No external deps.
 *
 * Architecture:
 * - Extension hooks: session_start, tool_call, message_end → event log
 * - JSONL file: ~/.pi/observe/events.jsonl (append-only, rotated at 10MB)
 * - HTTP server: localhost:4040 serves dashboard HTML + JSON API
 * - Dashboard: self-contained HTML with live polling, swimlane timeline,
 *   tool usage chart, token tracking, session history
 *
 * Commands:
 * - /observe        — open dashboard in browser
 * - /observe status  — show event count, file size, server status
 * - /observe clear   — rotate log file
 */

import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as http from 'http'

// ── Types ────────────────────────────────────────────────────────────────────

interface ObserveEvent {
  ts: string
  type: 'session_start' | 'tool_call' | 'tool_result' | 'message' | 'error' | 'command'
  tool?: string
  duration?: number
  tokens?: { input?: number; output?: number }
  blocked?: boolean
  summary?: string
  session?: string
}

// ── State ────────────────────────────────────────────────────────────────────

const OBSERVE_DIR = path.join(os.homedir(), '.pi', 'observe')
const EVENTS_FILE = path.join(OBSERVE_DIR, 'events.jsonl')
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB rotation
const PORT = 4040

let server: http.Server | null = null
let sessionId = ''
let eventCount = 0
let sessionStart = Date.now()
let toolCalls: Record<string, number> = {}

// ── File I/O ─────────────────────────────────────────────────────────────────

function ensureDir() {
  if (!fs.existsSync(OBSERVE_DIR)) fs.mkdirSync(OBSERVE_DIR, { recursive: true })
}

function appendEvent(event: ObserveEvent) {
  ensureDir()
  try {
    // Rotate if too large
    if (fs.existsSync(EVENTS_FILE)) {
      const stat = fs.statSync(EVENTS_FILE)
      if (stat.size > MAX_FILE_SIZE) {
        const rotated = EVENTS_FILE + '.1'
        if (fs.existsSync(rotated)) fs.unlinkSync(rotated)
        fs.renameSync(EVENTS_FILE, rotated)
      }
    }
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + '\n')
    eventCount++
  } catch { /* best effort */ }
}

function readEvents(limit: number = 500): ObserveEvent[] {
  if (!fs.existsSync(EVENTS_FILE)) return []
  try {
    const lines = fs.readFileSync(EVENTS_FILE, 'utf8').trim().split('\n')
    return lines.slice(-limit).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) as ObserveEvent[]
  } catch { return [] }
}

function getFileSize(): string {
  if (!fs.existsSync(EVENTS_FILE)) return '0 B'
  const bytes = fs.statSync(EVENTS_FILE).size
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ── Dashboard HTML ───────────────────────────────────────────────────────────

function dashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>π-observe — Pi Observability Dashboard</title>
<style>
:root{--bg:#0c0a09;--surface:#1c1917;--surface2:#292524;--border:#3f3f46;--text:#fafaf9;--dim:#a8a29e;--muted:#6b6358;--teal:#2dd4bf;--amber:#fbbf24;--green:#4ade80;--rose:#fb7185;--blue:#60a5fa;--font:system-ui,-apple-system,sans-serif;--mono:'SF Mono',Consolas,monospace}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:var(--font);background:var(--bg);color:var(--text);line-height:1.5}
.container{max-width:1200px;margin:0 auto;padding:1rem}
header{display:flex;justify-content:space-between;align-items:center;padding:1rem 0;border-bottom:1px solid var(--border);margin-bottom:1rem}
header h1{font-size:1.3rem;font-weight:700;letter-spacing:-0.02em}
header h1 span{color:var(--teal)}
.live{display:flex;align-items:center;gap:0.4rem;font-size:0.75rem;color:var(--green)}
.live::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--green);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:0.8rem;margin-bottom:1.5rem}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:0.8rem}
.stat .label{font-size:0.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em}
.stat .value{font-size:1.5rem;font-weight:700;font-family:var(--mono)}
.stat .value.teal{color:var(--teal)}.stat .value.amber{color:var(--amber)}.stat .value.green{color:var(--green)}.stat .value.rose{color:var(--rose)}.stat .value.blue{color:var(--blue)}
.grid{display:grid;grid-template-columns:2fr 1fr;gap:1rem}
@media(max-width:768px){.grid{grid-template-columns:1fr}}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:1rem;max-height:500px;overflow-y:auto}
.panel h2{font-size:0.85rem;color:var(--dim);font-weight:600;margin-bottom:0.8rem;text-transform:uppercase;letter-spacing:0.04em}
.event{display:grid;grid-template-columns:70px 70px 1fr;gap:0.5rem;padding:0.4rem 0;border-bottom:1px solid var(--border);font-size:0.78rem;align-items:center}
.event:last-child{border-bottom:none}
.event .time{color:var(--muted);font-family:var(--mono);font-size:0.7rem}
.event .type{font-weight:600;font-size:0.7rem;padding:1px 5px;border-radius:3px;text-align:center;white-space:nowrap}
.type-tool_call{background:rgba(45,212,191,0.15);color:var(--teal)}
.type-message{background:rgba(96,165,250,0.15);color:var(--blue)}
.type-error{background:rgba(251,113,133,0.15);color:var(--rose)}
.type-session_start{background:rgba(74,222,128,0.15);color:var(--green)}
.type-command{background:rgba(251,191,36,0.15);color:var(--amber)}
.event .detail{color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-chart{display:flex;flex-direction:column;gap:0.4rem}
.bar-row{display:flex;align-items:center;gap:0.5rem;font-size:0.75rem}
.bar-row .name{width:80px;text-align:right;color:var(--dim);font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-row .bar{height:18px;border-radius:3px;background:var(--teal);min-width:2px;transition:width 0.3s}
.bar-row .count{color:var(--muted);font-family:var(--mono);font-size:0.7rem;min-width:30px}
.blocked{opacity:0.5;text-decoration:line-through}
footer{text-align:center;padding:1.5rem 0;color:var(--muted);font-size:0.7rem}
</style>
</head>
<body>
<div class="container">
<header>
  <h1>π-<span>observe</span></h1>
  <div class="live" id="live">Live — polling every 3s</div>
</header>

<div class="stats" id="stats"></div>

<div class="grid">
  <div class="panel" id="timeline">
    <h2>Event Timeline</h2>
    <div id="events"></div>
  </div>
  <div>
    <div class="panel" style="margin-bottom:1rem">
      <h2>Tool Usage</h2>
      <div id="tools" class="bar-chart"></div>
    </div>
    <div class="panel">
      <h2>Session Info</h2>
      <div id="session"></div>
    </div>
  </div>
</div>

<footer>π-observe v1.0 — Pi Observability Dashboard — Inspired by Miessler's PAI</footer>
</div>

<script>
const API = 'http://localhost:${PORT}';
let lastCount = 0;

async function refresh() {
  try {
    const res = await fetch(API + '/api/events?limit=200');
    const data = await res.json();
    render(data);
    document.getElementById('live').textContent = 'Live — ' + new Date().toLocaleTimeString();
    document.getElementById('live').style.color = '#4ade80';
  } catch(e) {
    document.getElementById('live').textContent = 'Disconnected';
    document.getElementById('live').style.color = '#fb7185';
  }
}

function render(data) {
  const { events, stats } = data;

  // Stats
  document.getElementById('stats').innerHTML =
    stat('Events', stats.total, 'teal') +
    stat('Tool Calls', stats.toolCalls, 'amber') +
    stat('Errors', stats.errors, stats.errors > 0 ? 'rose' : 'green') +
    stat('Blocked', stats.blocked, stats.blocked > 0 ? 'rose' : 'green') +
    stat('Uptime', stats.uptime, 'blue') +
    stat('Log Size', stats.fileSize, 'dim');

  // Events (reversed = newest first)
  const eventsHtml = events.slice().reverse().map(e => {
    const t = new Date(e.ts);
    const time = t.toLocaleTimeString('en', {hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
    const cls = e.blocked ? 'blocked' : '';
    const detail = e.tool ? e.tool + (e.summary ? ' — ' + e.summary : '') : (e.summary || e.type);
    return '<div class="event ' + cls + '">' +
      '<span class="time">' + time + '</span>' +
      '<span class="type type-' + e.type + '">' + e.type.replace('_', ' ') + '</span>' +
      '<span class="detail">' + esc(detail) + '</span>' +
    '</div>';
  }).join('');
  document.getElementById('events').innerHTML = eventsHtml || '<div style="color:var(--muted);font-size:0.8rem">No events yet</div>';

  // Tool chart
  const tools = stats.toolBreakdown || {};
  const max = Math.max(...Object.values(tools), 1);
  const toolsHtml = Object.entries(tools)
    .sort((a,b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name, count]) =>
      '<div class="bar-row">' +
        '<span class="name">' + esc(name) + '</span>' +
        '<div class="bar" style="width:' + Math.round(count/max*100) + '%"></div>' +
        '<span class="count">' + count + '</span>' +
      '</div>'
    ).join('');
  document.getElementById('tools').innerHTML = toolsHtml || '<div style="color:var(--muted);font-size:0.8rem">No tools used yet</div>';

  // Session
  document.getElementById('session').innerHTML =
    '<div style="font-size:0.8rem;color:var(--dim)">' +
    '<div><strong>Session:</strong> ' + esc(stats.sessionId || '—') + '</div>' +
    '<div><strong>Started:</strong> ' + (stats.sessionStart ? new Date(stats.sessionStart).toLocaleString() : '—') + '</div>' +
    '<div><strong>Events this session:</strong> ' + stats.total + '</div>' +
    '</div>';
}

function stat(label, value, color) {
  return '<div class="stat"><div class="label">' + label + '</div><div class="value ' + color + '">' + value + '</div></div>';
}

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`
}

// ── HTTP Server ──────────────────────────────────────────────────────────────

function startServer() {
  if (server) return

  server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    const url = new URL(req.url || '/', `http://localhost:${PORT}`)

    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(dashboardHTML())
      return
    }

    if (url.pathname === '/api/events') {
      const limit = parseInt(url.searchParams.get('limit') || '200')
      const events = readEvents(limit)

      // Compute stats
      const toolBreakdown: Record<string, number> = {}
      let errors = 0
      let blocked = 0
      let tc = 0
      for (const e of events) {
        if (e.type === 'tool_call') {
          tc++
          const t = e.tool || 'unknown'
          toolBreakdown[t] = (toolBreakdown[t] || 0) + 1
        }
        if (e.type === 'error') errors++
        if (e.blocked) blocked++
      }

      const uptimeSec = Math.round((Date.now() - sessionStart) / 1000)
      const uptimeStr = uptimeSec < 60 ? `${uptimeSec}s` : uptimeSec < 3600 ? `${Math.round(uptimeSec / 60)}m` : `${(uptimeSec / 3600).toFixed(1)}h`

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        events,
        stats: {
          total: events.length,
          toolCalls: tc,
          errors,
          blocked,
          uptime: uptimeStr,
          fileSize: getFileSize(),
          sessionId,
          sessionStart,
          toolBreakdown,
        }
      }))
      return
    }

    res.writeHead(404); res.end('Not found')
  })

  server.listen(PORT, '127.0.0.1', () => {
    // silent start
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      // Port already in use — another pi session has the server, that's fine
      server = null
    }
  })
}

function openDashboard() {
  const url = `http://localhost:${PORT}`
  const { execSync } = require('child_process')
  try {
    if (process.platform === 'win32') execSync(`start "" "${url}"`, { stdio: 'ignore' })
    else if (process.platform === 'darwin') execSync(`open "${url}"`, { stdio: 'ignore' })
    else execSync(`xdg-open "${url}"`, { stdio: 'ignore' })
  } catch { /* best effort */ }
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let widgetCtx: ExtensionContext | null = null

  // ── /observe command ────────────────────────────────────────────────

  pi.registerCommand('observe', {
    description: 'Observability: /observe (open dashboard) | /observe status | /observe clear',
    handler: async (args, ctx) => {
      widgetCtx = ctx
      const sub = (args || '').trim().toLowerCase()

      if (sub === 'status') {
        const events = readEvents(9999)
        const tc = events.filter(e => e.type === 'tool_call').length
        const errs = events.filter(e => e.type === 'error').length
        ctx.ui.notify(`📊 ${events.length} events | ${tc} tool calls | ${errs} errors | ${getFileSize()} | server ${server ? '✅' : '❌'}`, 'info')
        return
      }

      if (sub === 'clear') {
        const rotated = EVENTS_FILE + '.old'
        try {
          if (fs.existsSync(EVENTS_FILE)) {
            if (fs.existsSync(rotated)) fs.unlinkSync(rotated)
            fs.renameSync(EVENTS_FILE, rotated)
          }
          eventCount = 0
          toolCalls = {}
          ctx.ui.notify('🗑️ Event log rotated', 'warning')
        } catch (e) {
          ctx.ui.notify(`Failed to rotate: ${e}`, 'error')
        }
        return
      }

      // Default: open dashboard
      startServer()
      openDashboard()
      ctx.ui.notify(`📊 Dashboard: http://localhost:${PORT}`, 'info')
    },
  })

  // ── Event Hooks ─────────────────────────────────────────────────────

  pi.on('session_start', async (_event, ctx) => {
    widgetCtx = ctx
    sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    sessionStart = Date.now()
    eventCount = 0
    toolCalls = {}
    ensureDir()
    startServer()

    appendEvent({ ts: new Date().toISOString(), type: 'session_start', session: sessionId, summary: `Session started in ${ctx.cwd}` })
    ctx.ui.notify(`📊 π-observe v1.0 | /observe to open dashboard | http://localhost:${PORT}`, 'info')
  })

  pi.on('tool_call', async (event, _ctx) => {
    const { isToolCallEventType } = await import('@mariozechner/pi-coding-agent')

    let toolName = 'unknown'
    let summary = ''

    if (isToolCallEventType('bash', event)) {
      toolName = 'bash'
      const cmd = event.input?.command || ''
      summary = cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd
    } else if (isToolCallEventType('read', event)) {
      toolName = 'read'
      summary = event.input?.path || ''
    } else if (isToolCallEventType('write', event)) {
      toolName = 'write'
      summary = event.input?.path || ''
    } else if (isToolCallEventType('edit', event)) {
      toolName = 'edit'
      summary = event.input?.path || ''
    } else {
      // Generic tool — try to extract name from event
      toolName = (event as any)?.name || (event as any)?.tool || 'other'
      summary = ''
    }

    toolCalls[toolName] = (toolCalls[toolName] || 0) + 1

    appendEvent({
      ts: new Date().toISOString(),
      type: 'tool_call',
      tool: toolName,
      summary,
      session: sessionId,
    })

    return { block: false }
  })

  pi.on('message_end', async (event) => {
    const text = typeof event === 'object' && event !== null && 'text' in event
      ? String((event as Record<string, unknown>).text) : ''

    appendEvent({
      ts: new Date().toISOString(),
      type: 'message',
      summary: text.length > 100 ? text.slice(0, 97) + '...' : text,
      session: sessionId,
    })
  })
}
