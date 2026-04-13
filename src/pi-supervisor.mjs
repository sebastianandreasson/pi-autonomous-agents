#!/usr/bin/env node

import process from 'node:process'
import path from 'node:path'
import { loadConfig, resolveRoleModelName, resolveRoleModel } from './pi-config.mjs'
import {
  buildCommitPrompt,
  buildFixPrompt,
  buildMainPrompt,
  buildSteeringPrompt,
  buildTesterPrompt,
} from './pi-prompts.mjs'
import { appendTelemetry, ensureTelemetryFiles } from './pi-telemetry.mjs'
import {
  acquireRunLock,
  appendLog,
  collectLargeFileWarnings,
  commitStagedFiles,
  createRunId,
  didRepoChange,
  ensureFileExists,
  ensureRepo,
  findFirstUncheckedTaskInfo,
  getRepoSnapshot,
  listChangedFiles,
  listStagedFiles,
  readOptionalTextFile,
  readSessionId,
  readState,
  releaseRunLock,
  runVerification,
  runShellCommand,
  signalOwnedChildProcesses,
  stageFiles,
  unstageFiles,
  updateRunLock,
  runVisualCapture,
  timestamp,
  watchParentProcess,
  writeChangedFiles,
  writeSessionId,
  writeState,
  writeTextFile,
} from './pi-repo.mjs'
import { runAgentTurn } from './pi-client.mjs'
import {
  deriveFinalStatusWithVisualReview,
  deriveWorkflowStatus,
  shouldPersistLatestTesterFeedback,
} from './pi-flow.mjs'
import { runStartupPreflight } from './pi-preflight.mjs'
import { startVisualizerServer } from './pi-visualizer-server.mjs'

let stopRequested = false
let shutdownEscalationTimer = null

function requestStop() {
  stopRequested = true
  signalOwnedChildProcesses('SIGTERM')

  if (!shutdownEscalationTimer) {
    shutdownEscalationTimer = setTimeout(() => {
      signalOwnedChildProcesses('SIGKILL')
    }, 1000)
    if (typeof shutdownEscalationTimer.unref === 'function') {
      shutdownEscalationTimer.unref()
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    requestStop()
  })
}

const stopWatchingParent = watchParentProcess(() => {
  requestStop()
})

function sleep(seconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000)
  })
}

function printTerminalSummary(config, summary) {
  if (config.streamTerminal) {
    return
  }

  const lines = [
    `[PI supervisor] run_id=${summary.runId || config.runId || ''} iteration=${summary.iteration} phase="${summary.phase}"`,
    `[PI supervisor] task=${summary.taskFile || toDisplayPath(config, config.taskFile)} developer_instructions=${summary.developerInstructionsFile || toDisplayPath(config, config.developerInstructionsFile)} tester_instructions=${summary.testerInstructionsFile || toDisplayPath(config, config.testerInstructionsFile)}`,
    `[PI supervisor] transport=${config.transport} developer_model=${summary.developerModel || resolveRoleModelName(config, 'developer') || '(PI default)'} tester_model=${summary.testerModel || resolveRoleModelName(config, 'tester') || '(PI default)'}`,
    `[PI supervisor] developer=${summary.developerStatus} tester=${summary.testerStatus} verification=${summary.verificationStatus}`,
  ]

  if (summary.visualStatus && summary.visualStatus !== 'not_run') {
    lines.push(`[PI supervisor] visual=${summary.visualStatus} model=${summary.visualModel || resolveRoleModelName(config, 'visualReview') || '(disabled)'}`)
  }

  if (summary.notes) {
    lines.push(`[PI supervisor] notes=${summary.notes}`)
  }

  if (Array.isArray(summary.largeFileWarnings) && summary.largeFileWarnings.length > 0) {
    lines.push(`[PI supervisor] large_file_warnings=${formatLargeFileWarningsInline(summary.largeFileWarnings)}`)
  }

  if (summary.terminalReason) {
    lines.push(`[PI supervisor] terminal_reason=${summary.terminalReason}`)
  }

  if (summary.commitPlanFound !== undefined) {
    lines.push(`[PI supervisor] commit_plan_found=${summary.commitPlanFound}`)
  }

  if (summary.sessionId) {
    lines.push(`[PI supervisor] session=${summary.sessionId}`)
  }

  if (summary.outputPath) {
    lines.push(`[PI supervisor] last_output=${summary.outputPath}`)
  }

  if (config.lastPromptFile) {
    lines.push(`[PI supervisor] last_prompt=${toDisplayPath(config, config.lastPromptFile)}`)
  }

  if (config.lastIterationSummaryFile) {
    lines.push(`[PI supervisor] iteration_summary=${toDisplayPath(config, config.lastIterationSummaryFile)}`)
  }

  process.stderr.write(`${lines.join('\n')}\n`)
}

function toDisplayPath(config, filePath) {
  const relativePath = path.relative(config.cwd, filePath)
  if (
    relativePath !== ''
    && !relativePath.startsWith('..')
    && !path.isAbsolute(relativePath)
  ) {
    return relativePath.split(path.sep).join('/')
  }

  return filePath
}

function parseTesterVerdict(output) {
  const raw = String(output ?? '')
  const match = raw.match(/VERDICT:\s*(PASS|FAIL|BLOCKED)\s*$/im)
  return match?.[1]?.toUpperCase() ?? 'UNKNOWN'
}

function buildRetryReason(invocation) {
  const loopSignature = String(invocation?.result?.loopSignature ?? '')
  const notes = String(invocation?.result?.notes ?? '')

  if (loopSignature.startsWith('same_path:')) {
    const target = loopSignature.slice('same_path:'.length)
    return `The previous turn got stuck repeatedly editing ${target}. Reread ${target} exactly once before any new edit. Switch approach. Do not attempt another exact oldText patch on ${target} unless the file changed since the failed attempt.`
  }

  if (notes.includes('loop_detected=')) {
    return `The previous turn got stuck repeating the same tool call (${notes}). Continue from the current repo state without rereading the same file over and over.`
  }

  return 'The previous turn stalled or timed out. Continue from the current repo state.'
}

function formatIterationSummary(summary) {
  return `${JSON.stringify(summary, null, 2)}\n`
}

async function writeIterationSummary(config, summary) {
  await writeTextFile(config.lastIterationSummaryFile, formatIterationSummary(summary))
  if (config.runLastIterationSummaryFile && config.runLastIterationSummaryFile !== config.lastIterationSummaryFile) {
    await writeTextFile(config.runLastIterationSummaryFile, formatIterationSummary(summary))
  }
}

function createIterationSummary({
  runId,
  iteration,
  phase,
  task,
  repoChanged,
  developerStatus,
  testerStatus,
  testerVerdict,
  verificationStatus,
  commitPlanFound,
  gitFinalizeStatus,
  visualStatus,
  terminalReason,
  largeFileWarnings,
  sessionId,
  developerModel,
  testerModel,
  visualModel,
}) {
  return {
    runId,
    iteration,
    phase,
    task,
    repoChanged,
    developerStatus,
    testerStatus,
    testerVerdict,
    verificationStatus,
    commitPlanFound,
    gitFinalizeStatus,
    visualStatus,
    terminalReason,
    largeFileWarnings,
    sessionId,
    developerModel,
    testerModel,
    visualModel,
  }
}

async function persistStateSnapshot(config, state) {
  await writeState(config.stateFile, state)
  if (config.runStateFile && config.runStateFile !== config.stateFile) {
    await writeState(config.runStateFile, state)
  }
}

async function updateRunOwnership(config, fields = {}) {
  if (!config.activeRunFile || !config.runId) {
    return
  }

  await updateRunLock(config.activeRunFile, {
    runId: config.runId,
    pid: process.pid,
    heartbeatAt: timestamp(),
    ...fields,
  })
}

function didInvocationCreateCommit(invocation) {
  return invocation?.beforeSnapshot?.head !== invocation?.afterSnapshot?.head
}

function mergeLargeFileWarnings(existing, incoming) {
  const merged = new Map()
  for (const warning of [...(existing || []), ...(incoming || [])]) {
    if (!warning?.file) {
      continue
    }
    const key = `${warning.kind}:${warning.file}`
    const current = merged.get(key)
    if (!current || Number(warning.lineCount) > Number(current.lineCount)) {
      merged.set(key, warning)
    }
  }
  return [...merged.values()].sort((left, right) => right.lineCount - left.lineCount)
}

function findLargeFileWarnings(config, files) {
  return collectLargeFileWarnings(config.cwd, files, {
    largeFileWarningLines: config.largeFileWarningLines,
    largeSpecWarningLines: config.largeSpecWarningLines,
  })
}

function formatLargeFileWarningsInline(warnings) {
  const list = Array.isArray(warnings) ? warnings : []
  if (list.length === 0) {
    return ''
  }
  return list
    .slice(0, 3)
    .map((warning) => `${warning.file}(${warning.lineCount}${warning.kind === 'large_spec' ? ',spec' : ''})`)
    .join(', ')
}

function clampPromptLines(text, maxLines) {
  const normalized = String(text ?? '').trim()
  if (normalized === '') {
    return ''
  }

  const lines = normalized.split('\n')
  if (!Number.isFinite(maxLines) || maxLines <= 0 || lines.length <= maxLines) {
    return normalized
  }

  const remaining = lines.length - maxLines
  return `${lines.slice(0, maxLines).join('\n')}\n... (${remaining} more lines omitted)`
}

function compactNotePartsForPrompt(config, noteParts, fallback = '(none provided)') {
  const items = Array.isArray(noteParts) ? noteParts.filter(Boolean) : []
  if (items.length === 0) {
    return fallback
  }

  const maxItems = Math.min(6, items.length)
  const selected = items.slice(-maxItems)
  return clampPromptLines(selected.join('\n'), Number(config.maxPromptNotesLines) || 16)
}

function isInfrastructureVerificationFailure(output) {
  const text = String(output ?? '')
  return [
    'Process from config.webServer was not able to start',
    'No such file or directory',
    'listen EPERM',
    'EADDRINUSE',
    'browserType.launch:',
    'Executable doesn\'t exist',
  ].some((pattern) => text.includes(pattern))
}

async function recordEvent(config, event) {
  await appendTelemetry(config, {
    timestamp: timestamp(),
    runId: config.runId || '',
    ...event,
  })
}

async function runAgentInvocation({
  config,
  iteration,
  phase,
  prompt,
  role,
  kind,
  retryCount,
  reason,
  sessionId,
  sessionFile,
}) {
  await updateRunOwnership(config, {
    status: 'agent_running',
    iteration,
    phase,
    activeKind: kind,
    activeRole: role,
    activeReason: reason,
  })

  const beforeSnapshot = getRepoSnapshot(config.cwd)
  const resolvedModel = resolveRoleModel(config, role)
  const promptSnapshot = [
    `role=${role}`,
    `kind=${kind}`,
    `phase=${phase}`,
    `reason=${reason}`,
    `model=${resolvedModel.model || '(PI default)'}`,
    '',
    prompt,
  ].join('\n')
  await writeTextFile(config.lastPromptFile, `${promptSnapshot}\n`)
  const result = await runAgentTurn({
    config,
    model: resolvedModel.model,
    sessionId,
    sessionFile,
    prompt,
    iteration,
    retryCount,
    reason,
    phase,
    role,
    kind,
  })
  const afterSnapshot = getRepoSnapshot(config.cwd)
  const changedFiles = listChangedFiles(config.cwd)
  const repoChanged = didRepoChange(beforeSnapshot, afterSnapshot)

  await writeChangedFiles(config.changedFilesFile, changedFiles)

  const verificationStatus = kind.startsWith('verification')
    ? result.status
    : 'not_run_yet'

  await recordEvent(config, {
    iteration,
    phase,
    kind,
    status: result.status,
    transport: config.transport,
    sessionId: result.sessionId,
    timedOut: result.timedOut,
    exitCode: result.exitCode,
    durationSeconds: result.durationSeconds,
    commitBefore: beforeSnapshot.head,
    commitAfter: afterSnapshot.head,
    repoChanged,
    changedFilesCount: changedFiles.length,
    verificationStatus,
    retryCount,
    role,
    model: resolvedModel.model || '(PI default)',
    toolCalls: result.toolCalls ?? 0,
    toolErrors: result.toolErrors ?? 0,
    messageUpdates: result.messageUpdates ?? 0,
    stopReason: result.stopReason ?? '',
    loopDetected: result.loopDetected === true,
    loopSignature: result.loopSignature ?? '',
    testerVerdict: '',
    commitPlanFound: '',
    terminalReason: result.terminalReason ?? '',
    notes: `${result.notes} role=${role} model=${resolvedModel.model || '(PI default)'}`.trim(),
  })

  if (result.sessionId !== '') {
    await writeSessionId(config.sessionFile, result.sessionId)
  }

  return {
    beforeSnapshot,
    afterSnapshot,
    result,
    repoChanged,
    changedFiles,
    role,
    model: resolvedModel.model,
  }
}

async function readLatestVisualFeedback(config) {
  const raw = await readOptionalTextFile(config.visualFeedbackFile)
  const trimmed = raw.trim()
  if (trimmed === '') {
    return ''
  }
  return clampPromptLines(trimmed, Number(config.maxVisualFeedbackLines) || 20)
}

async function readLatestTesterFeedback(config) {
  const raw = await readOptionalTextFile(config.testerFeedbackFile)
  const trimmed = raw.trim()
  if (trimmed === '') {
    return ''
  }
  return clampPromptLines(trimmed, Number(config.maxTesterFeedbackLines) || 32)
}

async function writeTesterFeedback(config, { iteration, phase, task, source, status, output }) {
  const text = String(output ?? '').trim()
  if (text === '') {
    return
  }

  const content = [
    `# Tester Feedback`,
    ``,
    `- Iteration: ${iteration}`,
    `- Phase: ${phase || 'unknown'}`,
    `- Task: ${task || 'unknown'}`,
    `- Source: ${source}`,
    `- Status: ${status}`,
    ``,
    text,
    ``,
  ].join('\n')

  if (shouldPersistLatestTesterFeedback(source)) {
    await writeTextFile(config.testerFeedbackFile, content)
  }
  await writeTextFile(`${config.testerFeedbackHistoryDir}/${iteration}-${source}.md`, content)
}

function parseCommitPlan(output) {
  const raw = String(output ?? '')
  const lines = raw.split('\n')
  const messageLine = lines.find((line) => /^\s*(?:[-*]\s+)?COMMIT_MESSAGE:\s*(.+?)\s*$/i.test(line))
  const message = messageLine
    ? messageLine.replace(/^\s*(?:[-*]\s+)?COMMIT_MESSAGE:\s*/i, '').trim()
    : ''

  const filesStartIndex = lines.findIndex((line) => /^\s*(?:[-*]\s+)?COMMIT_FILES:\s*$/i.test(line))
  const files = []
  if (filesStartIndex >= 0) {
    for (const line of lines.slice(filesStartIndex + 1)) {
      const trimmed = line.trim()
      if (trimmed === '') {
        if (files.length > 0) {
          break
        }
        continue
      }
      if (/^VERDICT:/i.test(trimmed)) {
        break
      }
      if (/^(?:[-*]\s+)?[A-Z_]+:\s*/.test(trimmed)) {
        break
      }

      const normalized = trimmed
        .replace(/^[-*]\s+/, '')
        .replace(/^\d+\.\s+/, '')
        .trim()

      if (normalized !== '') {
        files.push(normalized)
      }
    }
  }

  return {
    message,
    files: [...new Set(files)],
  }
}

function formatExecError(error) {
  const stdout = error?.stdout ? String(error.stdout) : ''
  const stderr = error?.stderr ? String(error.stderr) : ''
  const message = error instanceof Error ? error.message : String(error)
  return `${stdout}${stderr}${message}`.trim()
}

async function runHarnessGitFinalize({
  config,
  iteration,
  phase,
  commitPlan,
}) {
  await updateRunOwnership(config, {
    status: 'git_finalize_running',
    iteration,
    phase,
    activeKind: 'git_finalize',
    activeRole: '',
    activeReason: '',
  })

  const beforeSnapshot = getRepoSnapshot(config.cwd)
  const dirtyFiles = new Set(listChangedFiles(config.cwd))
  const requestedFiles = Array.isArray(commitPlan.files) ? commitPlan.files.filter(Boolean) : []
  const commitMessage = String(commitPlan.message ?? '').trim()
  let status = 'success'
  let notes = ''
  let terminalReason = 'commit_created'
  const cleanupNewlyStagedFiles = (stagedBefore, stagedNow) => {
    const stagedBeforeSet = new Set(stagedBefore)
    const newlyStagedFiles = stagedNow.filter((file) => !stagedBeforeSet.has(file))
    if (newlyStagedFiles.length > 0) {
      unstageFiles(config.cwd, newlyStagedFiles)
      return newlyStagedFiles
    }
    return []
  }

  if (commitMessage === '' || requestedFiles.length === 0) {
    status = 'stalled'
    notes = 'commit_plan_missing=true'
    terminalReason = 'awaiting_commit_plan'
  } else {
    const stagedBefore = listStagedFiles(config.cwd)
    const unrelatedStagedBefore = stagedBefore.filter((file) => !requestedFiles.includes(file))

    if (unrelatedStagedBefore.length > 0) {
      status = 'blocked'
      notes = `commit_blocked_unrelated_staged_files=${unrelatedStagedBefore.join(',')}`
      terminalReason = 'commit_finalize_blocked_unrelated_staged'
    } else {
      const filesToStage = requestedFiles.filter((file) => dirtyFiles.has(file))
      if (filesToStage.length === 0) {
        status = 'stalled'
        notes = 'commit_plan_no_dirty_files=true'
        terminalReason = 'commit_plan_no_dirty_files'
      } else {
        try {
          stageFiles(config.cwd, filesToStage)
          const stagedAfter = listStagedFiles(config.cwd)
          const unexpectedStaged = stagedAfter.filter((file) => !requestedFiles.includes(file))

          if (unexpectedStaged.length > 0) {
            const cleanedFiles = cleanupNewlyStagedFiles(stagedBefore, stagedAfter)
            status = 'blocked'
            notes = `commit_blocked_unexpected_staged_files=${unexpectedStaged.join(',')} unstaged_cleanup=${cleanedFiles.join(',')}`.trim()
            terminalReason = 'commit_finalize_blocked_unexpected_staged'
          } else if (!stagedAfter.some((file) => requestedFiles.includes(file))) {
            const cleanedFiles = cleanupNewlyStagedFiles(stagedBefore, stagedAfter)
            status = 'stalled'
            notes = `commit_plan_failed_to_stage=true unstaged_cleanup=${cleanedFiles.join(',')}`.trim()
            terminalReason = 'commit_plan_failed_to_stage'
          } else {
            commitStagedFiles(config.cwd, commitMessage)
            notes = `commit_created=true files=${filesToStage.join(',')} message=${commitMessage}`
            terminalReason = 'commit_created'
          }
        } catch (error) {
          const cleanedFiles = cleanupNewlyStagedFiles(stagedBefore, listStagedFiles(config.cwd))
          status = 'failed'
          notes = `commit_failed=${formatExecError(error)}${cleanedFiles.length > 0 ? ` unstaged_cleanup=${cleanedFiles.join(',')}` : ''}`
          terminalReason = 'commit_finalize_failed'
        }
      }
    }
  }

  const afterSnapshot = getRepoSnapshot(config.cwd)
  const changedFiles = listChangedFiles(config.cwd)
  const finalStatus = status === 'success' && beforeSnapshot.head === afterSnapshot.head ? 'stalled' : status
  if (status === 'success' && finalStatus === 'stalled') {
    terminalReason = 'commit_not_created'
  }

  await recordEvent(config, {
    iteration,
    phase,
    kind: 'git_finalize',
    status: finalStatus,
    transport: 'local',
    sessionId: '',
    timedOut: false,
    exitCode: status === 'success' ? 0 : 1,
    durationSeconds: 0,
    commitBefore: beforeSnapshot.head,
    commitAfter: afterSnapshot.head,
    repoChanged: didRepoChange(beforeSnapshot, afterSnapshot),
    changedFilesCount: changedFiles.length,
    verificationStatus: 'not_run',
    retryCount: 0,
    role: '',
    model: '',
    toolCalls: 0,
    toolErrors: 0,
    messageUpdates: 0,
    stopReason: '',
    loopDetected: false,
    loopSignature: '',
    testerVerdict: '',
    commitPlanFound: requestedFiles.length > 0,
    terminalReason,
    notes,
  })

  return {
    status: finalStatus,
    notes,
    terminalReason,
  }
}

async function runVerificationStep({ config, iteration, phase, kind }) {
  await updateRunOwnership(config, {
    status: 'verification_running',
    iteration,
    phase,
    activeKind: kind,
    activeRole: '',
    activeReason: '',
  })

  const beforeSnapshot = getRepoSnapshot(config.cwd)
  const verification = await runVerification(config)
  const afterSnapshot = getRepoSnapshot(config.cwd)
  const changedFiles = listChangedFiles(config.cwd)

  await writeChangedFiles(config.changedFilesFile, changedFiles)

  const verificationNotes = verification.status === 'passed'
    ? 'Verification passed.'
    : verification.status === 'skipped'
      ? 'Verification skipped.'
      : 'Verification did not pass.'

  await recordEvent(config, {
    iteration,
    phase,
    kind,
    status: verification.status,
    transport: 'local',
    sessionId: '',
    timedOut: verification.timedOut,
    exitCode: verification.exitCode,
    durationSeconds: verification.durationSeconds,
    commitBefore: beforeSnapshot.head,
    commitAfter: afterSnapshot.head,
    repoChanged: didRepoChange(beforeSnapshot, afterSnapshot),
    changedFilesCount: changedFiles.length,
    verificationStatus: verification.status,
    retryCount: 0,
    role: '',
    model: '',
    toolCalls: 0,
    toolErrors: 0,
    messageUpdates: 0,
    stopReason: '',
    loopDetected: false,
    loopSignature: '',
    testerVerdict: '',
    commitPlanFound: '',
    terminalReason: `verification_${verification.status}`,
    notes: verificationNotes,
  })

  return verification
}

async function runMainTurnWithRetries({ config, iteration, phase, sessionId, sessionFile }) {
  let currentSessionId = sessionId
  let currentSessionFile = sessionFile
  let prompt = buildMainPrompt(config, {
    visualFeedback: await readLatestVisualFeedback(config),
    testerFeedback: await readLatestTesterFeedback(config),
  })
  let reason = 'main_workflow'

  for (let attempt = 0; attempt <= Math.max(config.idleRetryLimit, config.noChangeRetryLimit); attempt += 1) {
    const invocation = await runAgentInvocation({
      config,
      iteration,
      phase,
      prompt,
      role: attempt === 0 ? 'developer' : 'developerRetry',
      kind: 'main_agent',
      retryCount: attempt,
      reason,
      sessionId: currentSessionId,
      sessionFile: currentSessionFile,
    })

    currentSessionId = invocation.result.sessionId || currentSessionId
    currentSessionFile = invocation.result.sessionFile || currentSessionFile

    const shouldRetryForTimeout = (
      (invocation.result.status === 'timed_out' || invocation.result.status === 'stalled')
      && attempt < config.idleRetryLimit
    )

    const noRepoChange = (
      config.transport !== 'mock'
      && invocation.result.status === 'success'
      && !invocation.repoChanged
    )
    const shouldRetryForNoChange = (
      noRepoChange
      && attempt < config.noChangeRetryLimit
    )

    if (noRepoChange && !shouldRetryForNoChange) {
      return {
        ...invocation,
        result: {
          ...invocation.result,
          status: 'stalled',
          terminalReason: 'no_repo_change',
          notes: `${invocation.result.notes} no_repo_change=true`,
        },
      }
    }

    if (!shouldRetryForTimeout && !shouldRetryForNoChange) {
      return invocation
    }

    reason = shouldRetryForTimeout
      ? buildRetryReason(invocation)
      : 'The previous turn ended without changing the repo. Continue and complete one coherent task.'
    prompt = buildSteeringPrompt(config, reason, {
      visualFeedback: await readLatestVisualFeedback(config),
      testerFeedback: await readLatestTesterFeedback(config),
      largeFileWarnings: findLargeFileWarnings(config, listChangedFiles(config.cwd)),
    })

    if (shouldRetryForTimeout || shouldRetryForNoChange) {
      currentSessionId = ''
      currentSessionFile = ''
    }
  }

  throw new Error('Retry loop exited unexpectedly.')
}

async function runFixTurn({ config, iteration, phase, sessionId, sessionFile, testerOutput }) {
  const largeFileWarnings = findLargeFileWarnings(config, listChangedFiles(config.cwd))
  const fixPrompt = buildFixPrompt(
    config,
    clampPromptLines(testerOutput, Number(config.maxVerificationExcerptLines) || 40),
    {
      visualFeedback: await readLatestVisualFeedback(config),
      testerFeedback: await readLatestTesterFeedback(config),
      largeFileWarnings,
    }
  )
  return await runAgentInvocation({
    config,
    iteration,
    phase,
    prompt: fixPrompt,
    role: 'developerFix',
    kind: 'fix_agent',
    retryCount: 0,
    reason: 'verification_failed',
    sessionId,
    sessionFile,
  })
}

async function runDeveloperVerificationAndFix({
  config,
  iteration,
  phase,
  sessionId,
  sessionFile,
  noteParts,
}) {
  const verification = await runVerificationStep({
    config,
    iteration,
    phase,
    kind: 'developer_verification',
  })

  let developerStatus = 'success'
  let nextSessionId = sessionId
  let nextSessionFile = sessionFile
  let verificationStatus = verification.status

  if (verification.status === 'failed' || verification.status === 'timed_out') {
    if (isInfrastructureVerificationFailure(verification.output)) {
      developerStatus = 'blocked'
      verificationStatus = verification.status
      noteParts.push('developer_fix: verification_infrastructure_failure=true')
      return {
        developerStatus,
        verificationStatus,
        sessionId: nextSessionId,
        sessionFile: nextSessionFile,
        verificationOutput: verification.output,
        feedbackSource: 'developer_verification',
      }
    }

    const fixInvocation = await runFixTurn({
      config,
      iteration,
      phase,
      sessionId,
      sessionFile,
      testerOutput: `[developer_verification]\n${verification.output}`,
    })

    nextSessionId = fixInvocation.result.sessionId || nextSessionId
    nextSessionFile = fixInvocation.result.sessionFile || nextSessionFile
    developerStatus = fixInvocation.result.status
    noteParts.push(`developer_fix: ${fixInvocation.result.notes}`)

    if (fixInvocation.result.status === 'success') {
      const reverify = await runVerificationStep({
        config,
        iteration,
        phase,
        kind: 'developer_reverification',
      })

      verificationStatus = reverify.status
    } else {
      verificationStatus = 'not_run'
    }
  }

  return {
    developerStatus,
    verificationStatus,
    sessionId: nextSessionId,
    sessionFile: nextSessionFile,
    verificationOutput: verification.output,
    feedbackSource: verification.status === 'failed' || verification.status === 'timed_out'
      ? 'developer_verification'
      : '',
  }
}

async function runTesterTurn({
  config,
  iteration,
  phase,
  task,
  changedFiles,
  developerNotes,
  reason,
}) {
  const largeFileWarnings = findLargeFileWarnings(config, changedFiles)
  const prompt = buildTesterPrompt(config, {
    phase,
    task,
    changedFiles,
    developerNotes,
    reason,
    visualFeedback: await readLatestVisualFeedback(config),
    testerFeedback: await readLatestTesterFeedback(config),
    largeFileWarnings,
  })

  const invocation = await runAgentInvocation({
    config,
    iteration,
    phase,
    prompt,
    role: 'tester',
    kind: 'tester_agent',
    retryCount: 0,
    reason,
    sessionId: '',
    sessionFile: '',
  })

  const verdict = parseTesterVerdict(invocation.result.output)
  const commitPlan = parseCommitPlan(invocation.result.output)
  const notesWithVerdict = `${invocation.result.notes} tester_verdict=${verdict} commit_plan_files=${commitPlan.files.length}`.trim()
  let testerStatus = invocation.result.status
  let terminalReason = invocation.result.terminalReason || ''

  if (testerStatus === 'success' && verdict === 'FAIL') {
    testerStatus = 'failed'
    terminalReason = 'tester_verdict_fail'
  } else if (testerStatus === 'success' && verdict === 'BLOCKED') {
    testerStatus = 'stalled'
    terminalReason = 'tester_verdict_blocked'
  } else if (testerStatus === 'success' && verdict === 'UNKNOWN') {
    testerStatus = 'stalled'
    terminalReason = 'tester_verdict_unknown'
  } else if (testerStatus === 'success' && config.commitMode === 'plan') {
    terminalReason = commitPlan.message !== '' && commitPlan.files.length > 0
      ? 'tester_pass_with_commit_plan'
      : 'awaiting_commit_plan'
  } else if (testerStatus === 'success') {
    terminalReason = didInvocationCreateCommit(invocation)
      ? 'tester_pass_with_agent_commit'
      : invocation.repoChanged
        ? 'tester_left_uncommitted_changes'
        : 'awaiting_agent_commit'
  }

  return {
    ...invocation,
    testerVerdict: verdict,
    commitPlanFound: commitPlan.message !== '' && commitPlan.files.length > 0,
    commitPlan,
    result: {
      ...invocation.result,
      status: testerStatus,
      terminalReason,
      notes: notesWithVerdict,
    },
  }
}

async function runTesterCommitTurn({
  config,
  iteration,
  phase,
  task,
  changedFiles,
  developerNotes,
  reason,
}) {
  const largeFileWarnings = findLargeFileWarnings(config, changedFiles)
  const prompt = buildCommitPrompt(config, {
    phase,
    task,
    changedFiles,
    developerNotes,
    reason,
    visualFeedback: await readLatestVisualFeedback(config),
    testerFeedback: await readLatestTesterFeedback(config),
    largeFileWarnings,
  })

  const invocation = await runAgentInvocation({
    config,
    iteration,
    phase,
    prompt,
    role: 'testerCommit',
    kind: 'tester_commit',
    retryCount: 0,
    reason,
    sessionId: '',
    sessionFile: '',
  })

  const verdict = parseTesterVerdict(invocation.result.output)
  const commitPlan = parseCommitPlan(invocation.result.output)
  const notesWithVerdict = `${invocation.result.notes} tester_verdict=${verdict} commit_plan_files=${commitPlan.files.length}`.trim()
  let testerStatus = invocation.result.status
  let terminalReason = invocation.result.terminalReason || ''

  if (testerStatus === 'success' && verdict === 'BLOCKED') {
    testerStatus = 'stalled'
    terminalReason = 'tester_commit_blocked'
  } else if (testerStatus === 'success' && verdict !== 'PASS') {
    testerStatus = 'stalled'
    terminalReason = 'tester_commit_missing_pass'
  } else if (testerStatus === 'success' && (commitPlan.message === '' || commitPlan.files.length === 0)) {
    testerStatus = 'stalled'
    terminalReason = 'awaiting_commit_plan'
  } else if (testerStatus === 'success') {
    terminalReason = 'tester_commit_plan_ready'
  }

  return {
    ...invocation,
    testerVerdict: verdict,
    commitPlanFound: commitPlan.message !== '' && commitPlan.files.length > 0,
    commitPlan,
    result: {
      ...invocation.result,
      status: testerStatus,
      terminalReason,
      notes: notesWithVerdict,
    },
  }
}

async function runVisualReview({ config, iteration, phase, task, changedFiles }) {
  await updateRunOwnership(config, {
    status: 'visual_capture_running',
    iteration,
    phase,
    activeKind: 'visual_capture',
    activeRole: '',
    activeReason: '',
  })

  const capture = await runVisualCapture(config, {
    iteration,
    phase,
    changedFiles,
  })

  await recordEvent(config, {
    iteration,
    phase,
    kind: 'visual_capture',
    status: capture.status,
    transport: 'local',
    sessionId: '',
    timedOut: capture.timedOut,
    exitCode: capture.exitCode,
    durationSeconds: capture.durationSeconds,
    commitBefore: getRepoSnapshot(config.cwd).head,
    commitAfter: getRepoSnapshot(config.cwd).head,
    repoChanged: false,
    changedFilesCount: changedFiles.length,
    verificationStatus: 'not_run',
    retryCount: 0,
    role: '',
    model: '',
    toolCalls: 0,
    toolErrors: 0,
    messageUpdates: 0,
    stopReason: '',
    loopDetected: false,
    loopSignature: '',
    testerVerdict: '',
    commitPlanFound: '',
    terminalReason: `visual_capture_${capture.status}`,
    notes: capture.status === 'passed'
      ? `screenshots=${capture.screenshots.length} manifest=${capture.manifestPath}`
      : capture.output.trim().split('\n').slice(-8).join(' '),
  })

  if (capture.status !== 'passed') {
    return {
      status: capture.status === 'skipped' ? 'skipped' : 'blocked',
      notes: capture.status === 'skipped'
        ? 'Visual review skipped because no visual capture command is configured.'
        : `visual_capture_failed=true ${capture.output.trim().split('\n').slice(-8).join(' ')}`.trim(),
    }
  }

  await updateRunOwnership(config, {
    status: 'visual_review_running',
    iteration,
    phase,
    activeKind: 'visual_review',
    activeRole: 'visualReview',
    activeReason: '',
  })

  const visualReviewModel = resolveRoleModel(config, 'visualReview')
  const reviewRequest = {
    iteration,
    phase,
    task,
    changedFiles,
    screenshots: capture.screenshots,
    feedbackFile: config.visualFeedbackFile,
    model: visualReviewModel.model,
    modelProfile: visualReviewModel.modelProfile,
    maxImages: config.visualReviewMaxImages,
  }

  const historyFile = `${config.visualReviewHistoryDir}/${iteration}.md`
  await appendLog(config.logFile, `Starting visual review via: ${config.visualReviewCommand}`)
  const response = await runShellCommand({
    cwd: config.cwd,
    command: config.visualReviewCommand,
    timeoutSeconds: config.visualReviewTimeoutSeconds,
    stdinText: `${JSON.stringify(reviewRequest)}\n`,
  })

  let parsed = null
  try {
    parsed = JSON.parse(response.stdout.trim() || '{}')
  } catch {
    parsed = null
  }

  const output = String(parsed?.output ?? response.combinedOutput).trim()
  const verdict = String(parsed?.verdict ?? 'BLOCKED').toUpperCase()
  const status = response.timedOut
    ? 'timed_out'
    : response.exitCode !== 0 || String(parsed?.status ?? '') === 'failed'
      ? 'failed'
      : verdict === 'PASS'
        ? 'passed'
        : verdict === 'FAIL'
          ? 'failed'
          : 'blocked'

  if (output !== '') {
    await writeTextFile(historyFile, `${output}\n`)
    await writeTextFile(config.visualFeedbackFile, `${output}\n`)
  }

  await recordEvent(config, {
    iteration,
    phase,
    kind: 'visual_review',
    status,
    transport: 'local',
    sessionId: '',
    timedOut: response.timedOut,
    exitCode: response.exitCode,
    durationSeconds: response.durationSeconds,
    commitBefore: getRepoSnapshot(config.cwd).head,
    commitAfter: getRepoSnapshot(config.cwd).head,
    repoChanged: false,
    changedFilesCount: changedFiles.length,
    verificationStatus: 'not_run',
    retryCount: 0,
    role: 'visualReview',
    model: visualReviewModel.model || '(unset)',
    toolCalls: 0,
    toolErrors: 0,
    messageUpdates: 0,
    stopReason: '',
    loopDetected: false,
    loopSignature: '',
    testerVerdict: verdict,
    commitPlanFound: '',
    terminalReason: `visual_review_${status}`,
    notes: `verdict=${verdict} feedback=${config.visualFeedbackFile} role=visualReview model=${visualReviewModel.model || '(unset)'}`.trim(),
  })

  return {
    status,
    notes: `visual_verdict=${verdict} feedback=${config.visualFeedbackFile} role=visualReview model=${visualReviewModel.model || '(unset)'}`,
  }
}

async function runIteration({ config, state, iteration }) {
  const developerModelName = resolveRoleModelName(config, 'developer')
  const testerModelName = resolveRoleModelName(config, 'tester')
  const visualReviewRoleModel = resolveRoleModel(config, 'visualReview')
  const visualModelName = visualReviewRoleModel.model
  const iterationStartSnapshot = getRepoSnapshot(config.cwd)
  const taskInfo = findFirstUncheckedTaskInfo(config.taskFile)
  if (!taskInfo.hasUncheckedTasks) {
    await updateRunOwnership(config, {
      status: 'idle',
      iteration,
      phase: taskInfo.phase || 'complete',
      task: '',
      lastCompletedIteration: iteration,
    })
    await appendLog(config.logFile, 'No unchecked tasks remain in TODOS.md')
    return {
      stateUpdate: {
        ...state,
        iteration,
        lastTransport: config.transport,
        lastPiModel: developerModelName,
        lastPhase: taskInfo.phase,
        lastStatus: 'complete',
        lastVerificationStatus: 'not_needed',
        runId: config.runId || '',
        inProgress: null,
        lastRunAt: timestamp(),
      },
      summary: {
        runId: config.runId || '',
        iteration,
        phase: taskInfo.phase || 'complete',
        task: '',
        repoChanged: false,
        developerStatus: 'complete',
        testerStatus: 'not_needed',
        testerVerdict: 'NOT_RUN',
        verificationStatus: 'not_needed',
        commitPlanFound: false,
        gitFinalizeStatus: 'not_run',
        visualStatus: 'not_run',
        terminalReason: 'all_tasks_complete',
        largeFileWarnings: [],
        notes: 'No unchecked tasks remain in TODOS.md.',
        sessionId: state.sessionId || '',
        outputPath: config.lastAgentOutputFile,
        taskFile: toDisplayPath(config, config.taskFile),
        developerInstructionsFile: toDisplayPath(config, config.developerInstructionsFile),
        testerInstructionsFile: toDisplayPath(config, config.testerInstructionsFile),
        developerModel: developerModelName,
        testerModel: testerModelName,
        visualModel: visualModelName,
      },
      shouldStop: true,
    }
  }

  const phase = taskInfo.phase || 'unknown'
  const task = taskInfo.task || 'unknown'
  const inProgressState = {
    ...state,
    runId: config.runId || '',
    inProgress: {
      runId: config.runId || '',
      status: 'in_progress',
      iteration,
      phase,
      task,
      startedAt: timestamp(),
      transport: config.transport,
    },
  }
  await persistStateSnapshot(config, inProgressState)
  await updateRunOwnership(config, {
    status: 'iteration_in_progress',
    iteration,
    phase,
    task,
    activeKind: '',
    activeRole: '',
    activeReason: '',
  })
  const canResumePriorSession = (
    state.lastTransport === config.transport
    && state.lastPiModel === developerModelName
    && state.lastStatus === 'success'
  )
  const startingSessionId = canResumePriorSession
    ? ((await readSessionId(config.sessionFile)) || state.sessionId || '')
    : ''
  const startingSessionFile = canResumePriorSession ? (state.sessionFile || '') : ''

  await appendLog(
    config.logFile,
    `Starting iteration ${iteration} in phase "${phase}" with transport "${config.transport}" task=${toDisplayPath(config, config.taskFile)} developer_instructions=${toDisplayPath(config, config.developerInstructionsFile)} tester_instructions=${toDisplayPath(config, config.testerInstructionsFile)} developer_model=${developerModelName || '(PI default)'} tester_model=${testerModelName || '(PI default)'}`
  )

  const mainInvocation = await runMainTurnWithRetries({
    config,
    iteration,
    phase,
    sessionId: startingSessionId,
    sessionFile: startingSessionFile,
  })

  let sessionId = mainInvocation.result.sessionId || startingSessionId
  let sessionFile = mainInvocation.result.sessionFile || startingSessionFile
  let developerStatus = mainInvocation.result.status
  let testerStatus = 'not_run'
  let testerVerdict = 'NOT_RUN'
  let finalVerificationStatus = 'not_run'
  let visualStatus = 'not_run'
  let commitPlanFound = false
  let gitFinalizeStatus = 'not_run'
  let terminalReason = mainInvocation.result.terminalReason || ''
  let largeFileWarnings = findLargeFileWarnings(config, mainInvocation.changedFiles)
  const noteParts = [`developer: ${mainInvocation.result.notes}`]

  if (mainInvocation.result.status === 'success' && config.transport === 'mock') {
    testerStatus = 'skipped'
    finalVerificationStatus = 'skipped'
    terminalReason = 'mock_completed'
  } else if (mainInvocation.result.status === 'success') {
    const developerVerification = await runDeveloperVerificationAndFix({
      config,
      iteration,
      phase,
      sessionId,
      sessionFile,
      noteParts,
    })

    sessionId = developerVerification.sessionId
    sessionFile = developerVerification.sessionFile
    developerStatus = developerVerification.developerStatus
    finalVerificationStatus = developerVerification.verificationStatus
    if (developerStatus !== 'success') {
      terminalReason = developerStatus === 'blocked'
        ? 'verification_infrastructure_failure'
        : 'developer_fix_incomplete'
    } else if (finalVerificationStatus !== 'passed' && finalVerificationStatus !== 'not_run') {
      terminalReason = `verification_${finalVerificationStatus}`
    }

    if (developerVerification.feedbackSource && developerVerification.verificationOutput.trim() !== '') {
      await writeTesterFeedback(config, {
        iteration,
        phase,
        task,
        source: developerVerification.feedbackSource,
        status: developerVerification.verificationStatus,
        output: developerVerification.verificationOutput,
      })
    }

    if (developerStatus === 'success' && finalVerificationStatus === 'passed') {
      const testerInvocation = await runTesterTurn({
        config,
        iteration,
        phase,
        task,
        changedFiles: listChangedFiles(config.cwd),
        developerNotes: compactNotePartsForPrompt(config, noteParts),
        reason: 'tester_review_after_basic_smoke_passed',
      })

      testerStatus = testerInvocation.result.status
      testerVerdict = testerInvocation.testerVerdict
      commitPlanFound = testerInvocation.commitPlanFound === true
      terminalReason = testerInvocation.result.terminalReason || terminalReason
      largeFileWarnings = mergeLargeFileWarnings(largeFileWarnings, findLargeFileWarnings(config, listChangedFiles(config.cwd)))
      noteParts.push(`tester: ${testerInvocation.result.notes}`)
      await writeTesterFeedback(config, {
        iteration,
        phase,
        task,
        source: 'tester_review',
        status: testerStatus,
        output: testerInvocation.result.output,
      })

      let commitPlan = testerInvocation.commitPlan

      if (testerStatus === 'success' && config.commitMode === 'plan' && (commitPlan.message === '' || commitPlan.files.length === 0)) {
        const testerCommitInvocation = await runTesterCommitTurn({
          config,
          iteration,
          phase,
          task,
          changedFiles: listChangedFiles(config.cwd),
          developerNotes: compactNotePartsForPrompt(config, noteParts),
          reason: 'tester_passed_without_commit',
        })

        testerStatus = testerCommitInvocation.result.status
        testerVerdict = testerCommitInvocation.testerVerdict
        commitPlanFound = testerCommitInvocation.commitPlanFound === true
        terminalReason = testerCommitInvocation.result.terminalReason || terminalReason
        largeFileWarnings = mergeLargeFileWarnings(largeFileWarnings, findLargeFileWarnings(config, listChangedFiles(config.cwd)))
        noteParts.push(`tester_commit: ${testerCommitInvocation.result.notes}`)
        await writeTesterFeedback(config, {
          iteration,
          phase,
          task,
          source: 'tester_commit_plan',
          status: testerStatus,
          output: testerCommitInvocation.result.output,
        })
        commitPlan = testerCommitInvocation.commitPlan
      }

      if (testerStatus === 'success' && config.commitMode === 'plan') {
        const gitFinalize = await runHarnessGitFinalize({
          config,
          iteration,
          phase,
          commitPlan,
        })
        testerStatus = gitFinalize.status
        gitFinalizeStatus = gitFinalize.status
        terminalReason = gitFinalize.terminalReason || terminalReason
        noteParts.push(`git_finalize: ${gitFinalize.notes}`)
      } else if (testerStatus === 'success') {
        if (didInvocationCreateCommit(testerInvocation)) {
          gitFinalizeStatus = 'committed_by_agent'
          terminalReason = 'completed_phase_step'
        } else {
          testerStatus = 'stalled'
          gitFinalizeStatus = 'awaiting_agent_commit'
          terminalReason = testerInvocation.repoChanged
            ? 'tester_left_uncommitted_changes'
            : 'awaiting_agent_commit'
          noteParts.push('git_finalize: committed_by_agent=false')
        }
      }
    } else {
      testerStatus = 'skipped'
      if (terminalReason === '') {
        terminalReason = 'tester_skipped_after_verification'
      }
    }

    if (testerStatus === 'failed') {
      const fixInvocation = await runFixTurn({
        config,
        iteration,
        phase,
        sessionId,
        sessionFile,
        testerOutput: compactNotePartsForPrompt(config, noteParts),
      })

      sessionId = fixInvocation.result.sessionId || sessionId
      sessionFile = fixInvocation.result.sessionFile || sessionFile
      developerStatus = fixInvocation.result.status
      terminalReason = fixInvocation.result.terminalReason || 'developer_fix_incomplete'
      largeFileWarnings = mergeLargeFileWarnings(largeFileWarnings, findLargeFileWarnings(config, listChangedFiles(config.cwd)))
      noteParts.push(`developer_fix: ${fixInvocation.result.notes}`)

      if (fixInvocation.result.status === 'success') {
        const testerRecheck = await runTesterTurn({
          config,
          iteration,
          phase,
          task,
          changedFiles: listChangedFiles(config.cwd),
          developerNotes: fixInvocation.result.notes,
          reason: 'tester_recheck_after_developer_fix',
        })

        testerStatus = testerRecheck.result.status
        testerVerdict = testerRecheck.testerVerdict
        commitPlanFound = testerRecheck.commitPlanFound === true
        terminalReason = testerRecheck.result.terminalReason || terminalReason
        largeFileWarnings = mergeLargeFileWarnings(largeFileWarnings, findLargeFileWarnings(config, listChangedFiles(config.cwd)))
        noteParts.push(`tester_recheck: ${testerRecheck.result.notes}`)
        await writeTesterFeedback(config, {
          iteration,
          phase,
          task,
          source: 'tester_recheck',
          status: testerStatus,
          output: testerRecheck.result.output,
        })

        let commitPlan = testerRecheck.commitPlan

        if (testerStatus === 'success' && config.commitMode === 'plan' && (commitPlan.message === '' || commitPlan.files.length === 0)) {
          const testerCommitInvocation = await runTesterCommitTurn({
            config,
            iteration,
            phase,
            task,
            changedFiles: listChangedFiles(config.cwd),
            developerNotes: compactNotePartsForPrompt(config, noteParts),
            reason: 'tester_recheck_passed_without_commit',
          })

          testerStatus = testerCommitInvocation.result.status
          testerVerdict = testerCommitInvocation.testerVerdict
          commitPlanFound = testerCommitInvocation.commitPlanFound === true
          terminalReason = testerCommitInvocation.result.terminalReason || terminalReason
          largeFileWarnings = mergeLargeFileWarnings(largeFileWarnings, findLargeFileWarnings(config, listChangedFiles(config.cwd)))
          noteParts.push(`tester_commit: ${testerCommitInvocation.result.notes}`)
          await writeTesterFeedback(config, {
            iteration,
            phase,
            task,
            source: 'tester_commit_plan',
            status: testerStatus,
            output: testerCommitInvocation.result.output,
          })
          commitPlan = testerCommitInvocation.commitPlan
        }

        if (testerStatus === 'success' && config.commitMode === 'plan') {
          const gitFinalize = await runHarnessGitFinalize({
            config,
            iteration,
            phase,
            commitPlan,
          })
          testerStatus = gitFinalize.status
          gitFinalizeStatus = gitFinalize.status
          terminalReason = gitFinalize.terminalReason || terminalReason
          noteParts.push(`git_finalize: ${gitFinalize.notes}`)
        } else if (testerStatus === 'success') {
          if (didInvocationCreateCommit(testerRecheck)) {
            gitFinalizeStatus = 'committed_by_agent'
            terminalReason = 'completed_phase_step'
          } else {
            testerStatus = 'stalled'
            gitFinalizeStatus = 'awaiting_agent_commit'
            terminalReason = testerRecheck.repoChanged
              ? 'tester_left_uncommitted_changes'
              : 'awaiting_agent_commit'
            noteParts.push('git_finalize: committed_by_agent=false')
          }
        }

        if (testerStatus === 'success') {
          const reverify = await runVerificationStep({
            config,
            iteration,
            phase,
            kind: 'tester_reverification',
          })

          finalVerificationStatus = reverify.status
          if (finalVerificationStatus !== 'passed') {
            terminalReason = `verification_${finalVerificationStatus}`
          }
        }
      }
    }
  } else {
    testerStatus = 'not_run'
    finalVerificationStatus = 'not_run'
    if (terminalReason === '') {
      terminalReason = 'developer_turn_incomplete'
    }
  }

  const workflowStatus = deriveWorkflowStatus({
    developerStatus,
    testerStatus,
    verificationStatus: finalVerificationStatus,
  })

  const candidateSuccessfulIterations = (
    workflowStatus === 'success'
      ? (state.successfulIterations ?? 0) + 1
      : (state.successfulIterations ?? 0)
  )

  const shouldRunVisualReview = (
    config.visualReviewEnabled
    && workflowStatus === 'success'
    && visualReviewRoleModel.model.trim() !== ''
    && !!visualReviewRoleModel.modelProfile?.baseUrl
    && config.visualReviewEveryNSuccesses > 0
    && candidateSuccessfulIterations % config.visualReviewEveryNSuccesses === 0
  )

  if (shouldRunVisualReview) {
    const visualReview = await runVisualReview({
      config,
      iteration,
      phase,
      task,
      changedFiles: listChangedFiles(config.cwd),
    })
    visualStatus = visualReview.status
    terminalReason = visualReview.status === 'passed'
      ? terminalReason
      : `visual_review_${visualReview.status}`
    noteParts.push(`visual: ${visualReview.notes}`)
  } else if (config.visualReviewEnabled) {
    visualStatus = 'skipped'
  }

  const finalStatus = deriveFinalStatusWithVisualReview({
    workflowStatus,
    visualStatus,
  })

  if (finalStatus === 'success') {
    terminalReason = 'completed_phase_step'
  } else if (terminalReason === '') {
    terminalReason = testerStatus === 'failed'
      ? 'tester_verdict_fail'
      : testerStatus === 'stalled'
        ? 'iteration_stalled'
        : developerStatus === 'blocked'
          ? 'developer_blocked'
          : developerStatus === 'failed'
            ? 'developer_failed'
            : finalVerificationStatus !== 'not_run'
              ? `verification_${finalVerificationStatus}`
              : 'workflow_incomplete'
  }

  const successfulIterations = (
    finalStatus === 'success'
      ? candidateSuccessfulIterations
      : (state.successfulIterations ?? 0)
  )

  const nextState = {
    iteration,
    lastTransport: config.transport,
    lastPiModel: developerModelName,
    sessionId,
    sessionFile,
    consecutiveFailures: (
      finalStatus === 'success'
      && (
        finalVerificationStatus === 'passed'
        || finalVerificationStatus === 'skipped'
        || finalVerificationStatus === 'not_run'
      )
    )
      ? 0
      : state.consecutiveFailures + 1,
    lastPhase: phase,
    lastStatus: finalStatus,
    lastVerificationStatus: finalVerificationStatus,
    lastRunAt: timestamp(),
    successfulIterations,
    lastVisualStatus: visualStatus,
    runId: config.runId || '',
    inProgress: null,
  }

  await updateRunOwnership(config, {
    status: 'idle',
    iteration,
    phase,
    task,
    lastCompletedIteration: iteration,
    lastStatus: finalStatus,
    activeKind: '',
    activeRole: '',
    activeReason: '',
  })

  await appendLog(
    config.logFile,
    `Finished iteration ${iteration} with status=${finalStatus} verification=${finalVerificationStatus} tester_verdict=${testerVerdict} commit_plan_found=${commitPlanFound} terminal_reason=${terminalReason}${largeFileWarnings.length > 0 ? ` large_file_warnings=${formatLargeFileWarningsInline(largeFileWarnings)}` : ''}`
  )

  const iterationEndSnapshot = getRepoSnapshot(config.cwd)
  const iterationSummary = createIterationSummary({
    runId: config.runId || '',
    iteration,
    phase,
    task,
    repoChanged: didRepoChange(iterationStartSnapshot, iterationEndSnapshot),
    developerStatus,
    testerStatus,
    testerVerdict,
    verificationStatus: finalVerificationStatus,
    commitPlanFound,
    gitFinalizeStatus,
    visualStatus,
    terminalReason,
    largeFileWarnings,
    sessionId,
    developerModel: developerModelName,
    testerModel: testerModelName,
    visualModel: visualModelName,
  })

  await recordEvent(config, {
    iteration,
    phase,
    kind: 'iteration_summary',
    status: finalStatus,
    transport: config.transport,
    sessionId,
    timedOut: false,
    exitCode: finalStatus === 'success' ? 0 : 1,
    durationSeconds: 0,
    commitBefore: iterationStartSnapshot.head,
    commitAfter: iterationEndSnapshot.head,
    repoChanged: iterationSummary.repoChanged,
    changedFilesCount: listChangedFiles(config.cwd).length,
    verificationStatus: finalVerificationStatus,
    retryCount: 0,
    role: '',
    model: '',
    toolCalls: 0,
    toolErrors: 0,
    messageUpdates: 0,
    stopReason: '',
    loopDetected: false,
    loopSignature: '',
    testerVerdict,
    commitPlanFound,
    terminalReason,
    riskWarnings: formatLargeFileWarningsInline(largeFileWarnings),
    notes: noteParts.join(' | '),
  })

  return {
    stateUpdate: nextState,
    summary: {
      runId: config.runId || '',
      iteration,
      phase,
      task,
      repoChanged: iterationSummary.repoChanged,
      developerStatus,
      testerStatus,
      testerVerdict,
      verificationStatus: finalVerificationStatus,
      commitPlanFound,
      gitFinalizeStatus,
      visualStatus,
      terminalReason,
      largeFileWarnings,
      notes: noteParts.join(' | '),
      sessionId,
      outputPath: config.lastAgentOutputFile,
      taskFile: toDisplayPath(config, config.taskFile),
      developerInstructionsFile: toDisplayPath(config, config.developerInstructionsFile),
      testerInstructionsFile: toDisplayPath(config, config.testerInstructionsFile),
      developerModel: developerModelName,
      testerModel: testerModelName,
      visualModel: visualModelName,
    },
    iterationSummary,
    shouldStop: false,
  }
}

async function main() {
  const config = loadConfig(process.argv[2] ?? 'once')
  const runId = createRunId()
  const runStartedAt = timestamp()
  const runDir = path.join(config.piRuntimeDir, 'runs', runId)
  config.runId = runId
  config.runStartedAt = runStartedAt
  config.runRuntimeDir = runDir
  config.runLogFile = path.join(runDir, 'pi.log')
  config.runTelemetryJsonl = path.join(runDir, 'pi_telemetry.jsonl')
  config.runTelemetryCsv = path.join(runDir, 'pi_telemetry.csv')
  config.runStateFile = path.join(runDir, 'state.json')
  config.runLastIterationSummaryFile = path.join(runDir, 'last-iteration.json')
  config.runLastAgentOutputFile = path.join(runDir, 'last-output.txt')
  config.runLiveFeedFile = path.join(runDir, 'live-feed.jsonl')

  ensureRepo(config.cwd)
  await ensureFileExists(config.taskFile, 'task file')
  await ensureFileExists(config.developerInstructionsFile, 'developer instructions file')
  await ensureFileExists(config.testerInstructionsFile, 'tester instructions file')
  let visualizer = null
  const lockResult = await acquireRunLock(config.activeRunFile, {
    runId,
    pid: process.pid,
    startedAt: runStartedAt,
    heartbeatAt: runStartedAt,
    status: 'starting',
    iteration: 0,
    phase: '',
    task: '',
    mode: config.mode,
    configFile: config.configFile,
    cwd: config.cwd,
  })
  try {
    process.env.PI_RUN_ID = runId
    process.env.PI_RUN_LOG_FILE = config.runLogFile
    await ensureTelemetryFiles(config)
    await appendLog(config.logFile, `Run started pid=${process.pid} mode=${config.mode}`)
    if (config.mode === 'run' && process.env.PI_VISUALIZER !== '0' && process.env.PI_VISUALIZER !== 'false') {
      try {
        visualizer = await startVisualizerServer(config)
        await appendLog(config.logFile, `Visualizer started at ${visualizer.url}`)
        process.stderr.write(`[PI visualizer] ${visualizer.url}\n`)
      } catch (error) {
        await appendLog(config.logFile, `Visualizer failed to start: ${error instanceof Error ? error.message : String(error)}`)
        process.stderr.write(`[PI visualizer] failed to start: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
    if (lockResult.staleLock) {
      await appendLog(
        config.logFile,
        `Recovered stale run lock from runId=${String(lockResult.staleLock.runId ?? '')} pid=${String(lockResult.staleLock.pid ?? '')} startedAt=${String(lockResult.staleLock.startedAt ?? '')}`
      )
    }
    await runStartupPreflight(config)

    let state = await readState(config.stateFile)
    if (state?.inProgress?.status === 'in_progress') {
      await appendLog(
        config.logFile,
        `Recovering unfinished iteration=${state.inProgress.iteration} phase="${state.inProgress.phase || ''}" task="${state.inProgress.task || ''}" from runId=${String(state.inProgress.runId || state.runId || '')}`
      )
    }
    let completedIterations = 0

    while (!stopRequested) {
      const iteration = state?.inProgress?.status === 'in_progress'
        ? Number(state.inProgress.iteration) || (state.iteration + 1)
        : state.iteration + 1
      await updateRunOwnership(config, {
        status: 'starting_iteration',
        iteration,
        activeKind: '',
        activeRole: '',
        activeReason: '',
      })
      const result = await runIteration({ config, state, iteration })
      await writeIterationSummary(config, result.iterationSummary ?? result.summary)
      state = result.stateUpdate
      await persistStateSnapshot(config, state)
      printTerminalSummary(config, result.summary)
      completedIterations += 1

      if (result.shouldStop || config.mode !== 'run' || completedIterations >= config.maxIterations) {
        break
      }

      await sleep(config.sleepBetweenSeconds)
    }

    if (stopRequested) {
      await appendLog(config.logFile, 'Stop requested by signal')
    }
  } finally {
    stopWatchingParent()
    if (shutdownEscalationTimer) {
      clearTimeout(shutdownEscalationTimer)
    }
    await updateRunOwnership(config, {
      status: stopRequested ? 'stopped' : 'finished',
      heartbeatAt: timestamp(),
      activeKind: '',
      activeRole: '',
      activeReason: '',
    })
    if (visualizer) {
      await visualizer.close().catch(() => {})
    }
    await releaseRunLock(config.activeRunFile, runId)
    delete process.env.PI_RUN_ID
    delete process.env.PI_RUN_LOG_FILE
  }
}

main().catch(async (error) => {
  const config = loadConfig(process.argv[2] ?? 'once')
  await appendLog(config.logFile, `Supervisor error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
