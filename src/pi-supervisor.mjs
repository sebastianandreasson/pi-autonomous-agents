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
  appendLog,
  commitStagedFiles,
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
  runVerification,
  runShellCommand,
  stageFiles,
  unstageFiles,
  runVisualCapture,
  timestamp,
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

let stopRequested = false

process.on('SIGINT', () => {
  stopRequested = true
})

process.on('SIGTERM', () => {
  stopRequested = true
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
    `[PI supervisor] iteration=${summary.iteration} phase="${summary.phase}"`,
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

  if (summary.sessionId) {
    lines.push(`[PI supervisor] session=${summary.sessionId}`)
  }

  if (summary.outputPath) {
    lines.push(`[PI supervisor] last_output=${summary.outputPath}`)
  }

  if (config.lastPromptFile) {
    lines.push(`[PI supervisor] last_prompt=${toDisplayPath(config, config.lastPromptFile)}`)
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
  return trimmed.split('\n').slice(0, 80).join('\n')
}

async function readLatestTesterFeedback(config) {
  const raw = await readOptionalTextFile(config.testerFeedbackFile)
  const trimmed = raw.trim()
  if (trimmed === '') {
    return ''
  }
  return trimmed.split('\n').slice(0, 120).join('\n')
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
  const messageMatch = raw.match(/^COMMIT_MESSAGE:\s*(.+)\s*$/im)
  const filesBlockMatch = raw.match(/^COMMIT_FILES:\s*\n((?:\s*-\s+.+\n?)+)/im)
  const files = filesBlockMatch
    ? filesBlockMatch[1]
      .split('\n')
      .map((line) => /^\s*-\s+(.+?)\s*$/.exec(line)?.[1] ?? '')
      .filter(Boolean)
    : []

  return {
    message: messageMatch?.[1]?.trim() ?? '',
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
  const beforeSnapshot = getRepoSnapshot(config.cwd)
  const dirtyFiles = new Set(listChangedFiles(config.cwd))
  const requestedFiles = Array.isArray(commitPlan.files) ? commitPlan.files.filter(Boolean) : []
  const commitMessage = String(commitPlan.message ?? '').trim()
  let status = 'success'
  let notes = ''
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
  } else {
    const stagedBefore = listStagedFiles(config.cwd)
    const unrelatedStagedBefore = stagedBefore.filter((file) => !requestedFiles.includes(file))

    if (unrelatedStagedBefore.length > 0) {
      status = 'blocked'
      notes = `commit_blocked_unrelated_staged_files=${unrelatedStagedBefore.join(',')}`
    } else {
      const filesToStage = requestedFiles.filter((file) => dirtyFiles.has(file))
      if (filesToStage.length === 0) {
        status = 'stalled'
        notes = 'commit_plan_no_dirty_files=true'
      } else {
        try {
          stageFiles(config.cwd, filesToStage)
          const stagedAfter = listStagedFiles(config.cwd)
          const unexpectedStaged = stagedAfter.filter((file) => !requestedFiles.includes(file))

          if (unexpectedStaged.length > 0) {
            const cleanedFiles = cleanupNewlyStagedFiles(stagedBefore, stagedAfter)
            status = 'blocked'
            notes = `commit_blocked_unexpected_staged_files=${unexpectedStaged.join(',')} unstaged_cleanup=${cleanedFiles.join(',')}`.trim()
          } else if (!stagedAfter.some((file) => requestedFiles.includes(file))) {
            const cleanedFiles = cleanupNewlyStagedFiles(stagedBefore, stagedAfter)
            status = 'stalled'
            notes = `commit_plan_failed_to_stage=true unstaged_cleanup=${cleanedFiles.join(',')}`.trim()
          } else {
            commitStagedFiles(config.cwd, commitMessage)
            notes = `commit_created=true files=${filesToStage.join(',')} message=${commitMessage}`
          }
        } catch (error) {
          const cleanedFiles = cleanupNewlyStagedFiles(stagedBefore, listStagedFiles(config.cwd))
          status = 'failed'
          notes = `commit_failed=${formatExecError(error)}${cleanedFiles.length > 0 ? ` unstaged_cleanup=${cleanedFiles.join(',')}` : ''}`
        }
      }
    }
  }

  const afterSnapshot = getRepoSnapshot(config.cwd)
  const changedFiles = listChangedFiles(config.cwd)

  await recordEvent(config, {
    iteration,
    phase,
    kind: 'git_finalize',
    status,
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
    notes,
  })

  return {
    status: status === 'success' && beforeSnapshot.head === afterSnapshot.head ? 'stalled' : status,
    notes,
  }
}

async function runVerificationStep({ config, iteration, phase, kind }) {
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
          notes: `${invocation.result.notes} no_repo_change=true`,
        },
      }
    }

    if (!shouldRetryForTimeout && !shouldRetryForNoChange) {
      return invocation
    }

    reason = shouldRetryForTimeout
      ? invocation.result.notes.includes('loop_detected=')
        ? `The previous turn got stuck repeating the same tool call (${invocation.result.notes}). Continue from the current repo state without rereading the same file over and over.`
        : 'The previous turn stalled or timed out. Continue from the current repo state.'
      : 'The previous turn ended without changing the repo. Continue and complete one coherent task.'
    prompt = buildSteeringPrompt(config, reason, {
      visualFeedback: await readLatestVisualFeedback(config),
      testerFeedback: await readLatestTesterFeedback(config),
    })

    if (shouldRetryForTimeout || shouldRetryForNoChange) {
      currentSessionId = ''
      currentSessionFile = ''
    }
  }

  throw new Error('Retry loop exited unexpectedly.')
}

async function runFixTurn({ config, iteration, phase, sessionId, sessionFile, testerOutput }) {
  const fixPrompt = buildFixPrompt(
    config,
    testerOutput.trim().split('\n').slice(-120).join('\n'),
    {
      visualFeedback: await readLatestVisualFeedback(config),
      testerFeedback: await readLatestTesterFeedback(config),
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
  const prompt = buildTesterPrompt(config, {
    phase,
    task,
    changedFiles,
    developerNotes,
    reason,
    visualFeedback: await readLatestVisualFeedback(config),
    testerFeedback: await readLatestTesterFeedback(config),
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

  if (testerStatus === 'success' && verdict === 'FAIL') {
    testerStatus = 'failed'
  } else if (testerStatus === 'success' && verdict === 'BLOCKED') {
    testerStatus = 'stalled'
  } else if (testerStatus === 'success' && verdict === 'UNKNOWN') {
    testerStatus = 'stalled'
  }

  return {
    ...invocation,
    testerVerdict: verdict,
    commitPlan,
    result: {
      ...invocation.result,
      status: testerStatus,
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
  const prompt = buildCommitPrompt(config, {
    phase,
    task,
    changedFiles,
    developerNotes,
    reason,
    visualFeedback: await readLatestVisualFeedback(config),
    testerFeedback: await readLatestTesterFeedback(config),
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

  if (testerStatus === 'success' && verdict === 'BLOCKED') {
    testerStatus = 'stalled'
  } else if (testerStatus === 'success' && verdict !== 'PASS') {
    testerStatus = 'stalled'
  } else if (testerStatus === 'success' && (commitPlan.message === '' || commitPlan.files.length === 0)) {
    testerStatus = 'stalled'
  }

  return {
    ...invocation,
    testerVerdict: verdict,
    commitPlan,
    result: {
      ...invocation.result,
      status: testerStatus,
      notes: notesWithVerdict,
    },
  }
}

async function runVisualReview({ config, iteration, phase, task, changedFiles }) {
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
  const taskInfo = findFirstUncheckedTaskInfo(config.taskFile)
  if (!taskInfo.hasUncheckedTasks) {
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
        lastRunAt: timestamp(),
      },
      summary: {
        iteration,
        phase: taskInfo.phase || 'complete',
        developerStatus: 'complete',
        testerStatus: 'not_needed',
        verificationStatus: 'not_needed',
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
  let finalVerificationStatus = 'not_run'
  let visualStatus = 'not_run'
  const noteParts = [`developer: ${mainInvocation.result.notes}`]

  if (mainInvocation.result.status === 'success' && config.transport === 'mock') {
    testerStatus = 'skipped'
    finalVerificationStatus = 'skipped'
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
        developerNotes: noteParts.join(' | '),
        reason: 'tester_review_after_basic_smoke_passed',
      })

      testerStatus = testerInvocation.result.status
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

      if (testerStatus === 'success' && (commitPlan.message === '' || commitPlan.files.length === 0)) {
        const testerCommitInvocation = await runTesterCommitTurn({
          config,
          iteration,
          phase,
          task,
          changedFiles: listChangedFiles(config.cwd),
          developerNotes: noteParts.join(' | '),
          reason: 'tester_passed_without_commit',
        })

        testerStatus = testerCommitInvocation.result.status
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

      if (testerStatus === 'success') {
        const gitFinalize = await runHarnessGitFinalize({
          config,
          iteration,
          phase,
          commitPlan,
        })
        testerStatus = gitFinalize.status
        noteParts.push(`git_finalize: ${gitFinalize.notes}`)
      }
    } else {
      testerStatus = 'skipped'
    }

    if (testerStatus === 'failed') {
      const fixInvocation = await runFixTurn({
        config,
        iteration,
        phase,
        sessionId,
        sessionFile,
        testerOutput: noteParts.join('\n'),
      })

      sessionId = fixInvocation.result.sessionId || sessionId
      sessionFile = fixInvocation.result.sessionFile || sessionFile
      developerStatus = fixInvocation.result.status
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

        if (testerStatus === 'success' && (commitPlan.message === '' || commitPlan.files.length === 0)) {
          const testerCommitInvocation = await runTesterCommitTurn({
            config,
            iteration,
            phase,
            task,
            changedFiles: listChangedFiles(config.cwd),
            developerNotes: noteParts.join(' | '),
            reason: 'tester_recheck_passed_without_commit',
          })

          testerStatus = testerCommitInvocation.result.status
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

        if (testerStatus === 'success') {
          const gitFinalize = await runHarnessGitFinalize({
            config,
            iteration,
            phase,
            commitPlan,
          })
          testerStatus = gitFinalize.status
          noteParts.push(`git_finalize: ${gitFinalize.notes}`)
        }

        if (testerStatus === 'success') {
          const reverify = await runVerificationStep({
            config,
            iteration,
            phase,
            kind: 'tester_reverification',
          })

          finalVerificationStatus = reverify.status
        }
      }
    }
  } else {
    testerStatus = 'not_run'
    finalVerificationStatus = 'not_run'
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
    noteParts.push(`visual: ${visualReview.notes}`)
  } else if (config.visualReviewEnabled) {
    visualStatus = 'skipped'
  }

  const finalStatus = deriveFinalStatusWithVisualReview({
    workflowStatus,
    visualStatus,
  })

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
  }

  await appendLog(
    config.logFile,
    `Finished iteration ${iteration} with status=${finalStatus} verification=${finalVerificationStatus}`
  )

  return {
    stateUpdate: nextState,
    summary: {
      iteration,
      phase,
      developerStatus,
      testerStatus,
      verificationStatus: finalVerificationStatus,
      visualStatus,
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
    shouldStop: false,
  }
}

async function main() {
  const config = loadConfig(process.argv[2] ?? 'once')
  ensureRepo(config.cwd)
  await ensureFileExists(config.taskFile, 'task file')
  await ensureFileExists(config.developerInstructionsFile, 'developer instructions file')
  await ensureFileExists(config.testerInstructionsFile, 'tester instructions file')
  await ensureTelemetryFiles(config)
  await runStartupPreflight(config)

  let state = await readState(config.stateFile)
  let completedIterations = 0

  while (!stopRequested) {
    const iteration = state.iteration + 1
    const result = await runIteration({ config, state, iteration })
    state = result.stateUpdate
    await writeState(config.stateFile, state)
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
}

main().catch(async (error) => {
  const config = loadConfig(process.argv[2] ?? 'once')
  await ensureTelemetryFiles(config)
  await appendLog(config.logFile, `Supervisor error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
