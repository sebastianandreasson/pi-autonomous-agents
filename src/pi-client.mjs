import { randomUUID } from 'node:crypto'
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

  await writeTextFile(config.lastAgentOutputFile, `${output}\n`)
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

async function runSdkTransportTurn({ config, model, sessionId, sessionFile, prompt, iteration, retryCount, reason }) {
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
    })
  } catch (error) {
    const notes = error instanceof Error ? error.message : String(error)
    await writeTextFile(config.lastAgentOutputFile, `${notes}\n`)
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

  await writeTextFile(config.lastAgentOutputFile, formatLastAgentOutput(response))
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
