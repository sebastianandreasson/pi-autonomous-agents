#!/usr/bin/env node

import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { loadConfig } from './pi-config.mjs'
import { readTelemetry } from './pi-telemetry.mjs'
import { readJsonFile } from './pi-repo.mjs'
import { deriveFlowSnapshot, deriveStageGraph, formatActiveLabel } from './pi-visualizer-shared.mjs'

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

function getRunDir(config, runId) {
  return path.join(config.piRuntimeDir, 'runs', runId)
}

function getRunScopedConfig(config, runId) {
  const runDir = getRunDir(config, runId)
  return {
    ...config,
    runId,
    telemetryJsonl: path.join(runDir, 'pi_telemetry.jsonl'),
    telemetryCsv: path.join(runDir, 'pi_telemetry.csv'),
    stateFile: path.join(runDir, 'state.json'),
    lastIterationSummaryFile: path.join(runDir, 'last-iteration.json'),
    lastAgentOutputFile: path.join(runDir, 'last-output.txt'),
    logFile: path.join(runDir, 'pi.log'),
  }
}

async function listRuns(config, activeRun) {
  const runsDir = path.join(config.piRuntimeDir, 'runs')
  let entries = []
  try {
    entries = await fs.readdir(runsDir, { withFileTypes: true })
  } catch {
    return []
  }

  const runs = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const runId = entry.name
      const scoped = getRunScopedConfig(config, runId)
      const [state, summary, stat] = await Promise.all([
        readJsonFile(scoped.stateFile, null),
        readJsonFile(scoped.lastIterationSummaryFile, null),
        fs.stat(getRunDir(config, runId)).catch(() => null),
      ])
      return {
        runId,
        active: String(activeRun?.runId ?? '') === runId,
        mtimeMs: Number(stat?.mtimeMs ?? 0),
        status: String(activeRun?.runId ?? '') === runId
          ? String(activeRun?.status ?? '')
          : String(state?.lastStatus ?? state?.inProgress?.status ?? ''),
        iteration: Number(state?.iteration ?? summary?.iteration ?? 0),
        phase: String(state?.lastPhase ?? summary?.phase ?? activeRun?.phase ?? ''),
        task: String(summary?.task ?? activeRun?.task ?? ''),
        runStartedAt: String(state?.runStartedAt ?? activeRun?.startedAt ?? ''),
        lastRunAt: String(state?.lastRunAt ?? ''),
      }
    }))

  return runs.sort((left, right) => right.mtimeMs - left.mtimeMs)
}

function resolveSelectedRunId(queryRunId, activeRun, runs) {
  const requested = String(queryRunId ?? '').trim()
  if (requested !== '' && runs.some((run) => run.runId === requested)) {
    return requested
  }
  const activeRunId = String(activeRun?.runId ?? '').trim()
  if (activeRunId !== '' && runs.some((run) => run.runId === activeRunId)) {
    return activeRunId
  }
  return runs[0]?.runId ?? ''
}

async function buildSnapshot(config, queryRunId = '') {
  const activeRun = await readJsonFile(config.activeRunFile, null)
  const runs = await listRuns(config, activeRun)
  const selectedRunId = resolveSelectedRunId(queryRunId, activeRun, runs)
  const selectedConfig = selectedRunId !== '' ? getRunScopedConfig(config, selectedRunId) : config

  const [state, summary, telemetry, currentOutput] = await Promise.all([
    readJsonFile(selectedConfig.stateFile, null),
    readJsonFile(selectedConfig.lastIterationSummaryFile, null),
    readTelemetry(selectedConfig),
    readOptionalText(selectedConfig.lastAgentOutputFile, 5000),
  ])

  const recentTelemetry = telemetry.slice(-160).map((event, index) => ({
    ...event,
    _vizId: `telemetry-${index}`,
  }))
  const flow = deriveFlowSnapshot({
    activeRun: selectedRunId !== '' && String(activeRun?.runId ?? '') === selectedRunId ? activeRun : state?.inProgress ?? null,
    summary,
    telemetry,
  })
  const graph = deriveStageGraph({
    activeRun: selectedRunId !== '' && String(activeRun?.runId ?? '') === selectedRunId ? activeRun : state?.inProgress ?? null,
    summary,
    telemetry,
  })

  return {
    now: new Date().toISOString(),
    config: {
      cwd: config.cwd,
      transport: config.transport,
      telemetryJsonl: selectedConfig.telemetryJsonl,
      activeRunFile: config.activeRunFile,
      stateFile: selectedConfig.stateFile,
      lastIterationSummaryFile: selectedConfig.lastIterationSummaryFile,
      selectedRunId,
    },
    runs,
    activeRun,
    state,
    summary,
    flow: {
      ...flow,
      activeLabel: formatActiveLabel(activeRun, flow),
    },
    graph,
    lastOutput: currentOutput,
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
      margin: 0; font: 14px/1.4 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: linear-gradient(180deg, #08101d, #0b1020 180px); color: var(--text);
    }
    .wrap { max-width: 1400px; margin: 0 auto; padding: 20px; }
    .header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 20px; }
    .title { font-size: 28px; font-weight: 700; }
    .subtitle { color: var(--muted); margin-top: 4px; }
    .toolbar { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
    .badge, select {
      display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 999px;
      border: 1px solid var(--line); background: rgba(255,255,255,0.03); color: var(--text);
      font: inherit;
    }
    select { min-width: 260px; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--pending); }
    .dot.active { background: var(--active); box-shadow: 0 0 18px rgba(110,231,255,.6); }
    .grid { display: grid; gap: 16px; }
    .grid.top { grid-template-columns: repeat(4, minmax(0, 1fr)); margin-bottom: 16px; }
    .grid.main { grid-template-columns: 1.25fr .95fr; }
    .card {
      background: linear-gradient(180deg, rgba(255,255,255,.02), rgba(255,255,255,.01));
      border: 1px solid var(--line); border-radius: 16px; padding: 16px;
      box-shadow: 0 12px 40px rgba(0,0,0,.18);
    }
    .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
    .value { margin-top: 8px; font-size: 22px; font-weight: 700; }
    .value.small { font-size: 16px; }
    .flow { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: 10px; margin-top: 14px; }
    .step, .graph-node {
      border: 1px solid var(--line); border-radius: 14px; padding: 12px; background: var(--panel);
      min-height: 96px; position: relative; overflow: hidden;
    }
    .step::before, .graph-node::before {
      content: ""; position: absolute; inset: 0 auto 0 0; width: 4px; background: var(--pending);
    }
    .step.active::before, .graph-node.active::before { background: var(--active); }
    .step.done::before, .graph-node.done::before { background: var(--done); }
    .step.error::before, .graph-node.error::before { background: var(--error); }
    .step.skipped::before, .graph-node.skipped::before { background: var(--skip); }
    .step-name { font-weight: 700; margin-bottom: 6px; }
    .step-status { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
    .step-meta { margin-top: 8px; color: var(--muted); font-size: 12px; white-space: pre-wrap; }
    .graph { display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:12px; margin-top:12px; }
    .graph-node { min-height: 120px; width: 100%; text-align: left; color: var(--text); font: inherit; cursor: pointer; }
    .graph-arrow { color: var(--muted); text-align: center; align-self: center; }
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
    @media (max-width: 1100px) { .grid.top, .grid.main, .flow { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div>
        <div class="title">PI Harness Visualizer</div>
        <div class="subtitle" id="cwd"></div>
      </div>
      <div class="toolbar">
        <select id="run-select"></select>
        <div class="badge"><span class="dot active"></span><span id="last-refresh">Loading...</span></div>
      </div>
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

    <div class="card" style="margin-bottom: 16px;">
      <div class="label">Iteration stage graph</div>
      <div class="graph" id="graph"></div>
    </div>

    <div class="grid main">
      <div class="card">
        <div class="label">Recent telemetry timeline</div>
        <div style="margin-top: 12px; overflow: auto; max-height: 620px;">
          <table>
            <thead><tr><th>Time</th><th>Iteration</th><th>Kind</th><th>Status</th><th>Notes</th></tr></thead>
            <tbody id="timeline"></tbody>
          </table>
        </div>
      </div>

      <div class="grid">
        <div class="card"><div class="label">Run state</div><div class="kv" id="run-state"></div></div>
        <div class="card"><div class="label">Selected event</div><pre id="selected-event">Click graph node or timeline row.</pre></div>
        <div class="card"><div class="label">Last iteration summary</div><pre id="summary">—</pre></div>
        <div class="card"><div class="label">Last agent output</div><pre id="output">—</pre></div>
      </div>
    </div>
  </div>

  <script>
    function esc(value) {
      return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    }
    function pillClass(status) {
      if (status === 'done') return 'status-pill done'
      if (status === 'error') return 'status-pill error'
      if (status === 'skipped') return 'status-pill skipped'
      if (status === 'active') return 'status-pill active'
      return 'status-pill'
    }
    function eventStatus(status) {
      if (status === 'success' || status === 'passed' || status === 'complete') return 'done'
      if (status === 'skipped' || status === 'not_run' || status === 'not_needed') return 'skipped'
      if (status === 'failed' || status === 'timed_out' || status === 'stalled' || status === 'blocked') return 'error'
      return ''
    }
    function selectedRunId() {
      return new URLSearchParams(location.search).get('runId') || ''
    }
    function updateRunQuery(runId) {
      const url = new URL(location.href)
      if (runId) url.searchParams.set('runId', runId)
      else url.searchParams.delete('runId')
      history.replaceState(null, '', url)
    }
    let latestSnapshot = null
    let selectedEventId = ''

    function findEventById(snapshot, eventId) {
      if (!snapshot || !eventId) return null
      return snapshot.graph?.nodes?.find((node) => node.id === eventId)?.event
        || snapshot.recentTelemetry?.find((event) => event._vizId === eventId)
        || null
    }

    function renderSelectedEvent() {
      const event = findEventById(latestSnapshot, selectedEventId)
      document.getElementById('selected-event').textContent = event
        ? JSON.stringify(event, null, 2)
        : 'Click graph node or timeline row.'
    }

    async function refresh() {
      const runId = selectedRunId()
      const qs = runId ? '?runId=' + encodeURIComponent(runId) : ''
      const res = await fetch('/api/snapshot' + qs, { cache: 'no-store' })
      const data = await res.json()
      latestSnapshot = data
      document.getElementById('cwd').textContent = data.config.cwd
      document.getElementById('last-refresh').textContent = 'Updated ' + new Date(data.now).toLocaleTimeString()
      document.getElementById('active-label').textContent = data.flow.activeLabel || 'Idle'
      document.getElementById('iteration').textContent = data.flow.iteration || '—'
      document.getElementById('phase').textContent = data.activeRun?.phase || data.summary?.phase || '—'
      document.getElementById('task').textContent = data.activeRun?.task || data.summary?.task || '—'

      const select = document.getElementById('run-select')
      const selected = data.config.selectedRunId || ''
      select.innerHTML = data.runs.map((run) => {
        const suffix = [run.status, run.phase].filter(Boolean).join(' · ')
        return '<option value="' + esc(run.runId) + '" ' + (selected === run.runId ? 'selected' : '') + '>' +
          esc(run.runId.slice(0, 8) + (suffix ? ' — ' + suffix : '')) + '</option>'
      }).join('')
      if (!select.dataset.bound) {
        select.addEventListener('change', (event) => {
          updateRunQuery(event.target.value)
          refresh().catch(() => {})
        })
        select.dataset.bound = '1'
      }

      const flowEl = document.getElementById('flow')
      flowEl.innerHTML = data.flow.steps.map((step) => {
        const latest = step.latestEvent
        const meta = latest ? [latest.kind, latest.status, latest.terminalReason].filter(Boolean).join('\n') : 'waiting'
        return '<div class="step ' + esc(step.status) + '">' +
          '<div class="step-name">' + esc(step.label) + '</div>' +
          '<div class="step-status">' + esc(step.status) + '</div>' +
          '<div class="step-meta">' + esc(meta) + '</div>' +
          '</div>'
      }).join('')

      const graphEl = document.getElementById('graph')
      graphEl.innerHTML = data.graph.nodes.length > 0
        ? data.graph.nodes.map((node) => {
            const retry = node.retryCount > 0 ? 'retry #' + node.retryCount : ''
            const meta = [node.kind, retry, node.role, node.terminalReason].filter(Boolean).join('\n')
            return '<button type="button" class="graph-node ' + esc(node.status) + '" data-event-id="' + esc(node.id) + '">' +
              '<div class="step-name">' + esc(node.label) + '</div>' +
              '<div class="step-status">' + esc(node.status) + '</div>' +
              '<div class="step-meta">' + esc(meta) + '\n' + esc(node.notes || '') + '</div>' +
              '</button>'
          }).join('')
        : '<div class="muted">No iteration graph yet.</div>'

      graphEl.querySelectorAll('[data-event-id]').forEach((element) => {
        element.addEventListener('click', () => {
          selectedEventId = element.getAttribute('data-event-id') || ''
          renderSelectedEvent()
        })
      })

      const runState = [
        ['runId', data.activeRun?.runId || data.state?.runId || data.config.selectedRunId || '—'],
        ['status', data.activeRun?.status || data.state?.inProgress?.status || '—'],
        ['activeKind', data.activeRun?.activeKind || '—'],
        ['activeRole', data.activeRun?.activeRole || '—'],
        ['reason', data.activeRun?.activeReason || '—'],
        ['transport', data.config.transport || '—'],
        ['lastStatus', data.activeRun?.lastStatus || data.state?.lastStatus || '—'],
        ['lastCompleted', data.activeRun?.lastCompletedIteration || '—'],
      ]
      document.getElementById('run-state').innerHTML = runState.map(([k, v]) => '<div>' + esc(k) + '</div><div>' + esc(v) + '</div>').join('')
      document.getElementById('summary').textContent = data.summary ? JSON.stringify(data.summary, null, 2) : 'No iteration summary yet.'
      document.getElementById('output').textContent = data.lastOutput || (data.config.selectedRunId ? 'Historical runs do not currently keep per-run last output snapshots.' : 'No agent output yet.')

      const timelineEvents = [...data.recentTelemetry].reverse()
      const timeline = timelineEvents.map((event) => {
        const status = eventStatus(event.status)
        return '<tr data-event-id="' + esc(event._vizId) + '" style="cursor:pointer;">' +
          '<td>' + esc(new Date(event.timestamp).toLocaleTimeString()) + '</td>' +
          '<td>' + esc(event.iteration) + '</td>' +
          '<td>' + esc(event.kind) + '</td>' +
          '<td><span class="' + pillClass(status) + '">' + esc(event.status) + '</span></td>' +
          '<td class="muted">' + esc(event.notes || '') + '</td>' +
          '</tr>'
      }).join('')
      document.getElementById('timeline').innerHTML = timeline || '<tr><td colspan="5" class="muted">No telemetry yet.</td></tr>'
      document.querySelectorAll('#timeline [data-event-id]').forEach((element) => {
        element.addEventListener('click', () => {
          selectedEventId = element.getAttribute('data-event-id') || ''
          renderSelectedEvent()
        })
      })

      renderSelectedEvent()
    }
    refresh().catch((error) => {
      document.getElementById('active-label').textContent = 'Load failed'
      document.getElementById('output').textContent = String(error)
    })
    setInterval(() => refresh().catch(() => {}), 1500)
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
        const snapshot = await buildSnapshot(config, url.searchParams.get('runId') || '')
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
