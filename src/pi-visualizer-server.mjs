import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { readTelemetry } from './pi-telemetry.mjs'
import { readJsonFile } from './pi-repo.mjs'
import { deriveFlowSnapshot, deriveStageGraph, formatActiveLabel } from './pi-visualizer-shared.mjs'

export function readVisualizerHost() {
  return String(process.env.PI_VISUALIZER_HOST ?? '127.0.0.1').trim() || '127.0.0.1'
}

export function readVisualizerPort() {
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

async function readJsonlTail(filePath, maxItems = 200) {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .sort((left, right) => String(left?.timestamp ?? '').localeCompare(String(right?.timestamp ?? '')))
      .slice(-maxItems)
  } catch {
    return []
  }
}

const MAX_DIFF_FILES = 10
const MAX_DIFF_CHARS_PER_FILE = 12000
const MAX_DIFF_TOTAL_CHARS = 40000
const REPO_DIFF_CACHE_MS = 2000

let repoDiffCache = {
  cwd: '',
  updatedAt: 0,
  result: [],
}

function clampText(text, maxChars) {
  const value = String(text ?? '')
  if (value.length <= maxChars) {
    return value
  }
  return `${value.slice(0, maxChars - 16)}\n... [truncated]`
}

async function parseTodos(taskFile, activeTaskText = '') {
  try {
    const raw = await fs.readFile(taskFile, 'utf8')
    const lines = raw.split('\n')
    const items = []
    let currentPhase = ''

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      const headingMatch = /^(#+)\s+(.+)$/.exec(line)
      if (headingMatch) {
        const level = headingMatch[1].length
        const text = headingMatch[2].trim()
        if (level === 2) {
          currentPhase = text
        }
        continue
      }

      const checkboxMatch = /^\s*[-*]\s+\[( |x)\]\s+(.+)$/.exec(line)
      if (!checkboxMatch) {
        continue
      }

      const checked = checkboxMatch[1].toLowerCase() === 'x'
      const text = checkboxMatch[2].trim()
      items.push({
        id: `line-${index + 1}`,
        kind: 'task',
        lineNumber: index + 1,
        level: 0,
        text,
        phase: currentPhase,
        raw: line,
        checked,
        active: text === activeTaskText,
      })
    }

    return items
  } catch {
    return []
  }
}

function readRepoDiff(cwd) {
  const now = Date.now()
  if (repoDiffCache.cwd === cwd && (now - repoDiffCache.updatedAt) < REPO_DIFF_CACHE_MS) {
    return repoDiffCache.result
  }

  try {
    const status = execFileSync('git', ['status', '--short'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    }).trim()
    if (status === '') {
      repoDiffCache = { cwd, updatedAt: now, result: [] }
      return []
    }

    const files = status
      .split('\n')
      .map((line) => line.slice(3).trim())
      .filter(Boolean)
      .slice(0, MAX_DIFF_FILES)

    let remainingChars = MAX_DIFF_TOTAL_CHARS
    const result = files.map((file) => {
      let diff = ''
      try {
        diff = execFileSync('git', ['diff', '--no-ext-diff', '--unified=1', '--', file], {
          cwd,
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
        }).trim()
      } catch {
        diff = ''
      }

      const allowedChars = Math.max(500, Math.min(MAX_DIFF_CHARS_PER_FILE, remainingChars))
      const truncatedDiff = clampText(diff, allowedChars)
      remainingChars = Math.max(0, remainingChars - truncatedDiff.length)

      return {
        file,
        diff: truncatedDiff,
      }
    })

    repoDiffCache = { cwd, updatedAt: now, result }
    return result
  } catch {
    return []
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
    liveFeedFile: path.join(runDir, 'live-feed.jsonl'),
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

export async function buildSnapshot(config, queryRunId = '') {
  const activeRun = await readJsonFile(config.activeRunFile, null)
  const runs = await listRuns(config, activeRun)
  const selectedRunId = resolveSelectedRunId(queryRunId, activeRun, runs)
  const selectedConfig = selectedRunId !== '' ? getRunScopedConfig(config, selectedRunId) : config

  const [state, summary, telemetry, currentOutput, liveFeed] = await Promise.all([
    readJsonFile(selectedConfig.stateFile, null),
    readJsonFile(selectedConfig.lastIterationSummaryFile, null),
    readTelemetry(selectedConfig),
    readOptionalText(selectedConfig.lastAgentOutputFile, 5000),
    readJsonlTail(selectedConfig.liveFeedFile, 300),
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

  const selectedRunIsActive = selectedRunId !== '' && String(activeRun?.runId ?? '') === selectedRunId
  const activeTaskText = String((selectedRunIsActive ? activeRun?.task : state?.inProgress?.task) ?? summary?.task ?? '').trim()
  const [todos, currentEdits] = await Promise.all([
    parseTodos(config.taskFile, activeTaskText),
    Promise.resolve(selectedRunIsActive ? readRepoDiff(config.cwd) : []),
  ])

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
    todos,
    currentEdits,
    lastOutput: currentOutput,
    liveFeed,
    recentTelemetry,
  }
}

export function renderHtml() {
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
    .grid.main { grid-template-columns: minmax(320px, 420px) 1fr; align-items: start; }
    .detail-split { display:grid; grid-template-columns: 1fr 1fr; gap:16px; margin-top:16px; }
    .card {
      background: linear-gradient(180deg, rgba(255,255,255,.02), rgba(255,255,255,.01));
      border: 1px solid var(--line); border-radius: 16px; padding: 16px;
      box-shadow: 0 12px 40px rgba(0,0,0,.18);
    }
    .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
    .value { margin-top: 8px; font-size: 22px; font-weight: 700; }
    .value.small { font-size: 16px; }
    .todo-list { max-height: calc(100vh - 140px); overflow: auto; padding-right: 4px; }
    .todo-item { border:1px solid var(--line); border-radius:14px; background: var(--panel); margin-bottom:10px; overflow:hidden; }
    .todo-item.active { border-color: var(--active); box-shadow: 0 0 0 1px rgba(110,231,255,.25) inset; }
    .todo-summary { list-style:none; cursor:pointer; padding:12px 14px; display:flex; gap:10px; align-items:flex-start; }
    .todo-summary::-webkit-details-marker { display:none; }
    .todo-line { color: var(--muted); font-size: 11px; min-width: 52px; }
    .todo-text { flex:1; }
    .todo-heading { font-weight:700; }
    .todo-task { font-weight:600; }
    .todo-checked { color: var(--done); }
    .todo-open-body { padding: 0 14px 14px 14px; color: var(--muted); font-size: 12px; }
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
    .state-bar { display:flex; gap:10px; flex-wrap:wrap; margin-top:12px; }
    .state-chip { border:1px solid var(--line); border-radius:999px; padding:6px 10px; color: var(--muted); background: rgba(255,255,255,.03); }
    .kv { display: grid; grid-template-columns: 140px 1fr; gap: 6px 10px; margin-top: 12px; }
    .feed-toolbar { display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin-top:12px; margin-bottom:10px; }
    .feed-toggle { display:flex; gap:6px; align-items:center; color: var(--muted); font-size: 12px; }
    .feed { background: #0a1325; border: 1px solid var(--line); border-radius: 12px; padding: 12px; max-height: 320px; overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .feed-item { padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
    .feed-item:last-child { border-bottom: 0; }
    .feed-head { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    .feed-type { display:inline-flex; align-items:center; border:1px solid var(--line); border-radius:999px; padding:2px 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
    .feed-type.agent_start, .feed-type.agent_end { color: var(--active); }
    .feed-type.thinking_delta { color: #b392f0; }
    .feed-type.text_delta { color: var(--done); }
    .feed-type.tool_start, .feed-type.tool_update, .feed-type.tool_end { color: var(--skip); }
    .feed-meta { color: var(--muted); font-size: 12px; }
    .feed-text { white-space: pre-wrap; word-break: break-word; margin-top: 6px; }
    .feed-count { color: var(--muted); font-size: 11px; }
    .pinned-tool { background:#0a1325; border: 1px solid var(--line); border-radius:12px; padding:12px; }
    .pinned-tool-name { font-weight:700; }
    .pinned-tool-meta { color: var(--muted); font-size:12px; margin-top:4px; }
    .pinned-tool-text { white-space: pre-wrap; word-break: break-word; margin-top:8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
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
    .edit-list { max-height: 360px; overflow:auto; }
    .edit-item { border:1px solid var(--line); border-radius:12px; margin-bottom:10px; overflow:hidden; }
    .edit-head { padding:10px 12px; background: rgba(255,255,255,.03); font-weight:600; }
    .muted { color: var(--muted); }
    details.bottom { margin-top: 16px; }
    details.bottom summary { cursor:pointer; color: var(--muted); margin-bottom:10px; }
    @media (max-width: 1100px) { .grid.main, .detail-split, .flow { grid-template-columns: 1fr; } .todo-list { max-height:none; } }
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

    <div class="grid main">
      <div class="card">
        <div class="label">TODOS</div>
        <div class="todo-list" id="todo-list"></div>
      </div>

      <div>
        <div class="card">
          <div class="label">Focused todo</div>
          <div class="value small" id="todo-focus-title">—</div>
          <div class="state-bar" id="todo-state-bar"></div>
          <div class="flow" id="flow"></div>
          <div class="detail-split">
            <div class="card" style="margin:0;">
              <div class="label">Live worker feed</div>
              <div class="feed-toolbar">
                <label class="feed-toggle"><input type="checkbox" id="feed-show-thinking" checked /> <span>Show thinking</span></label>
                <label class="feed-toggle"><input type="checkbox" id="feed-collapse-deltas" checked /> <span>Collapse deltas</span></label>
              </div>
              <div class="feed" id="feed">No live feed yet.</div>
            </div>
            <div class="grid" style="gap:16px;">
              <div class="card" style="margin:0;"><div class="label">Latest tool output</div><div class="pinned-tool" id="pinned-tool">No tool activity yet.</div></div>
              <div class="card" style="margin:0;">
                <div class="label">Current edits for focused todo</div>
                <div class="edit-list" id="edit-list">No repo edits yet.</div>
              </div>
            </div>
          </div>
        </div>

        <details class="bottom card">
          <summary>Diagnostics</summary>
          <div class="grid" style="gap:16px;">
            <div class="card" style="margin:0;"><div class="label">Run state</div><div class="kv" id="run-state"></div></div>
            <div class="card" style="margin:0;"><div class="label">Iteration stage graph</div><div class="graph" id="graph"></div></div>
            <div class="card" style="margin:0;"><div class="label">Recent telemetry timeline</div><div style="margin-top: 12px; overflow: auto; max-height: 360px;"><table><thead><tr><th>Time</th><th>Iteration</th><th>Kind</th><th>Status</th><th>Notes</th></tr></thead><tbody id="timeline"></tbody></table></div></div>
            <div class="card" style="margin:0;"><div class="label">Selected event</div><pre id="selected-event">Click graph node or timeline row.</pre></div>
            <div class="card" style="margin:0;"><div class="label">Last iteration summary</div><pre id="summary">—</pre></div>
            <div class="card" style="margin:0;"><div class="label">Last agent output</div><pre id="output">—</pre></div>
          </div>
        </details>
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
    let selectedTodoId = ''
    let eventSource = null
    const renderCache = {
      runsKey: '',
      todosKey: '',
      focusKey: '',
      editsKey: '',
      flowKey: '',
      graphKey: '',
      runStateKey: '',
      summaryKey: '',
      outputKey: '',
      feedKey: '',
      timelineKey: '',
    }

    function normalizeFeedEntry(entry) {
      return {
        ...entry,
        type: String(entry?.type || 'event'),
        text: String(entry?.text || ''),
      }
    }

    function collapseFeedEntries(entries) {
      const collapsed = []
      for (const raw of entries) {
        const entry = normalizeFeedEntry(raw)
        const prev = collapsed[collapsed.length - 1]
        const canMerge = prev
          && (entry.type === 'text_delta' || entry.type === 'thinking_delta')
          && prev.type === entry.type
          && prev.role === entry.role
          && prev.kind === entry.kind
        if (canMerge) {
          prev.text += entry.text
          prev.count = (prev.count || 1) + 1
          prev.timestamp = entry.timestamp
          continue
        }
        collapsed.push({ ...entry, count: 1 })
      }
      return collapsed
    }

    function getVisibleFeedEntries(snapshot) {
      const showThinking = document.getElementById('feed-show-thinking')?.checked !== false
      const collapseDeltas = document.getElementById('feed-collapse-deltas')?.checked !== false
      const source = Array.isArray(snapshot?.liveFeed) ? snapshot.liveFeed : []
      const filtered = source.filter((entry) => showThinking || entry.type !== 'thinking_delta')
      return collapseDeltas ? collapseFeedEntries(filtered) : filtered.map((entry) => ({ ...normalizeFeedEntry(entry), count: 1 }))
    }

    function renderPinnedTool(snapshot) {
      const target = document.getElementById('pinned-tool')
      const source = Array.isArray(snapshot?.liveFeed) ? [...snapshot.liveFeed].reverse() : []
      const latest = source.find((entry) => entry.type === 'tool_update' || entry.type === 'tool_end' || entry.type === 'tool_start')
      if (!latest) {
        target.textContent = 'No tool activity yet.'
        return
      }
      target.innerHTML = '<div class="pinned-tool-name">' + esc(latest.toolName || 'tool') + '</div>' +
        '<div class="pinned-tool-meta">' + esc(latest.type) + ' · ' + esc(new Date(latest.timestamp).toLocaleTimeString()) + '</div>' +
        '<div class="pinned-tool-text">' + esc(latest.text || '') + '</div>'
    }

    function findEventById(snapshot, eventId) {
      if (!snapshot || !eventId) return null
      return snapshot.graph?.nodes?.find((node) => node.id === eventId)?.event
        || snapshot.recentTelemetry?.find((event) => event._vizId === eventId)
        || null
    }

    function findSelectedTodo(snapshot) {
      if (!snapshot) return null
      const todos = Array.isArray(snapshot.todos) ? snapshot.todos : []
      if (selectedTodoId) {
        const direct = todos.find((item) => item.id === selectedTodoId)
        if (direct) return direct
      }
      return todos.find((item) => item.active) || todos.find((item) => item.kind === 'task') || todos[0] || null
    }

    function renderSelectedEvent() {
      const event = findEventById(latestSnapshot, selectedEventId)
      document.getElementById('selected-event').textContent = event
        ? JSON.stringify(event, null, 2)
        : 'Click graph node or timeline row.'
    }

    function renderTodos(snapshot) {
      const todos = Array.isArray(snapshot?.todos) ? snapshot.todos : []
      const selected = findSelectedTodo(snapshot)
      if (selected && !selectedTodoId) {
        selectedTodoId = selected.id
      }
      const nextKey = JSON.stringify([todos, selected?.id || ''])
      if (renderCache.todosKey === nextKey) {
        return
      }
      renderCache.todosKey = nextKey
      const list = document.getElementById('todo-list')
      list.innerHTML = todos.length > 0
        ? todos.map((item) => {
            const active = selected && item.id === selected.id
            const checkedMark = item.checked ? '✓' : '○'
            const checkedClass = item.checked ? 'todo-checked' : ''
            return '<details class="todo-item ' + (active ? 'active' : '') + '" ' + (active ? 'open' : '') + ' data-todo-id="' + esc(item.id) + '">' +
              '<summary class="todo-summary">' +
                '<div class="todo-line">' + esc(String(item.lineNumber)) + '</div>' +
                '<div class="todo-task ' + checkedClass + '">' + esc(checkedMark + ' ' + item.text) + '</div>' +
              '</summary>' +
              '<div class="todo-open-body">' + esc(item.phase || '') + '</div>' +
            '</details>'
          }).join('')
        : '<div class="muted">No TODO items found.</div>'

      list.querySelectorAll('[data-todo-id]').forEach((element) => {
        element.addEventListener('toggle', () => {
          if (element.open) {
            selectedTodoId = element.getAttribute('data-todo-id') || ''
            renderCache.todosKey = ''
            renderCache.focusKey = ''
            renderSnapshot(snapshot)
          }
        })
      })
    }

    function renderFocusedTodo(snapshot) {
      const todo = findSelectedTodo(snapshot)
      const nextKey = JSON.stringify({
        todoId: todo?.id || '',
        activeLabel: snapshot?.flow?.activeLabel || '',
        iteration: snapshot?.flow?.iteration || '',
        phase: todo?.phase || snapshot?.summary?.phase || '',
        checked: todo?.checked === true,
        active: todo?.active === true,
      })
      if (renderCache.focusKey === nextKey) {
        return
      }
      renderCache.focusKey = nextKey
      document.getElementById('todo-focus-title').textContent = todo ? todo.text : 'No todo selected.'
      const stateBar = document.getElementById('todo-state-bar')
      const chips = [
        ['Current activity', snapshot?.flow?.activeLabel || 'Idle'],
        ['Iteration', snapshot?.flow?.iteration || '—'],
        ['Phase', todo?.phase || snapshot?.summary?.phase || '—'],
        ['Task status', todo ? (todo.checked ? 'Done' : (todo.active ? 'Active' : 'Pending')) : 'Info'],
      ]
      stateBar.innerHTML = chips.map(([label, value]) => '<div class="state-chip">' + esc(label + ': ' + value) + '</div>').join('')
    }

    function renderCurrentEdits(snapshot) {
      const edits = Array.isArray(snapshot?.currentEdits) ? snapshot.currentEdits : []
      const nextKey = JSON.stringify(edits)
      if (renderCache.editsKey === nextKey) {
        return
      }
      renderCache.editsKey = nextKey
      const target = document.getElementById('edit-list')
      target.innerHTML = edits.length > 0
        ? edits.map((entry) => '<details class="edit-item" open><summary class="edit-head">' + esc(entry.file) + '</summary><pre>' + esc(entry.diff || 'No diff available.') + '</pre></details>').join('')
        : '<div class="muted">No repo edits yet.</div>'
    }

    function bindSelectableEvents() {
      document.querySelectorAll('[data-event-id]').forEach((element) => {
        element.addEventListener('click', () => {
          selectedEventId = element.getAttribute('data-event-id') || ''
          renderSelectedEvent()
        })
      })
      ;['feed-show-thinking', 'feed-collapse-deltas'].forEach((id) => {
        const input = document.getElementById(id)
        if (input && !input.dataset.bound) {
          input.addEventListener('change', () => {
            if (latestSnapshot) {
              renderSnapshot(latestSnapshot)
            }
          })
          input.dataset.bound = '1'
        }
      })
    }

    function renderSnapshot(data) {
      latestSnapshot = data
      document.getElementById('cwd').textContent = data.config.cwd
      document.getElementById('last-refresh').textContent = 'Updated ' + new Date(data.now).toLocaleTimeString()
      if (!selectedTodoId) {
        const activeTodo = (Array.isArray(data.todos) ? data.todos.find((item) => item.active) : null) || null
        selectedTodoId = activeTodo?.id || ''
      }

      const select = document.getElementById('run-select')
      const selected = data.config.selectedRunId || ''
      const runsKey = JSON.stringify([selected, data.runs])
      if (renderCache.runsKey !== runsKey) {
        renderCache.runsKey = runsKey
        select.innerHTML = data.runs.map((run) => {
          const suffix = [run.status, run.phase].filter(Boolean).join(' · ')
          return '<option value="' + esc(run.runId) + '" ' + (selected === run.runId ? 'selected' : '') + '>' +
            esc(run.runId.slice(0, 8) + (suffix ? ' — ' + suffix : '')) + '</option>'
        }).join('')
      }
      if (!select.dataset.bound) {
        select.addEventListener('change', (event) => {
          updateRunQuery(event.target.value)
          connectStream()
        })
        select.dataset.bound = '1'
      }

      renderTodos(data)
      renderFocusedTodo(data)
      renderCurrentEdits(data)

      const flowEl = document.getElementById('flow')
      const flowKey = JSON.stringify(data.flow.steps)
      if (renderCache.flowKey !== flowKey) {
        renderCache.flowKey = flowKey
        flowEl.innerHTML = data.flow.steps.map((step) => {
          const latest = step.latestEvent
          const meta = latest ? [latest.kind, latest.status, latest.terminalReason].filter(Boolean).join('\\n') : 'waiting'
          return '<div class="step ' + esc(step.status) + '">' +
            '<div class="step-name">' + esc(step.label) + '</div>' +
            '<div class="step-status">' + esc(step.status) + '</div>' +
            '<div class="step-meta">' + esc(meta) + '</div>' +
            '</div>'
        }).join('')
      }

      const graphEl = document.getElementById('graph')
      const graphKey = JSON.stringify(data.graph.nodes)
      if (renderCache.graphKey !== graphKey) {
        renderCache.graphKey = graphKey
        graphEl.innerHTML = data.graph.nodes.length > 0
          ? data.graph.nodes.map((node) => {
              const retry = node.retryCount > 0 ? 'retry #' + node.retryCount : ''
              const meta = [node.kind, retry, node.role, node.terminalReason].filter(Boolean).join('\\n')
              return '<button type="button" class="graph-node ' + esc(node.status) + '" data-event-id="' + esc(node.id) + '">' +
                '<div class="step-name">' + esc(node.label) + '</div>' +
                '<div class="step-status">' + esc(node.status) + '</div>' +
                '<div class="step-meta">' + esc(meta) + '\\n' + esc(node.notes || '') + '</div>' +
                '</button>'
            }).join('')
          : '<div class="muted">No iteration graph yet.</div>'
      }

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
      const runStateKey = JSON.stringify(runState)
      if (renderCache.runStateKey !== runStateKey) {
        renderCache.runStateKey = runStateKey
        document.getElementById('run-state').innerHTML = runState.map(([k, v]) => '<div>' + esc(k) + '</div><div>' + esc(v) + '</div>').join('')
      }
      const summaryText = data.summary ? JSON.stringify(data.summary, null, 2) : 'No iteration summary yet.'
      if (renderCache.summaryKey !== summaryText) {
        renderCache.summaryKey = summaryText
        document.getElementById('summary').textContent = summaryText
      }
      const outputText = data.lastOutput || 'No agent output yet.'
      if (renderCache.outputKey !== outputText) {
        renderCache.outputKey = outputText
        document.getElementById('output').textContent = outputText
      }

      renderPinnedTool(data)
      const visibleFeed = getVisibleFeedEntries(data)
      const feedKey = JSON.stringify(visibleFeed)
      const feedEl = document.getElementById('feed')
      if (renderCache.feedKey !== feedKey) {
        renderCache.feedKey = feedKey
        const distanceFromBottom = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight
        const stickToBottom = distanceFromBottom < 40
        feedEl.innerHTML = visibleFeed.length > 0
          ? visibleFeed.map((entry) => {
              const meta = [entry.role, entry.kind, entry.toolName].filter(Boolean).join(' · ')
              return '<div class="feed-item">' +
                '<div class="feed-head">' +
                  '<div class="feed-type ' + esc(entry.type) + '">' + esc(entry.type || 'event') + '</div>' +
                  (entry.count > 1 ? '<div class="feed-count">x' + esc(entry.count) + '</div>' : '') +
                '</div>' +
                '<div class="feed-meta">' + esc(new Date(entry.timestamp).toLocaleTimeString()) + (meta ? ' · ' + esc(meta) : '') + '</div>' +
                '<div class="feed-text">' + esc(entry.text || '') + '</div>' +
                '</div>'
            }).join('')
          : '<div class="muted">No live feed yet.</div>'
        if (stickToBottom) {
          feedEl.scrollTop = feedEl.scrollHeight
        }
      }

      const timelineEvents = [...data.recentTelemetry].reverse()
      const timelineKey = JSON.stringify(timelineEvents)
      if (renderCache.timelineKey !== timelineKey) {
        renderCache.timelineKey = timelineKey
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
      }

      bindSelectableEvents()
      renderSelectedEvent()
    }

    function connectStream() {
      if (eventSource) {
        eventSource.close()
      }
      const runId = selectedRunId()
      const qs = runId ? '?runId=' + encodeURIComponent(runId) : ''
      eventSource = new EventSource('/api/stream' + qs)
      eventSource.onmessage = (event) => {
        try {
          renderSnapshot(JSON.parse(event.data))
        } catch (error) {
          document.getElementById('output').textContent = String(error)
        }
      }
      eventSource.onerror = () => {
        document.getElementById('last-refresh').textContent = 'Reconnecting…'
      }
    }

    connectStream()
  </script>
</body>
</html>`
}

export async function startVisualizerServer(config, overrides = {}) {
  const host = String(overrides.host ?? readVisualizerHost()).trim() || '127.0.0.1'
  const port = Number.isFinite(Number(overrides.port)) ? Number(overrides.port) : readVisualizerPort()

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
      if (url.pathname === '/api/stream') {
        const runId = url.searchParams.get('runId') || ''
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        })
        const send = async () => {
          const snapshot = await buildSnapshot(config, runId)
          res.write(`data: ${JSON.stringify(snapshot)}\n\n`)
        }
        await send()
        const interval = setInterval(() => {
          send().catch(() => {})
        }, 1500)
        req.on('close', () => {
          clearInterval(interval)
          res.end()
        })
        return
      }
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

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const url = `http://${host}:${port}`
  return {
    server,
    host,
    port,
    url,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    },
  }
}
