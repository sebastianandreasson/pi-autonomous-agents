#!/usr/bin/env node

import fs from 'node:fs/promises'
import http from 'node:http'
import process from 'node:process'
import { loadConfig } from './pi-config.mjs'
import { readTelemetry } from './pi-telemetry.mjs'
import { readJsonFile } from './pi-repo.mjs'
import { deriveFlowSnapshot, formatActiveLabel } from './pi-visualizer-shared.mjs'

function readVisualizerHost() {
  return String(process.env.PI_VISUALIZER_HOST ?? '127.0.0.1').trim() || '127.0.0.1'
}

function readVisualizerPort() {
  const raw = Number.parseInt(String(process.env.PI_VISUALIZER_PORT ?? '4317'), 10)
  return Number.isFinite(raw) && raw > 0 ? raw : 4317
}

async function readOptionalText(filePath, maxLength = 6000) {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const text = raw.trim()
    if (text.length <= maxLength) {
      return text
    }
    return `${text.slice(0, maxLength - 15)}\n... [truncated]`
  } catch {
    return ''
  }
}

async function buildSnapshot(config) {
  const [activeRun, state, summary, telemetry, lastOutput] = await Promise.all([
    readJsonFile(config.activeRunFile, null),
    readJsonFile(config.stateFile, null),
    readJsonFile(config.lastIterationSummaryFile, null),
    readTelemetry(config),
    readOptionalText(config.lastAgentOutputFile, 5000),
  ])

  const recentTelemetry = telemetry.slice(-120)
  const flow = deriveFlowSnapshot({
    activeRun,
    summary,
    telemetry,
  })

  return {
    now: new Date().toISOString(),
    config: {
      cwd: config.cwd,
      transport: config.transport,
      telemetryJsonl: config.telemetryJsonl,
      activeRunFile: config.activeRunFile,
      stateFile: config.stateFile,
      lastIterationSummaryFile: config.lastIterationSummaryFile,
    },
    activeRun,
    state,
    summary,
    flow: {
      ...flow,
      activeLabel: formatActiveLabel(activeRun, flow),
    },
    lastOutput,
    recentTelemetry,
  }
}

function renderHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PI Harness Visualizer</title>
  <style>
    :root {
      --bg: #0b1020;
      --panel: #121a30;
      --panel2: #17213d;
      --text: #e6edf7;
      --muted: #95a3bf;
      --line: #263252;
      --active: #6ee7ff;
      --done: #53d18d;
      --error: #ff6b81;
      --skip: #f0b35a;
      --pending: #4b5675;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.4 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: linear-gradient(180deg, #08101d, #0b1020 180px);
      color: var(--text);
    }
    .wrap { max-width: 1300px; margin: 0 auto; padding: 20px; }
    .header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 20px; }
    .title { font-size: 28px; font-weight: 700; }
    .subtitle { color: var(--muted); margin-top: 4px; }
    .badge {
      display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 999px;
      border: 1px solid var(--line); background: rgba(255,255,255,0.03); color: var(--text);
    }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--pending); }
    .dot.active { background: var(--active); box-shadow: 0 0 18px rgba(110,231,255,.6); }
    .grid { display: grid; gap: 16px; }
    .grid.top { grid-template-columns: repeat(4, minmax(0, 1fr)); margin-bottom: 16px; }
    .grid.main { grid-template-columns: 1.4fr .9fr; }
    .card {
      background: linear-gradient(180deg, rgba(255,255,255,.02), rgba(255,255,255,.01));
      border: 1px solid var(--line); border-radius: 16px; padding: 16px;
      box-shadow: 0 12px 40px rgba(0,0,0,.18);
    }
    .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
    .value { margin-top: 8px; font-size: 22px; font-weight: 700; }
    .value.small { font-size: 16px; }
    .flow { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: 10px; margin-top: 14px; }
    .step {
      border: 1px solid var(--line); border-radius: 14px; padding: 12px; background: var(--panel);
      min-height: 96px; position: relative; overflow: hidden;
    }
    .step::before {
      content: ""; position: absolute; inset: 0 auto 0 0; width: 4px; background: var(--pending);
    }
    .step.active::before { background: var(--active); }
    .step.done::before { background: var(--done); }
    .step.error::before { background: var(--error); }
    .step.skipped::before { background: var(--skip); }
    .step-name { font-weight: 700; margin-bottom: 6px; }
    .step-status { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
    .step-meta { margin-top: 8px; color: var(--muted); font-size: 12px; white-space: pre-wrap; }
    .kv { display: grid; grid-template-columns: 140px 1fr; gap: 6px 10px; margin-top: 12px; }
    .kv div:nth-child(odd) { color: var(--muted); }
    pre {
      margin: 0; white-space: pre-wrap; word-break: break-word; background: #0a1325;
      border: 1px solid var(--line); border-radius: 12px; padding: 12px; max-height: 320px; overflow: auto;
    }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 10px 8px; border-bottom: 1px solid var(--line); vertical-align: top; text-align: left; }
    th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
    td { font-size: 13px; }
    .status-pill {
      display: inline-block; border-radius: 999px; padding: 3px 8px; font-size: 12px; font-weight: 700;
      border: 1px solid var(--line); background: var(--panel2);
    }
    .status-pill.done { color: var(--done); }
    .status-pill.error { color: var(--error); }
    .status-pill.skipped { color: var(--skip); }
    .status-pill.active { color: var(--active); }
    .muted { color: var(--muted); }
    @media (max-width: 1100px) {
      .grid.top, .grid.main, .flow { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div>
        <div class="title">PI Harness Visualizer</div>
        <div class="subtitle" id="cwd"></div>
      </div>
      <div class="badge"><span class="dot active"></span><span id="last-refresh">Loading...</span></div>
    </div>

    <div class="grid top">
      <div class="card"><div class="label">Current activity</div><div class="value" id="active-label">—</div></div>
      <div class="card"><div class="label">Iteration</div><div class="value" id="iteration">—</div></div>
      <div class="card"><div class="label">Phase</div><div class="value small" id="phase">—</div></div>
      <div class="card"><div class="label">Task</div><div class="value small" id="task">—</div></div>
    </div>

    <div class="card" style="margin-bottom: 16px;">
      <div class="label">Orchestration flow</div>
      <div class="flow" id="flow"></div>
    </div>

    <div class="grid main">
      <div class="card">
        <div class="label">Recent telemetry</div>
        <div style="margin-top: 12px; overflow: auto; max-height: 560px;">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Iteration</th>
                <th>Kind</th>
                <th>Status</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody id="timeline"></tbody>
          </table>
        </div>
      </div>

      <div class="grid">
        <div class="card">
          <div class="label">Run state</div>
          <div class="kv" id="run-state"></div>
        </div>
        <div class="card">
          <div class="label">Last iteration summary</div>
          <pre id="summary">—</pre>
        </div>
        <div class="card">
          <div class="label">Last agent output</div>
          <pre id="output">—</pre>
        </div>
      </div>
    </div>
  </div>

  <script>
    function esc(value) {
      return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
    }

    function pillClass(status) {
      if (status === 'done') return 'status-pill done'
      if (status === 'error') return 'status-pill error'
      if (status === 'skipped') return 'status-pill skipped'
      if (status === 'active') return 'status-pill active'
      return 'status-pill'
    }

    async function refresh() {
      const res = await fetch('/api/snapshot', { cache: 'no-store' })
      const data = await res.json()

      document.getElementById('cwd').textContent = data.config.cwd
      document.getElementById('last-refresh').textContent = 'Updated ' + new Date(data.now).toLocaleTimeString()
      document.getElementById('active-label').textContent = data.flow.activeLabel || 'Idle'
      document.getElementById('iteration').textContent = data.flow.iteration || '—'
      document.getElementById('phase').textContent = data.activeRun?.phase || data.summary?.phase || '—'
      document.getElementById('task').textContent = data.activeRun?.task || data.summary?.task || '—'

      const flowEl = document.getElementById('flow')
      flowEl.innerHTML = data.flow.steps.map((step) => {
        const latest = step.latestEvent
        const meta = latest
          ? [latest.kind, latest.status, latest.terminalReason].filter(Boolean).join('\n')
          : 'waiting'
        return '<div class="step ' + esc(step.status) + '">' +
          '<div class="step-name">' + esc(step.label) + '</div>' +
          '<div class="step-status">' + esc(step.status) + '</div>' +
          '<div class="step-meta">' + esc(meta) + '</div>' +
          '</div>'
      }).join('')

      const runState = [
        ['runId', data.activeRun?.runId || data.state?.runId || '—'],
        ['status', data.activeRun?.status || '—'],
        ['activeKind', data.activeRun?.activeKind || '—'],
        ['activeRole', data.activeRun?.activeRole || '—'],
        ['reason', data.activeRun?.activeReason || '—'],
        ['transport', data.config.transport || '—'],
        ['lastStatus', data.activeRun?.lastStatus || data.state?.lastStatus || '—'],
        ['lastCompleted', data.activeRun?.lastCompletedIteration || '—'],
      ]
      document.getElementById('run-state').innerHTML = runState
        .map(([k, v]) => '<div>' + esc(k) + '</div><div>' + esc(v) + '</div>')
        .join('')

      document.getElementById('summary').textContent = data.summary
        ? JSON.stringify(data.summary, null, 2)
        : 'No iteration summary yet.'
      document.getElementById('output').textContent = data.lastOutput || 'No agent output yet.'

      const timeline = [...data.recentTelemetry].reverse().map((event) => {
        const status = event.status === 'success' || event.status === 'passed'
          ? 'done'
          : (event.status === 'skipped' ? 'skipped' : ((event.status === 'failed' || event.status === 'timed_out' || event.status === 'stalled' || event.status === 'blocked') ? 'error' : ''))
        return '<tr>' +
          '<td>' + esc(new Date(event.timestamp).toLocaleTimeString()) + '</td>' +
          '<td>' + esc(event.iteration) + '</td>' +
          '<td>' + esc(event.kind) + '</td>' +
          '<td><span class="' + pillClass(status) + '">' + esc(event.status) + '</span></td>' +
          '<td class="muted">' + esc(event.notes || '') + '</td>' +
          '</tr>'
      }).join('')
      document.getElementById('timeline').innerHTML = timeline || '<tr><td colspan="5" class="muted">No telemetry yet.</td></tr>'
    }

    refresh().catch((error) => {
      document.getElementById('active-label').textContent = 'Load failed'
      document.getElementById('output').textContent = String(error)
    })
    setInterval(() => {
      refresh().catch(() => {})
    }, 1500)
  </script>
</body>
</html>`
}

async function main() {
  const config = loadConfig('once')
  const host = readVisualizerHost()
  const port = readVisualizerPort()

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
      if (url.pathname === '/api/snapshot') {
        const snapshot = await buildSnapshot(config)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(snapshot))
        return
      }

      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(renderHtml())
        return
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Not found')
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  })

  server.listen(port, host, () => {
    process.stdout.write(`PI Harness visualizer listening on http://${host}:${port}\n`)
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
