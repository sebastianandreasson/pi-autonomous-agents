import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const liveFeedWriteQueues = new Map()
const liveFeedSequences = new Map()
const MAX_LIVE_FEED_TEXT = 2000
const MAX_LIVE_FEED_SUMMARY = 600
import {
  appendLog,
  writeTextFile,
} from './pi-repo.mjs'
import { runSdkTurn } from './pi-sdk-turn.mjs'

function truncateForNotes(text) {
  const trimmed = text.trim()
  if (trimmed.length <= 300) {
    return trimmed
  }
  return `${trimmed.slice(0, 297)}...`
}

function formatLastAgentOutput(response) {
  const sections = [
    `status: ${String(response.status ?? '')}`,
    `sessionId: ${String(response.sessionId ?? '')}`,
    `sessionFile: ${String(response.sessionFile ?? '')}`,
    `terminalReason: ${String(response.terminalReason ?? '')}`,
    `notes: ${String(response.notes ?? '').trim()}`,
  ]

  const output = String(response.output ?? '').trim()
  if (output !== '') {
    sections.push('', output)
  }

  return `${sections.join('\n')}\n`
}

async function writeAgentOutputSnapshot(config, content) {
  await writeTextFile(config.lastAgentOutputFile, content)
  if (config.runLastAgentOutputFile && config.runLastAgentOutputFile !== config.lastAgentOutputFile) {
    await writeTextFile(config.runLastAgentOutputFile, content)
  }
}

function truncateText(value, maxChars) {
  const text = String(value ?? '')
  if (text.length <= maxChars) {
    return text
  }
  return `${text.slice(0, maxChars - 16)}\n... [truncated]`
}

function summarizeValue(value, maxChars = MAX_LIVE_FEED_SUMMARY) {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'string') {
    return truncateText(value, maxChars)
  }
  try {
    return truncateText(JSON.stringify(value), maxChars)
  } catch {
    return truncateText(String(value), maxChars)
  }
}

function sanitizeLiveFeedEvent(filePath, event) {
  const nextSeq = (liveFeedSequences.get(filePath) ?? 0) + 1
  liveFeedSequences.set(filePath, nextSeq)

  const normalized = {
    seq: nextSeq,
    timestamp: String(event?.timestamp ?? new Date().toISOString()),
    iteration: Number(event?.iteration ?? 0),
    retryCount: Number(event?.retryCount ?? 0),
    reason: String(event?.reason ?? ''),
    phase: String(event?.phase ?? ''),
    role: String(event?.role ?? ''),
    kind: String(event?.kind ?? ''),
    type: String(event?.type ?? 'event'),
    toolName: String(event?.toolName ?? ''),
    isError: event?.isError === true,
    text: truncateText(event?.text ?? '', MAX_LIVE_FEED_TEXT),
  }

  const argsSummary = summarizeValue(event?.args)
  const partialSummary = summarizeValue(event?.partialResult)
  const resultSummary = summarizeValue(event?.result)
  if (argsSummary !== '') {
    normalized.argsSummary = argsSummary
  }
  if (partialSummary !== '') {
    normalized.partialSummary = partialSummary
  }
  if (resultSummary !== '') {
    normalized.resultSummary = resultSummary
  }

  return normalized
}

async function appendLiveFeedEvent(config, event) {
  if (!config.runLiveFeedFile) {
    return
  }

  const filePath = config.runLiveFeedFile
  const previous = liveFeedWriteQueues.get(filePath) ?? Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(async () => {
      const sanitized = sanitizeLiveFeedEvent(filePath, event)
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.appendFile(filePath, `${JSON.stringify(sanitized)}\n`, 'utf8')
    })

  liveFeedWriteQueues.set(filePath, next)
  await next
}

async function runMockTurn({ config, sessionId, sessionFile, prompt, reason }) {
  const nextSessionId = sessionId || `mock-${randomUUID()}`
  const nextSessionFile = sessionFile || `${config.piRuntimeDir}/mock-${nextSessionId}.jsonl`
  const output = [
    `[mock transport] ${config.agentName} session ${nextSessionId}`,
    `reason: ${reason}`,
    '',
    'Prompt preview:',
    prompt,
    '',
    'Mock mode does not edit files. Use default sdk transport for real unattended work.',
  ].join('\n')

  await writeAgentOutputSnapshot(config, `${output}\n`)
  await appendLog(config.logFile, `Mock agent turn completed for session ${nextSessionId}`)
  if (config.streamTerminal) {
    process.stderr.write(`[PI mock] ${reason}\n`)
    process.stderr.write('[PI mock] no live agent output in mock mode\n')
  }

  return {
    sessionId: nextSessionId,
    sessionFile: nextSessionFile,
    status: 'success',
    exitCode: 0,
    timedOut: false,
    durationSeconds: 0,
    output,
    notes: 'Mock transport completed without repo edits.',
    role: '',
    model: '',
    toolCalls: 0,
    toolErrors: 0,
    messageUpdates: 0,
    stopReason: '',
    loopDetected: false,
    loopSignature: '',
    terminalReason: 'mock_completed',
  }
}

async function runSdkTransportTurn({ config, model, sessionId, sessionFile, prompt, iteration, retryCount, reason, phase, role, kind }) {
  await appendLog(
    config.logFile,
    `Starting SDK turn iteration=${iteration} retry=${retryCount} reason=${reason}`
  )

  const startedAt = Date.now()
  let response
  try {
    response = await runSdkTurn({
      sessionId,
      sessionFile,
      prompt,
      cwd: config.cwd,
      taskFile: config.taskFile,
      instructionsFile: config.instructionsFile,
      developerInstructionsFile: config.developerInstructionsFile,
      testerInstructionsFile: config.testerInstructionsFile,
      runtimeDir: config.runRuntimeDir || config.piRuntimeDir,
      piCli: config.piCli,
      model: model ?? config.piModel,
      tools: config.piTools,
      thinking: config.piThinking,
      noExtensions: config.piNoExtensions,
      noSkills: config.piNoSkills,
      noPromptTemplates: config.piNoPromptTemplates,
      noThemes: config.piNoThemes,
      streamTerminal: config.streamTerminal,
      loopRepeatThreshold: config.loopRepeatThreshold,
      samePathRepeatThreshold: config.samePathRepeatThreshold,
      continueAfterSeconds: config.continueAfterSeconds,
      toolContinueAfterSeconds: config.toolContinueAfterSeconds,
      continueMessage: config.continueMessage,
      noEventTimeoutSeconds: config.noEventTimeoutSeconds,
      toolNoEventTimeoutSeconds: config.toolNoEventTimeoutSeconds,
      metadata: {
        iteration,
        retryCount,
        reason,
      },
      phase,
      role,
      kind,
      onLiveEvent: (event) => appendLiveFeedEvent(config, event),
    })
  } catch (error) {
    const notes = error instanceof Error ? error.message : String(error)
    await writeAgentOutputSnapshot(config, `${notes}\n`)
    await appendLog(config.logFile, `SDK turn failed: ${notes}`)
    return {
      sessionId: sessionId || '',
      sessionFile: sessionFile || '',
      status: 'failed',
      exitCode: 1,
      timedOut: false,
      durationSeconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
      output: '',
      notes,
      role: '',
      model: model ?? config.piModel,
      toolCalls: 0,
      toolErrors: 0,
      messageUpdates: 0,
      stopReason: '',
      loopDetected: false,
      loopSignature: '',
      terminalReason: 'sdk_failed',
    }
  }

  await writeAgentOutputSnapshot(config, formatLastAgentOutput(response))
  await appendLog(config.logFile, `SDK turn completed with status ${String(response.status ?? 'success')}`)

  return {
    sessionId: String(response.sessionId ?? sessionId ?? ''),
    sessionFile: String(response.sessionFile ?? sessionFile ?? ''),
    status: String(response.status ?? 'success'),
    exitCode: 0,
    timedOut: String(response.status ?? '') === 'timed_out',
    durationSeconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
    output: String(response.output ?? ''),
    notes: String(response.notes ?? ''),
    role: String(response.role ?? ''),
    model: String(response.model ?? model ?? config.piModel ?? ''),
    toolCalls: Number.isFinite(Number(response.toolCalls)) ? Number(response.toolCalls) : 0,
    toolErrors: Number.isFinite(Number(response.toolErrors)) ? Number(response.toolErrors) : 0,
    messageUpdates: Number.isFinite(Number(response.messageUpdates)) ? Number(response.messageUpdates) : 0,
    stopReason: String(response.stopReason ?? ''),
    loopDetected: response.loopDetected === true,
    loopSignature: String(response.loopSignature ?? ''),
    terminalReason: String(response.terminalReason ?? ''),
  }
}

export async function runAgentTurn(args) {
  if (args.config.transport === 'mock') {
    return await runMockTurn(args)
  }

  if (args.config.transport === 'sdk') {
    return await runSdkTransportTurn(args)
  }

  throw new Error(`Unsupported PI transport "${args.config.transport}". Expected "mock" or "sdk".`)
}
