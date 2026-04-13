import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'

export function timestamp() {
  return new Date().toISOString()
}

export async function appendLog(logFile, message) {
  const runId = String(process.env.PI_RUN_ID ?? '').trim()
  const prefix = runId !== '' ? `[run:${runId}] ` : ''
  const line = `[${timestamp()}] ${prefix}${message}\n`
  await fs.mkdir(path.dirname(logFile), { recursive: true })
  await fs.appendFile(logFile, line, 'utf8')

  const runLogFile = String(process.env.PI_RUN_LOG_FILE ?? '').trim()
  if (runLogFile !== '' && runLogFile !== logFile) {
    await fs.mkdir(path.dirname(runLogFile), { recursive: true })
    await fs.appendFile(runLogFile, line, 'utf8')
  }
}

export function ensureRepo(cwd) {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd,
    stdio: 'ignore',
  })
}

export async function ensureFileExists(filePath, label) {
  try {
    await fs.access(filePath)
  } catch {
    throw new Error(`Missing ${label}: ${filePath}`)
  }
}

export async function readState(stateFile) {
  try {
    const raw = await fs.readFile(stateFile, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid state file payload')
    }
    return {
      iteration: 0,
      lastTransport: '',
      lastPiModel: '',
      sessionId: '',
      sessionFile: '',
      consecutiveFailures: 0,
      successfulIterations: 0,
      lastPhase: '',
      lastStatus: '',
      lastVerificationStatus: '',
      lastVisualStatus: '',
      lastRunAt: '',
      runId: '',
      inProgress: null,
      ...parsed,
    }
  } catch {
    return {
      iteration: 0,
      lastTransport: '',
      lastPiModel: '',
      sessionId: '',
      sessionFile: '',
      consecutiveFailures: 0,
      successfulIterations: 0,
      lastPhase: '',
      lastStatus: '',
      lastVerificationStatus: '',
      lastVisualStatus: '',
      lastRunAt: '',
      runId: '',
      inProgress: null,
    }
  }
}

export async function writeState(stateFile, state) {
  const formatted = `${JSON.stringify(state, null, 2)}\n`
  await fs.mkdir(path.dirname(stateFile), { recursive: true })
  await fs.writeFile(stateFile, formatted, 'utf8')
}

export function createRunId() {
  return randomUUID()
}

function normalizePid(raw) {
  const pid = Number.parseInt(String(raw ?? ''), 10)
  return Number.isInteger(pid) && pid > 0 ? pid : 0
}

export function isProcessRunning(pid) {
  const normalizedPid = normalizePid(pid)
  if (normalizedPid <= 0) {
    return false
  }

  try {
    process.kill(normalizedPid, 0)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      return error.code === 'EPERM'
    }
    return false
  }
}

export async function readJsonFile(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

async function writeJsonFile(filePath, value, flags) {
  const formatted = `${JSON.stringify(value, null, 2)}\n`
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, formatted, { encoding: 'utf8', flag: flags })
}

export async function acquireRunLock(lockFile, lockState) {
  const desired = {
    runId: String(lockState?.runId ?? ''),
    pid: normalizePid(lockState?.pid),
    startedAt: String(lockState?.startedAt ?? timestamp()),
    heartbeatAt: String(lockState?.heartbeatAt ?? timestamp()),
    status: String(lockState?.status ?? 'starting'),
    iteration: Number.isFinite(Number(lockState?.iteration)) ? Number(lockState.iteration) : 0,
    phase: String(lockState?.phase ?? ''),
    task: String(lockState?.task ?? ''),
    mode: String(lockState?.mode ?? ''),
    configFile: String(lockState?.configFile ?? ''),
    cwd: String(lockState?.cwd ?? ''),
  }

  await fs.mkdir(path.dirname(lockFile), { recursive: true })

  try {
    await writeJsonFile(lockFile, desired, 'wx')
    return { acquired: true, staleLock: null }
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') {
      throw error
    }
  }

  const existing = await readJsonFile(lockFile, null)
  const existingPid = normalizePid(existing?.pid)
  if (existing && existingPid > 0 && isProcessRunning(existingPid) && existingPid !== process.pid) {
    throw new Error(
      `Another pi-harness run is active (runId=${String(existing.runId ?? '')} pid=${existingPid} startedAt=${String(existing.startedAt ?? '')}).`
    )
  }

  await fs.rm(lockFile, { force: true })

  try {
    await writeJsonFile(lockFile, desired, 'wx')
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      const current = await readJsonFile(lockFile, null)
      throw new Error(
        `Another pi-harness run acquired the lock first (runId=${String(current?.runId ?? '')} pid=${String(current?.pid ?? '')}).`
      )
    }
    throw error
  }

  return { acquired: true, staleLock: existing }
}

export async function updateRunLock(lockFile, lockState) {
  const current = await readJsonFile(lockFile, null)
  if (!current) {
    return false
  }

  const next = {
    ...current,
    ...lockState,
    pid: normalizePid(lockState?.pid ?? current.pid),
    heartbeatAt: String(lockState?.heartbeatAt ?? timestamp()),
  }
  await writeJsonFile(lockFile, next)
  return true
}

export async function releaseRunLock(lockFile, runId) {
  const current = await readJsonFile(lockFile, null)
  if (!current) {
    return false
  }

  if (String(current.runId ?? '') !== String(runId ?? '')) {
    return false
  }

  await fs.rm(lockFile, { force: true })
  return true
}

export function signalProcessTree(pid, signal) {
  const normalizedPid = normalizePid(pid)
  if (normalizedPid <= 0) {
    return false
  }

  try {
    if (process.platform !== 'win32') {
      process.kill(-normalizedPid, signal)
    } else {
      process.kill(normalizedPid, signal)
    }
    return true
  } catch {
    return false
  }
}

export async function readSessionId(sessionFile) {
  try {
    return (await fs.readFile(sessionFile, 'utf8')).trim()
  } catch {
    return ''
  }
}

export async function writeSessionId(sessionFile, sessionId) {
  await fs.writeFile(sessionFile, `${sessionId}\n`, 'utf8')
}

function normalizeStatusPath(statusPath) {
  if (statusPath.startsWith('"') && statusPath.endsWith('"')) {
    return statusPath.slice(1, -1)
  }
  return statusPath
}

function parseStatusLine(line) {
  if (line.trim() === '') {
    return null
  }

  if (line.length < 4 || line[2] !== ' ') {
    return null
  }

  const renamedMarker = ' -> '
  const pathText = line.slice(3)
  if (pathText.includes(renamedMarker)) {
    const [, nextPath] = pathText.split(renamedMarker)
    return normalizeStatusPath(nextPath)
  }

  return normalizeStatusPath(pathText)
}

export function getHeadCommit(cwd) {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
  }).trim()
}

export function getStatusLines(cwd) {
  const output = execFileSync('git', ['status', '--short'], {
    cwd,
    encoding: 'utf8',
  })

  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
}

export function getRepoSnapshot(cwd) {
  return {
    head: getHeadCommit(cwd),
    statusLines: getStatusLines(cwd),
  }
}

export function listChangedFiles(cwd) {
  const files = getStatusLines(cwd)
    .map(parseStatusLine)
    .filter((value) => value !== null)

  return [...new Set(files)]
}

export function listStagedFiles(cwd) {
  const output = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
    cwd,
    encoding: 'utf8',
  })

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

export function stageFiles(cwd, files) {
  if (!Array.isArray(files) || files.length === 0) {
    return
  }

  execFileSync('git', ['add', '--', ...files], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

export function unstageFiles(cwd, files) {
  if (!Array.isArray(files) || files.length === 0) {
    return
  }

  execFileSync('git', ['restore', '--staged', '--', ...files], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

export function commitStagedFiles(cwd, message) {
  return execFileSync('git', ['commit', '-m', message], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

export function didRepoChange(beforeSnapshot, afterSnapshot) {
  return beforeSnapshot.head !== afterSnapshot.head
    || beforeSnapshot.statusLines.join('\n') !== afterSnapshot.statusLines.join('\n')
}

export async function writeChangedFiles(filePath, files) {
  const content = files.length > 0 ? `${files.join('\n')}\n` : ''
  await fs.writeFile(filePath, content, 'utf8')
}

export async function writeTextFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, 'utf8')
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true })
}

export async function readOptionalTextFile(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch {
    return ''
  }
}

export function findFirstUncheckedTaskInfo(taskFile) {
  const raw = readFileSync(taskFile, 'utf8')

  let phase = ''
  for (const line of raw.split('\n')) {
    const headingMatch = /^##\s+(.+)$/.exec(line)
    if (headingMatch) {
      phase = headingMatch[1]
      continue
    }

    const taskMatch = /^\s*-\s+\[\s\]\s+(.+)$/.exec(line)
    if (taskMatch) {
      return {
        hasUncheckedTasks: true,
        phase,
        task: taskMatch[1],
      }
    }
  }

  return {
    hasUncheckedTasks: false,
    phase,
    task: '',
  }
}

function countLines(text) {
  const normalized = String(text ?? '')
  if (normalized === '') {
    return 0
  }
  return normalized.split('\n').length
}

function isSpecLikeFile(filePath) {
  const normalized = String(filePath ?? '').replaceAll('\\', '/')
  return /(^|\/)(e2e|test|tests|spec|specs)\//.test(normalized)
    || /\.(spec|test)\.[cm]?[jt]sx?$/.test(normalized)
}

export function collectLargeFileWarnings(cwd, files, {
  largeFileWarningLines = 500,
  largeSpecWarningLines = 300,
} = {}) {
  const warnings = []
  const seen = new Set()

  for (const file of Array.isArray(files) ? files : []) {
    const relativePath = String(file ?? '').trim()
    if (relativePath === '' || seen.has(relativePath)) {
      continue
    }
    seen.add(relativePath)

    const absolutePath = path.resolve(cwd, relativePath)
    let raw = ''
    try {
      raw = readFileSync(absolutePath, 'utf8')
    } catch {
      continue
    }

    const lineCount = countLines(raw)
    const isSpec = isSpecLikeFile(relativePath)
    if (isSpec && lineCount >= largeSpecWarningLines) {
      warnings.push({
        file: relativePath,
        lineCount,
        kind: 'large_spec',
      })
      continue
    }

    if (lineCount >= largeFileWarningLines) {
      warnings.push({
        file: relativePath,
        lineCount,
        kind: 'large_file',
      })
    }
  }

  return warnings.sort((left, right) => right.lineCount - left.lineCount)
}

export async function runShellCommand({
  cwd,
  command,
  timeoutSeconds,
  stdinText = '',
  streamStdoutToParent = false,
  streamStderrToParent = false,
}) {
  return await new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn('/bin/zsh', ['-lc', command], {
      cwd,
      env: process.env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let killTimer = null
    let forceKillTimer = null

    killTimer = setTimeout(() => {
      timedOut = true
      signalProcessTree(child.pid, 'SIGTERM')
      forceKillTimer = setTimeout(() => {
        signalProcessTree(child.pid, 'SIGKILL')
      }, 10000)
    }, timeoutSeconds * 1000)

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      stdout += text
      if (streamStdoutToParent) {
        process.stdout.write(text)
      }
    })

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      stderr += text
      if (streamStderrToParent) {
        process.stderr.write(text)
      }
    })

    child.on('error', (error) => {
      if (killTimer) {
        clearTimeout(killTimer)
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer)
      }

      resolve({
        exitCode: 1,
        timedOut,
        durationSeconds: Math.round((Date.now() - startedAt) / 1000),
        stdout,
        stderr: `${stderr}${error.message}\n`,
        combinedOutput: `${stdout}${stderr}${error.message}\n`,
      })
    })

    child.on('close', (code) => {
      if (killTimer) {
        clearTimeout(killTimer)
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer)
      }

      const combinedOutput = `${stdout}${stderr}`
      resolve({
        exitCode: code ?? 1,
        timedOut,
        durationSeconds: Math.round((Date.now() - startedAt) / 1000),
        stdout,
        stderr,
        combinedOutput,
      })
    })

    if (stdinText !== '') {
      child.stdin.write(stdinText)
    }
    child.stdin.end()
  })
}

export async function runVerification(config) {
  if (config.testCommand.trim() === '') {
    const notes = 'Verification skipped because PI_TEST_CMD is empty.'
    await writeTextFile(config.lastVerificationOutputFile, `${notes}\n`)
    await appendLog(config.logFile, notes)

    return {
      status: 'skipped',
      exitCode: 0,
      timedOut: false,
      durationSeconds: 0,
      output: notes,
    }
  }

  await appendLog(config.logFile, `Starting verification: ${config.testCommand}`)
  const result = await runShellCommand({
    cwd: config.cwd,
    command: config.testCommand,
    timeoutSeconds: config.verificationTimeoutSeconds,
  })

  await writeTextFile(config.lastVerificationOutputFile, result.combinedOutput)
  await appendLog(config.logFile, `Verification exit=${result.exitCode} timed_out=${result.timedOut}`)

  let status = 'passed'
  if (result.timedOut) {
    status = 'timed_out'
  } else if (result.exitCode !== 0) {
    status = 'failed'
  }

  return {
    status,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationSeconds: result.durationSeconds,
    output: result.combinedOutput,
  }
}

export async function runVisualCapture(config, {
  iteration,
  phase,
  changedFiles,
}) {
  if (config.visualCaptureCommand.trim() === '') {
    return {
      status: 'skipped',
      exitCode: 0,
      timedOut: false,
      durationSeconds: 0,
      output: 'Visual capture skipped because PI_VISUAL_CAPTURE_CMD is empty.',
      manifestPath: '',
      screenshots: [],
    }
  }

  const captureIterationDir = path.join(config.visualCaptureDir, String(iteration))
  const manifestPath = path.join(captureIterationDir, 'manifest.json')
  await ensureDir(captureIterationDir)

  await appendLog(config.logFile, `Starting visual capture: ${config.visualCaptureCommand}`)
  const envPrefix = [
    `PI_VISUAL_ITERATION=${JSON.stringify(String(iteration))}`,
    `PI_VISUAL_PHASE=${JSON.stringify(phase)}`,
    `PI_VISUAL_CAPTURE_DIR=${JSON.stringify(captureIterationDir)}`,
    `PI_VISUAL_MANIFEST_FILE=${JSON.stringify(manifestPath)}`,
    `PI_VISUAL_CHANGED_FILES=${JSON.stringify(changedFiles.join('\n'))}`,
  ].join(' ')

  const result = await runShellCommand({
    cwd: config.cwd,
    command: `${envPrefix} ${config.visualCaptureCommand}`,
    timeoutSeconds: config.visualCaptureTimeoutSeconds,
  })

  if (result.timedOut) {
    return {
      status: 'timed_out',
      exitCode: result.exitCode,
      timedOut: true,
      durationSeconds: result.durationSeconds,
      output: result.combinedOutput,
      manifestPath,
      screenshots: [],
    }
  }

  if (result.exitCode !== 0) {
    return {
      status: 'failed',
      exitCode: result.exitCode,
      timedOut: false,
      durationSeconds: result.durationSeconds,
      output: result.combinedOutput,
      manifestPath,
      screenshots: [],
    }
  }

  let manifest
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  } catch (error) {
    return {
      status: 'failed',
      exitCode: 1,
      timedOut: false,
      durationSeconds: result.durationSeconds,
      output: `${result.combinedOutput}\nMissing or invalid visual capture manifest at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
      manifestPath,
      screenshots: [],
    }
  }

  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.screens)) {
    return {
      status: 'failed',
      exitCode: 1,
      timedOut: false,
      durationSeconds: result.durationSeconds,
      output: `${result.combinedOutput}\nVisual capture manifest must contain a "screens" array.`,
      manifestPath,
      screenshots: [],
    }
  }

  const screenshots = []
  for (const entry of manifest.screens) {
    if (!entry || typeof entry !== 'object') {
      continue
    }
    const relativePath = typeof entry.path === 'string' ? entry.path : ''
    if (relativePath === '') {
      continue
    }
    const absolutePath = path.resolve(captureIterationDir, relativePath)
    try {
      await fs.access(absolutePath)
    } catch {
      return {
        status: 'failed',
        exitCode: 1,
        timedOut: false,
        durationSeconds: result.durationSeconds,
        output: `${result.combinedOutput}\nVisual capture manifest referenced a missing file: ${absolutePath}`,
        manifestPath,
        screenshots: [],
      }
    }

    screenshots.push({
      id: typeof entry.id === 'string' ? entry.id : path.basename(relativePath),
      label: typeof entry.label === 'string' ? entry.label : relativePath,
      path: absolutePath,
      relativePath,
    })
  }

  if (screenshots.length === 0) {
    return {
      status: 'failed',
      exitCode: 1,
      timedOut: false,
      durationSeconds: result.durationSeconds,
      output: `${result.combinedOutput}\nVisual capture manifest did not contain any usable screenshots.`,
      manifestPath,
      screenshots: [],
    }
  }

  return {
    status: 'passed',
    exitCode: 0,
    timedOut: false,
    durationSeconds: result.durationSeconds,
    output: result.combinedOutput,
    manifestPath,
    screenshots,
  }
}
