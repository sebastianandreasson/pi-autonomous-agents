import { randomUUID } from 'node:crypto'
import {
  appendLog,
  runShellCommand,
  writeTextFile,
} from './pi-repo.mjs'

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
    'Mock mode does not edit files. Point PI_TRANSPORT=adapter at a real adapter to enable unattended work.',
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
  }
}

function parseAdapterResponse(stdout) {
  const trimmed = stdout.trim()
  if (trimmed === '') {
    throw new Error('Adapter returned no JSON on stdout.')
  }

  try {
    return JSON.parse(trimmed)
  } catch {
    const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean)
    const lastLine = lines.at(-1)
    if (!lastLine) {
      throw new Error('Adapter returned no parseable JSON on stdout.')
    }
    return JSON.parse(lastLine)
  }
}

async function runAdapterTurn({ config, model, sessionId, sessionFile, prompt, iteration, retryCount, reason }) {
  if (config.adapterCommand.trim() === '') {
    throw new Error('PI_TRANSPORT=adapter requires PI_ADAPTER_COMMAND to be set.')
  }

  const request = {
    sessionId,
    sessionFile,
    prompt,
    cwd: config.cwd,
    taskFile: config.taskFile,
    instructionsFile: config.instructionsFile,
    developerInstructionsFile: config.developerInstructionsFile,
    testerInstructionsFile: config.testerInstructionsFile,
    runtimeDir: config.piRuntimeDir,
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
  }

  await appendLog(
    config.logFile,
    `Starting adapter turn via: ${config.adapterCommand} iteration=${iteration} retry=${retryCount} reason=${reason}`
  )
  const result = await runShellCommand({
    cwd: config.cwd,
    command: config.adapterCommand,
    timeoutSeconds: config.agentTimeoutSeconds,
    stdinText: `${JSON.stringify(request)}\n`,
    streamStderrToParent: config.streamTerminal,
  })

  await writeTextFile(config.lastAgentOutputFile, result.combinedOutput)

  if (result.timedOut) {
    await appendLog(config.logFile, 'Adapter turn timed out')
    return {
      sessionId: sessionId || '',
      sessionFile: sessionFile || '',
      status: 'timed_out',
      exitCode: result.exitCode,
      timedOut: true,
      durationSeconds: result.durationSeconds,
      output: result.combinedOutput,
      notes: 'Adapter process exceeded the configured timeout.',
    }
  }

  if (result.exitCode !== 0) {
    await appendLog(config.logFile, `Adapter turn failed with exit code ${result.exitCode}`)
    await writeTextFile(config.lastAgentOutputFile, result.combinedOutput)
    return {
      sessionId: sessionId || '',
      sessionFile: sessionFile || '',
      status: 'failed',
      exitCode: result.exitCode,
      timedOut: false,
      durationSeconds: result.durationSeconds,
      output: result.combinedOutput,
      notes: truncateForNotes(result.combinedOutput) || 'Adapter exited non-zero.',
    }
  }

  const response = parseAdapterResponse(result.stdout)
  await writeTextFile(config.lastAgentOutputFile, formatLastAgentOutput(response))
  const nextSessionId = String(response.sessionId ?? sessionId ?? '')
  const nextSessionFile = String(response.sessionFile ?? sessionFile ?? '')
  const status = String(response.status ?? 'success')
  const output = String(response.output ?? result.combinedOutput)
  const notes = String(response.notes ?? truncateForNotes(output))

  await appendLog(config.logFile, `Adapter turn completed with status ${status}`)

  return {
    sessionId: nextSessionId,
    sessionFile: nextSessionFile,
    status,
    exitCode: result.exitCode,
    timedOut: false,
    durationSeconds: result.durationSeconds,
    output,
    notes,
  }
}

export async function runAgentTurn(args) {
  if (args.config.transport === 'mock') {
    return await runMockTurn(args)
  }

  if (args.config.transport === 'adapter') {
    return await runAdapterTurn(args)
  }

  throw new Error(`Unsupported PI transport "${args.config.transport}". Expected "mock" or "adapter".`)
}
