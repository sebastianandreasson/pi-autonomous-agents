import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
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

const visualizerSourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'visualizer-ui')
const visualizerDistDir = path.join(visualizerSourceDir, 'dist')

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.html') return 'text/html; charset=utf-8'
  if (ext === '.js') return 'text/javascript; charset=utf-8'
  if (ext === '.css') return 'text/css; charset=utf-8'
  if (ext === '.json') return 'application/json; charset=utf-8'
  if (ext === '.svg') return 'image/svg+xml'
  if (ext === '.png') return 'image/png'
  if (ext === '.ico') return 'image/x-icon'
  return 'application/octet-stream'
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function serveBuiltVisualizerAsset(reqPath, res) {
  const normalized = reqPath === '/' ? '/index.html' : reqPath
  const cleanPath = normalized.split('?')[0]
  const relativePath = cleanPath.startsWith('/') ? cleanPath.slice(1) : cleanPath
  const targetFile = path.resolve(visualizerDistDir, relativePath)
  if (!targetFile.startsWith(visualizerDistDir)) {
    return false
  }
  if (!await fileExists(targetFile)) {
    return false
  }

  const body = await fs.readFile(targetFile)
  res.writeHead(200, {
    'content-type': getContentType(targetFile),
    'cache-control': cleanPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
  })
  res.end(body)
  return true
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
    const items = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') {
        continue
      }
      try {
        items.push(JSON.parse(trimmed))
      } catch {
        // Ignore partial/truncated trailing JSONL records while file is actively being appended.
      }
    }
    return items
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
      color-scheme: dark;
      --bg: #0b1020;
      --panel: #121a30;
      --line: #263252;
      --text: #e6edf7;
      --muted: #95a3bf;
      --accent: #6ee7ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: linear-gradient(180deg, #08101d, var(--bg) 180px);
      color: var(--text);
    }
    main {
      max-width: 880px;
      margin: 48px auto;
      padding: 0 20px;
    }
    .card {
      background: linear-gradient(180deg, rgba(255,255,255,.02), rgba(255,255,255,.01));
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 20px;
      box-shadow: 0 12px 40px rgba(0,0,0,.18);
    }
    h1 { margin: 0 0 8px; font-size: 28px; }
    p { margin: 0 0 12px; color: var(--muted); }
    code, pre {
      font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
      background: #0a1325;
      border: 1px solid var(--line);
      border-radius: 12px;
    }
    code { padding: 2px 6px; }
    pre { padding: 14px; overflow: auto; }
    .accent { color: var(--accent); }
    .stack { display: grid; gap: 16px; }
  </style>
</head>
<body>
  <main>
    <div class="card stack">
      <div>
        <h1>PI Harness Visualizer</h1>
        <p>Built React UI missing. Server now expects assets from <code>visualizer-ui/dist/</code>.</p>
      </div>
      <div>
        <p class="accent">Build frontend:</p>
        <pre>npm --prefix visualizer-ui install
npm run build:visualizer:ui</pre>
      </div>
      <div>
        <p class="accent">Local dev loop:</p>
        <pre>npm run debug:live-ui
npm run dev:visualizer:ui</pre>
      </div>
      <div>
        <p>API still live at <code>/api/state</code> and <code>/api/stream</code>.</p>
      </div>
    </div>
  </main>
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
      if (url.pathname === '/api/state' || url.pathname === '/api/snapshot') {
        const snapshot = await buildSnapshot(config, url.searchParams.get('runId') || '')
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(snapshot))
        return
      }
      if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/assets/')) {
        if (await serveBuiltVisualizerAsset(url.pathname, res)) {
          return
        }
        if (url.pathname === '/' || url.pathname === '/index.html') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          res.end(renderHtml())
          return
        }
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
