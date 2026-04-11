#!/usr/bin/env node

import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import {
  formatHeartbeatReason,
  formatHeartbeatTimeoutMessage,
  getHeartbeatDecision,
  resolveHeartbeatConfig,
} from './pi-heartbeat.mjs'

function createJsonlReader(stream, onLine) {
  const rl = createInterface({ input: stream })
  rl.on('line', onLine)
  return () => rl.close()
}

async function readRequest() {
  const chunks = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk)
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw === '') {
    throw new Error('Expected JSON request on stdin.')
  }

  return JSON.parse(raw)
}

function formatValue(value) {
  const text = JSON.stringify(value)
  if (text === undefined) {
    return ''
  }
  if (text.length <= 160) {
    return text
  }
  return `${text.slice(0, 157)}...`
}

function extractToolTarget(toolName, args) {
  if (!args || typeof args !== 'object') {
    return ''
  }

  if ((toolName === 'read' || toolName === 'write' || toolName === 'edit') && typeof args.path === 'string') {
    return args.path
  }

  return ''
}

function extractAssistantText(message) {
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) {
    return ''
  }

  return message.content
    .filter((item) => item?.type === 'text')
    .map((item) => item.text)
    .join('')
}

function getLastAssistantMessageFromEvents(events) {
  const agentEnd = [...events].reverse().find((event) => event.type === 'agent_end')
  if (!agentEnd || !Array.isArray(agentEnd.messages)) {
    return null
  }

  const messages = [...agentEnd.messages].reverse()
  return messages.find((message) => message?.role === 'assistant') ?? null
}

async function run() {
  const request = await readRequest()
  const runtimeDir = path.resolve(request.runtimeDir ?? path.join(request.cwd, '.pi-runtime'))
  const sessionDir = path.join(runtimeDir, 'sessions')
  const cli = request.piCli || 'pi'
  const args = ['--mode', 'rpc', '--session-dir', sessionDir]

  if (request.sessionFile) {
    args.push('--session', request.sessionFile)
  } else if (request.sessionId) {
    args.push('--continue')
  }

  if (request.model) {
    args.push('--model', request.model)
  }
  if (request.tools) {
    args.push('--tools', request.tools)
  }
  if (request.thinking) {
    args.push('--thinking', request.thinking)
  }
  if (request.noExtensions) {
    args.push('--no-extensions')
  }
  if (request.noSkills) {
    args.push('--no-skills')
  }
  if (request.noPromptTemplates) {
    args.push('--no-prompt-templates')
  }
  if (request.noThemes ?? true) {
    args.push('--no-themes')
  }

  const child = spawn(cli, args, {
    cwd: request.cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let stderr = ''
  const events = []
  const pending = new Map()
  let requestCounter = 0
  const streamTerminal = request.streamTerminal === true
  const loopRepeatThreshold = Number.isFinite(Number(request.loopRepeatThreshold))
    ? Number(request.loopRepeatThreshold)
    : 12
  const samePathRepeatThreshold = Number.isFinite(Number(request.samePathRepeatThreshold))
    ? Number(request.samePathRepeatThreshold)
    : 8
  let assistantLineOpen = false
  let streamedAssistantText = false
  let lastToolSignature = ''
  let repeatedToolCount = 0
  let lastToolTarget = ''
  let repeatedTargetCount = 0
  let loopDetected = false
  let loopSignature = ''
  let abortRequested = false
  const {
    continueAfterSeconds,
    noEventTimeoutSeconds,
    toolContinueAfterSeconds,
    toolNoEventTimeoutSeconds,
  } = resolveHeartbeatConfig(request)
  const continueMessage = typeof request.continueMessage === 'string' && request.continueMessage.trim() !== ''
    ? request.continueMessage.trim()
    : 'continue'
  let agentStarted = false
  let agentEnded = false
  let heartbeatTimedOut = false
  let heartbeatReason = ''
  let lastEventAt = Date.now()
  let activeToolName = ''
  let activeToolStartedAt = 0
  let heartbeatInterval = null
  let continueAttempted = false
  let continueAccepted = false
  let continueRejected = false

  const writeLive = (text) => {
    if (!streamTerminal) {
      return
    }
    process.stderr.write(text)
  }

  const ensureAssistantLine = () => {
    if (!assistantLineOpen) {
      writeLive('[PI assistant] ')
      assistantLineOpen = true
    }
  }

  const closeAssistantLine = () => {
    if (assistantLineOpen) {
      writeLive('\n')
      assistantLineOpen = false
    }
  }

  const requestAbortForLoop = () => {
    if (abortRequested) {
      return
    }

    abortRequested = true
    closeAssistantLine()
    writeLive(`[PI guard] repeated tool loop detected: ${loopSignature} x${repeatedToolCount}. Aborting current turn.\n`)
    void send({ type: 'abort' }).catch(() => {})
  }

  const requestAbortForHeartbeat = (decision) => {
    if (abortRequested) {
      return
    }

    abortRequested = true
    heartbeatTimedOut = true
    heartbeatReason = formatHeartbeatReason(decision)
    closeAssistantLine()
    writeLive(`[PI guard] ${formatHeartbeatTimeoutMessage(decision)} Aborting current turn (pid=${child.pid ?? 'unknown'}).\n`)
    void send({ type: 'abort' }).catch(() => {})
    child.kill('SIGTERM')
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL')
      }
    }, 1000)
  }

  const requestSoftContinue = (decision) => {
    if (abortRequested || continueAttempted || agentEnded) {
      return
    }

    continueAttempted = true
    closeAssistantLine()
    const context = decision.activeToolName
      ? ` while tool "${decision.activeToolName}" is running`
      : ''
    writeLive(`[PI guard] no PI events for ${decision.continueAfterSeconds}s${context}. Sending soft continue prompt.\n`)
    void send({ type: 'prompt', message: continueMessage })
      .then((response) => {
        if (response?.success) {
          continueAccepted = true
          writeLive('[PI guard] soft continue accepted by PI.\n')
        } else {
          continueRejected = true
          writeLive(`[PI guard] soft continue rejected: ${String(response?.error ?? 'unknown error')}\n`)
        }
      })
      .catch((error) => {
        continueRejected = true
        writeLive(`[PI guard] soft continue failed: ${error instanceof Error ? error.message : String(error)}\n`)
      })
  }

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })

  const stopReading = createJsonlReader(child.stdout, (line) => {
    if (line.trim() === '') {
      return
    }

    let data
    try {
      data = JSON.parse(line)
    } catch {
      return
    }

    lastEventAt = Date.now()

    if (data.type === 'response' && typeof data.id === 'string' && pending.has(data.id)) {
      const current = pending.get(data.id)
      pending.delete(data.id)
      current.resolve(data)
      return
    }

    events.push(data)

    if (data.type === 'agent_start') {
      agentStarted = true
      writeLive('[PI] agent started\n')
    }

    if (data.type === 'message_update' && data.message?.role === 'assistant') {
      const assistantEvent = data.assistantMessageEvent
      if (assistantEvent?.type === 'text_delta') {
        ensureAssistantLine()
        writeLive(assistantEvent.delta)
        streamedAssistantText = true
      }
    }

    if (data.type === 'message_end' && data.message?.role === 'assistant') {
      const text = extractAssistantText(data.message)
      if (assistantLineOpen) {
        closeAssistantLine()
      } else if (!streamedAssistantText && text.trim() !== '') {
        writeLive(`[PI assistant] ${text}\n`)
      }
      streamedAssistantText = false
    }

    if (data.type === 'tool_execution_start') {
      closeAssistantLine()
      const argsText = formatValue(data.args)
      const suffix = argsText === '' ? '' : ` ${argsText}`
      const signature = `${data.toolName}${suffix}`
      activeToolName = String(data.toolName ?? '')
      activeToolStartedAt = Date.now()
      const target = extractToolTarget(data.toolName, data.args)
      if (signature === lastToolSignature) {
        repeatedToolCount += 1
      } else {
        lastToolSignature = signature
        repeatedToolCount = 1
      }

      if (target !== '' && target === lastToolTarget) {
        repeatedTargetCount += 1
      } else if (target !== '') {
        lastToolTarget = target
        repeatedTargetCount = 1
      } else {
        lastToolTarget = ''
        repeatedTargetCount = 0
      }

      if (!loopDetected && repeatedToolCount >= loopRepeatThreshold) {
        loopDetected = true
        loopSignature = signature
        requestAbortForLoop()
      }

      if (!loopDetected && target !== '' && repeatedTargetCount >= samePathRepeatThreshold) {
        loopDetected = true
        loopSignature = `same_path:${target}`
        requestAbortForLoop()
      }

      writeLive(`[PI tool:start] ${data.toolName}${suffix}\n`)
    }

    if (data.type === 'tool_execution_end') {
      closeAssistantLine()
      activeToolName = ''
      activeToolStartedAt = 0
      writeLive(`[PI tool:end] ${data.toolName} ${data.isError ? 'error' : 'ok'}\n`)
    }

    if (data.type === 'agent_end') {
      agentEnded = true
      closeAssistantLine()
      writeLive('[PI] agent finished\n')
    }

    if (data.type === 'extension_ui_request') {
      closeAssistantLine()
      writeLive(`[PI ui] ${data.method} requested and auto-cancelled in headless mode\n`)
      child.stdin.write(`${JSON.stringify({
        type: 'extension_ui_response',
        id: data.id,
        cancelled: true,
      })}\n`)
    }
  })

  const send = (command) => new Promise((resolve, reject) => {
    requestCounter += 1
    const id = `adapter_${requestCounter}`
    pending.set(id, { resolve, reject })
    child.stdin.write(`${JSON.stringify({ ...command, id })}\n`)
  })

  const waitForAgentEnd = () => new Promise((resolve) => {
    const interval = setInterval(() => {
      if (events.some((event) => event.type === 'agent_end') || child.exitCode !== null || heartbeatTimedOut) {
        clearInterval(interval)
        resolve()
      }
    }, 50)
  })

  heartbeatInterval = setInterval(() => {
    const decision = getHeartbeatDecision({
      now: Date.now(),
      agentStarted,
      agentEnded,
      heartbeatTimedOut,
      childExited: child.exitCode !== null,
      lastEventAt,
      continueAttempted,
      activeToolName,
      activeToolStartedAt,
      continueAfterSeconds,
      noEventTimeoutSeconds,
      toolContinueAfterSeconds,
      toolNoEventTimeoutSeconds,
    })

    if (decision.action === 'soft_continue') {
      requestSoftContinue(decision)
      return
    }

    if (decision.action === 'abort') {
      requestAbortForHeartbeat(decision)
    }
  }, 1000)

  try {
    const initialState = await send({ type: 'get_state' })
    if (!initialState.success) {
      throw new Error(initialState.error)
    }

    if (!request.model && !initialState.data.model) {
      throw new Error('No PI model configured. Set PI_MODEL or configure a default model in PI.')
    }

    await send({ type: 'set_auto_retry', enabled: false })

    const promptResponse = await send({
      type: 'prompt',
      message: request.prompt,
    })
    if (!promptResponse.success) {
      throw new Error(promptResponse.error)
    }

    await waitForAgentEnd()

    if (heartbeatTimedOut) {
      console.log(JSON.stringify({
        sessionId: request.sessionId ?? '',
        sessionFile: request.sessionFile ?? '',
        status: 'timed_out',
        output: [
          '[heartbeat_timeout]',
          formatHeartbeatTimeoutMessage({
            noEventTimeoutSeconds,
            activeToolName,
            toolRuntimeSeconds: activeToolStartedAt > 0
              ? Math.max(0, Math.floor((Date.now() - activeToolStartedAt) / 1000))
              : 0,
          }),
          stderr.trim() !== '' ? `\n[stderr]\n${stderr.trim()}` : '',
        ].join('\n').trim(),
        notes: [
          `pi_pid=${child.pid ?? 'unknown'}`,
          heartbeatReason,
          continueAttempted ? `continue_attempted=${continueMessage}` : '',
          continueAccepted ? 'continue_accepted=true' : '',
          continueRejected ? 'continue_rejected=true' : '',
        ].join(' '),
      }))
      return
    }

    const state = await send({ type: 'get_state' })
    if (!state.success) {
      throw new Error(state.error)
    }

    const lastAssistant = await send({ type: 'get_last_assistant_text' })
    if (!lastAssistant.success) {
      throw new Error(lastAssistant.error)
    }

    const toolCalls = events.filter((event) => event.type === 'tool_execution_start').length
    const toolErrors = events.filter((event) => event.type === 'tool_execution_end' && event.isError).length
    const messageUpdates = events.filter((event) => event.type === 'message_update').length
    const lastAssistantMessage = getLastAssistantMessageFromEvents(events)
    const assistantText = String(lastAssistant.data.text ?? '').trim()
    const assistantError = String(lastAssistantMessage?.errorMessage ?? '').trim()
    const assistantStopReason = String(lastAssistantMessage?.stopReason ?? '').trim()
    const status = loopDetected
      ? 'stalled'
      : assistantError !== '' || (assistantText === '' && toolCalls === 0 && messageUpdates === 0)
        ? 'failed'
        : 'success'
    const notes = [
      `PI session ${state.data.sessionId}`,
      `pi_pid=${child.pid ?? 'unknown'}`,
      `tool_calls=${toolCalls}`,
      `tool_errors=${toolErrors}`,
      `message_updates=${messageUpdates}`,
      activeToolName !== '' ? `active_tool=${activeToolName}` : '',
      continueAttempted ? `continue_attempted=${continueMessage}` : '',
      continueAccepted ? 'continue_accepted=true' : '',
      continueRejected ? 'continue_rejected=true' : '',
      loopDetected ? `loop_detected=${loopSignature}` : '',
      loopDetected ? `loop_repeats=${repeatedToolCount}` : '',
      assistantStopReason !== '' ? `stop_reason=${assistantStopReason}` : '',
      assistantError !== '' ? `assistant_error=${assistantError}` : '',
      status === 'failed' && assistantError === '' ? 'empty_agent_turn' : '',
    ].join(' ')

    const output = [
      assistantText,
      loopDetected ? `\n[loop_guard]\nRepeated tool loop detected: ${loopSignature} x${repeatedToolCount}` : '',
      assistantError !== '' ? `\n[assistant_error]\n${assistantError}` : '',
      stderr.trim() !== '' ? `\n[stderr]\n${stderr.trim()}` : '',
    ].join('').trim()

    console.log(JSON.stringify({
      sessionId: state.data.sessionId,
      sessionFile: state.data.sessionFile ?? '',
      status,
      output,
      notes,
    }))
  } finally {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval)
    }
    stopReading()
    for (const current of pending.values()) {
      current.reject(new Error('RPC adapter shutting down'))
    }
    pending.clear()

    child.kill('SIGTERM')
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 1000)

      child.on('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }
}

run().catch((error) => {
  console.log(JSON.stringify({
    sessionId: '',
    sessionFile: '',
    status: 'failed',
    output: '',
    notes: error instanceof Error ? error.message : String(error),
  }))
})
