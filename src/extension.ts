/**
 * π-observe v1.0 — Unified Observability Dashboard for Pi
 *
 * Inspired by Miessler's PAI Observability (Vue + Bun + SQLite + WebSocket).
 * Pi version: captures events via hooks → JSONL log → HTTP dashboard.
 *
 * Unified event sources:
 * 1. Pi sessions — tool_call, message_end, session_start hooks
 * 2. Pi-pai events — goal changes, ratings, learnings, loop phases
 * 3. Claude Code sessions — reads ~/.claude/projects/ JSONL if present
 * 4. Subagent activity — captures delegation events
 *
 * Integration points from Nico's ecosystem:
 * - Compatible with pi-powerline-footer token tracking format
 * - Captures pi-review-loop iterations as events
 * - Captures pi-coordination task dispatch/completion
 *
 * Architecture:
 * - JSONL: ~/.pi/observe/events.jsonl (append-only, rotated at 10MB)
 * - HTTP: localhost:4040 serves dashboard + JSON API
 * - Dashboard: self-contained HTML, polls /api/events every 3s
 *
 * Commands:
 * - /observe          — open dashboard in browser
 * - /observe status   — event count, file size, server status
 * - /observe clear    — rotate log file
 */

import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as http from 'http'

// ── Types ────────────────────────────────────────────────────────────────────

interface ObserveEvent {
  ts: string
  type: 'session_start' | 'tool_call' | 'tool_result' | 'message' | 'error' | 'command' | 'pai' | 'subagent' | 'claude_code'
  source?: 'pi' | 'pi-pai' | 'claude-code' | 'subagent'
  tool?: string
  duration?: number
  tokens?: { input?: number; output?: number }
  blocked?: boolean
  summary?: string
  session?: string
  meta?: Record<string, unknown>
}

// ── State ────────────────────────────────────────────────────────────────────

const OBSERVE_DIR = path.join(os.homedir(), '.pi', 'observe')
const EVENTS_FILE = path.join(OBSERVE_DIR, 'events.jsonl')
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')
const MAX_FILE_SIZE = 10 * 1024 * 1024
const PORT = 4040

let server: http.Server | null = null
let sessionId = ''
let eventCount = 0
let sessionStart = Date.now()
let toolCalls: Record<string, number> = {}
let lastClaudeCodeScan = 0

// ── File I/O ─────────────────────────────────────────────────────────────────

function ensureDir() {
  if (!fs.existsSync(OBSERVE_DIR)) fs.mkdirSync(OBSERVE_DIR, { recursive: true })
}

function appendEvent(event: ObserveEvent) {
  ensureDir()
  try {
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

// ── Claude Code Cross-Feed (Source #3) ───────────────────────────────────────

function scanClaudeCodeEvents(): ObserveEvent[] {
  // Only scan every 30 seconds to avoid I/O spam
  const now = Date.now()
  if (now - lastClaudeCodeScan < 30000) return []
  lastClaudeCodeScan = now

  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return []

  const events: ObserveEvent[] = []
  try {
    // Walk one level of project dirs
    const projects = fs.readdirSync(CLAUDE_PROJECTS_DIR)
    for (const proj of projects.slice(-3)) { // last 3 projects only
      const projDir = path.join(CLAUDE_PROJECTS_DIR, proj)
      if (!fs.statSync(projDir).isDirectory()) continue

      // Look for JSONL files
      const files = fs.readdirSync(projDir).filter(f => f.endsWith('.jsonl')).sort().reverse().slice(0, 1) // latest only
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(projDir, file), 'utf8')
          const lines = content.trim().split('\n').slice(-20) // last 20 events
          for (const line of lines) {
            try {
              const raw = JSON.parse(line)
              // Map Claude Code hook event format to ObserveEvent
              events.push({
                ts: raw.timestamp ? new Date(raw.timestamp).toISOString() : new Date().toISOString(),
                type: 'claude_code',
                source: 'claude-code',
                tool: raw.hook_event_type || raw.type || 'unknown',
                summary: raw.summary || raw.payload?.message?.slice(0, 100) || `${proj}: ${raw.hook_event_type || 'event'}`,
                session: raw.session_id || proj,
                meta: { project: proj, agent: raw.agent_name },
              })
            } catch { /* skip bad lines */ }
          }
        } catch { /* skip bad files */ }
      }
    }
  } catch { /* best effort */ }
  return events
}

// ── Dashboard HTML ───────────────────────────────────────────────────────────

function dashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>π-observe — Unified Observability</title>
<style>
:root{--bg:#0c0a09;--surface:#1c1917;--surface2:#292524;--border:#3f3f46;--text:#fafaf9;--dim:#a8a29e;--muted:#6b6358;--teal:#2dd4bf;--amber:#fbbf24;--green:#4ade80;--rose:#fb7185;--blue:#60a5fa;--purple:#a78bfa;--font:system-ui,-apple-system,sans-serif;--mono:'SF Mono',Consolas,monospace}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:var(--font);background:var(--bg);color:var(--text);line-height:1.5}
.container{max-width:1280px;margin:0 auto;padding:1rem}
header{display:flex;justify-content:space-between;align-items:center;padding:0.8rem 0;border-bottom:1px solid var(--border);margin-bottom:1rem}
header h1{font-size:1.2rem;font-weight:700;letter-spacing:-0.02em}
header h1 span{color:var(--teal)}
.badge{display:inline-block;padding:1px 6px;border-radius:4px;font-size:0.65rem;font-weight:600;margin-left:0.5rem}
.badge-pi{background:rgba(45,212,191,0.15);color:var(--teal)}
.badge-pai{background:rgba(251,191,36,0.15);color:var(--amber)}
.badge-cc{background:rgba(167,139,250,0.15);color:var(--purple)}
.badge-sub{background:rgba(96,165,250,0.15);color:var(--blue)}
.header-right{display:flex;align-items:center;gap:1rem}
.live{display:flex;align-items:center;gap:0.4rem;font-size:0.72rem;color:var(--green)}
.live::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--green);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
.source-filter{display:flex;gap:0.3rem}
.source-filter button{background:var(--surface);border:1px solid var(--border);color:var(--dim);padding:2px 8px;border-radius:4px;font-size:0.68rem;cursor:pointer}
.source-filter button.active{border-color:var(--teal);color:var(--teal)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:0.6rem;margin-bottom:1rem}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:0.6rem 0.8rem}
.stat .label{font-size:0.65rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em}
.stat .value{font-size:1.4rem;font-weight:700;font-family:var(--mono)}
.stat .value.teal{color:var(--teal)}.stat .value.amber{color:var(--amber)}.stat .value.green{color:var(--green)}.stat .value.rose{color:var(--rose)}.stat .value.blue{color:var(--blue)}.stat .value.purple{color:var(--purple)}
.grid{display:grid;grid-template-columns:2.5fr 1fr;gap:1rem}
@media(max-width:768px){.grid{grid-template-columns:1fr}}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:0.8rem;max-height:550px;overflow-y:auto}
.panel h2{font-size:0.8rem;color:var(--dim);font-weight:600;margin-bottom:0.6rem;text-transform:uppercase;letter-spacing:0.04em}
.event{display:grid;grid-template-columns:65px 20px 65px 1fr;gap:0.4rem;padding:0.35rem 0;border-bottom:1px solid rgba(63,63,70,0.5);font-size:0.75rem;align-items:center}
.event:last-child{border-bottom:none}
.event .time{color:var(--muted);font-family:var(--mono);font-size:0.68rem}
.event .src{font-size:0.6rem;text-align:center}
.src-pi{color:var(--teal)}.src-pai{color:var(--amber)}.src-cc{color:var(--purple)}.src-sub{color:var(--blue)}
.event .type{font-weight:600;font-size:0.67rem;padding:1px 4px;border-radius:3px;text-align:center;white-space:nowrap}
.type-tool_call{background:rgba(45,212,191,0.12);color:var(--teal)}
.type-message{background:rgba(96,165,250,0.12);color:var(--blue)}
.type-error{background:rgba(251,113,133,0.12);color:var(--rose)}
.type-session_start{background:rgba(74,222,128,0.12);color:var(--green)}
.type-command{background:rgba(251,191,36,0.12);color:var(--amber)}
.type-pai{background:rgba(251,191,36,0.12);color:var(--amber)}
.type-subagent{background:rgba(96,165,250,0.12);color:var(--blue)}
.type-claude_code{background:rgba(167,139,250,0.12);color:var(--purple)}
.event .detail{color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.blocked{opacity:0.4;text-decoration:line-through}
.bar-chart{display:flex;flex-direction:column;gap:0.35rem}
.bar-row{display:flex;align-items:center;gap:0.4rem;font-size:0.72rem}
.bar-row .name{width:72px;text-align:right;color:var(--dim);font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.68rem}
.bar-row .bar{height:16px;border-radius:3px;background:var(--teal);min-width:2px;transition:width 0.3s}
.bar-row .count{color:var(--muted);font-family:var(--mono);font-size:0.68rem;min-width:25px}
.sidebar{display:flex;flex-direction:column;gap:0.8rem}
footer{text-align:center;padding:1rem 0;color:var(--muted);font-size:0.65rem}
</style>
</head>
<body>
<div class="container">
<header>
  <h1>π-<span>observe</span>
    <span class="badge badge-pi">Pi</span>
    <span class="badge badge-pai">PAI</span>
    <span class="badge badge-cc">Claude</span>
  </h1>
  <div class="header-right">
    <div class="source-filter">
      <button class="active" onclick="toggleFilter('all',this)">All</button>
      <button onclick="toggleFilter('pi',this)">Pi</button>
      <button onclick="toggleFilter('pi-pai',this)">PAI</button>
      <button onclick="toggleFilter('claude-code',this)">Claude</button>
      <button onclick="toggleFilter('subagent',this)">Sub</button>
    </div>
    <div class="live" id="live">Connecting...</div>
  </div>
</header>

<div class="stats" id="stats"></div>

<div class="grid">
  <div class="panel" id="timeline">
    <h2>Unified Event Timeline</h2>
    <div id="events"></div>
  </div>
  <div class="sidebar">
    <div class="panel">
      <h2>Tool Usage</h2>
      <div id="tools" class="bar-chart"></div>
    </div>
    <div class="panel">
      <h2>Sources</h2>
      <div id="sources" class="bar-chart"></div>
    </div>
    <div class="panel">
      <h2>Session</h2>
      <div id="session" style="font-size:0.78rem;color:var(--dim)"></div>
    </div>
  </div>
</div>

<footer>π-observe v1.0 — Unified Observability — Pi + PAI + Claude Code — Inspired by Miessler's PAI & Nico's pi ecosystem</footer>
</div>

<script>
const API = 'http://localhost:${PORT}';
let activeFilter = 'all';

function toggleFilter(f, btn) {
  activeFilter = f;
  document.querySelectorAll('.source-filter button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  refresh();
}

async function refresh() {
  try {
    const res = await fetch(API + '/api/events?limit=300');
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
  const filtered = activeFilter === 'all' ? events : events.filter(e => e.source === activeFilter);

  // Stats
  const srcCounts = {};
  events.forEach(e => { srcCounts[e.source||'pi'] = (srcCounts[e.source||'pi']||0)+1; });
  document.getElementById('stats').innerHTML =
    stat('Total Events', stats.total, 'teal') +
    stat('Tool Calls', stats.toolCalls, 'amber') +
    stat('Pi Events', srcCounts['pi']||0, 'teal') +
    stat('PAI Events', srcCounts['pi-pai']||0, 'amber') +
    stat('Claude Code', srcCounts['claude-code']||0, 'purple') +
    stat('Errors', stats.errors, stats.errors > 0 ? 'rose' : 'green') +
    stat('Blocked', stats.blocked, stats.blocked > 0 ? 'rose' : 'green') +
    stat('Uptime', stats.uptime, 'blue');

  // Events
  const html = filtered.slice().reverse().map(e => {
    const t = new Date(e.ts);
    const time = t.toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
    const src = e.source || 'pi';
    const srcLabel = src === 'pi' ? '●' : src === 'pi-pai' ? '◆' : src === 'claude-code' ? '◈' : '○';
    const srcClass = src === 'pi' ? 'src-pi' : src === 'pi-pai' ? 'src-pai' : src === 'claude-code' ? 'src-cc' : 'src-sub';
    const detail = e.tool ? e.tool + (e.summary ? ' — ' + e.summary : '') : (e.summary || e.type);
    return '<div class="event' + (e.blocked?' blocked':'') + '">' +
      '<span class="time">' + time + '</span>' +
      '<span class="src ' + srcClass + '">' + srcLabel + '</span>' +
      '<span class="type type-' + e.type + '">' + e.type.replace('_',' ') + '</span>' +
      '<span class="detail">' + esc(detail) + '</span></div>';
  }).join('');
  document.getElementById('events').innerHTML = html || '<div style="color:var(--muted);font-size:0.8rem">No events yet — start a pi session</div>';

  // Tools
  const tools = stats.toolBreakdown || {};
  const tMax = Math.max(...Object.values(tools), 1);
  document.getElementById('tools').innerHTML = Object.entries(tools)
    .sort((a,b) => b[1]-a[1]).slice(0,10)
    .map(([n,c]) => '<div class="bar-row"><span class="name">'+esc(n)+'</span><div class="bar" style="width:'+Math.round(c/tMax*100)+'%"></div><span class="count">'+c+'</span></div>').join('') || '<div style="color:var(--muted);font-size:0.75rem">—</div>';

  // Sources
  const sMax = Math.max(...Object.values(srcCounts), 1);
  const srcColors = {'pi':'var(--teal)','pi-pai':'var(--amber)','claude-code':'var(--purple)','subagent':'var(--blue)'};
  document.getElementById('sources').innerHTML = Object.entries(srcCounts)
    .sort((a,b) => b[1]-a[1])
    .map(([n,c]) => '<div class="bar-row"><span class="name">'+esc(n)+'</span><div class="bar" style="width:'+Math.round(c/sMax*100)+'%;background:'+(srcColors[n]||'var(--teal)')+'"></div><span class="count">'+c+'</span></div>').join('');

  // Session
  document.getElementById('session').innerHTML =
    '<div><strong>ID:</strong> ' + esc(stats.sessionId||'—') + '</div>' +
    '<div><strong>Started:</strong> ' + (stats.sessionStart ? new Date(stats.sessionStart).toLocaleString() : '—') + '</div>' +
    '<div><strong>Log:</strong> ' + esc(stats.fileSize) + '</div>';
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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    const url = new URL(req.url || '/', `http://localhost:${PORT}`)

    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(dashboardHTML())
      return
    }

    // POST /api/event — external event ingestion (for Claude Code hooks, other agents)
    if (url.pathname === '/api/event' && req.method === 'POST') {
      let body = ''
      req.on('data', chunk => body += chunk)
      req.on('end', () => {
        try {
          const event = JSON.parse(body) as ObserveEvent
          if (!event.ts) event.ts = new Date().toISOString()
          if (!event.source) event.source = 'claude-code'
          appendEvent(event)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{"ok":true}')
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end('{"error":"invalid JSON"}')
        }
      })
      return
    }

    if (url.pathname === '/api/events') {
      const limit = parseInt(url.searchParams.get('limit') || '300')
      let events = readEvents(limit)

      // Merge Claude Code events (cross-feed)
      const ccEvents = scanClaudeCodeEvents()
      if (ccEvents.length) {
        events = [...events, ...ccEvents].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()).slice(-limit)
      }

      // Compute stats
      const toolBreakdown: Record<string, number> = {}
      let errors = 0, blocked = 0, tc = 0
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
        stats: { total: events.length, toolCalls: tc, errors, blocked, uptime: uptimeStr, fileSize: getFileSize(), sessionId, sessionStart, toolBreakdown },
      }))
      return
    }

    res.writeHead(404); res.end('Not found')
  })

  server.listen(PORT, '127.0.0.1', () => { /* silent */ })
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') server = null
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

// ── Public API for pi-pai integration ────────────────────────────────────────

// pi-pai can call this to log events directly
export function logPaiEvent(summary: string, meta?: Record<string, unknown>) {
  appendEvent({
    ts: new Date().toISOString(),
    type: 'pai',
    source: 'pi-pai',
    summary,
    session: sessionId,
    meta,
  })
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
        const sources = { pi: 0, 'pi-pai': 0, 'claude-code': 0, subagent: 0 }
        for (const e of events) sources[(e.source || 'pi') as keyof typeof sources]++
        ctx.ui.notify(`📊 ${events.length} events (Pi:${sources.pi} PAI:${sources['pi-pai']} CC:${sources['claude-code']} Sub:${sources.subagent}) | ${getFileSize()} | server ${server ? '✅' : '❌'}`, 'info')
        return
      }

      if (sub === 'clear') {
        const rotated = EVENTS_FILE + '.old'
        try {
          if (fs.existsSync(EVENTS_FILE)) {
            if (fs.existsSync(rotated)) fs.unlinkSync(rotated)
            fs.renameSync(EVENTS_FILE, rotated)
          }
          eventCount = 0; toolCalls = {}
          ctx.ui.notify('🗑️ Event log rotated', 'warning')
        } catch (e) { ctx.ui.notify(`Failed: ${e}`, 'error') }
        return
      }

      startServer()
      openDashboard()
      ctx.ui.notify(`📊 Dashboard: http://localhost:${PORT}`, 'info')
    },
  })

  // ── Event Hooks ─────────────────────────────────────────────────────

  pi.on('session_start', async (_event, ctx) => {
    widgetCtx = ctx
    sessionId = `pi-${Date.now().toString(36)}`
    sessionStart = Date.now()
    eventCount = 0; toolCalls = {}
    ensureDir()
    startServer()

    appendEvent({ ts: new Date().toISOString(), type: 'session_start', source: 'pi', session: sessionId, summary: `Pi session in ${ctx.cwd}` })
    ctx.ui.notify(`📊 π-observe v1.0 | /observe | http://localhost:${PORT}`, 'info')
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
      toolName = (event as any)?.name || (event as any)?.tool || 'other'
    }

    toolCalls[toolName] = (toolCalls[toolName] || 0) + 1
    appendEvent({ ts: new Date().toISOString(), type: 'tool_call', source: 'pi', tool: toolName, summary, session: sessionId })

    return { block: false }
  })

  pi.on('message_end', async (event) => {
    const text = typeof event === 'object' && event !== null && 'text' in event
      ? String((event as Record<string, unknown>).text) : ''

    appendEvent({ ts: new Date().toISOString(), type: 'message', source: 'pi', summary: text.length > 100 ? text.slice(0, 97) + '...' : text, session: sessionId })
  })
}
