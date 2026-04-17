import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  formatHeartbeatReason,
  formatHeartbeatTimeoutMessage,
  getHeartbeatDecision,
  resolveHeartbeatConfig,
} from './pi-heartbeat.mjs'
import {
  createEmptyTokenUsage,
  formatTokenUsageSummary,
  normalizeStringList,
  normalizeTokenUsage,
} from './pi-token-analysis.mjs'
import {
  REQUEST_TELEMETRY_ENV_KEYS,
  ensureBundledRequestTelemetryExtension,
  readRequestTelemetryContextFromEnv,
} from './pi-request-telemetry.mjs'

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'])

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

function extractShellCommand(args) {
  if (!args || typeof args !== 'object') {
    return ''
  }

  if (typeof args.command === 'string') {
    return args.command
  }

  if (typeof args.cmd === 'string') {
    return args.cmd
  }

  return ''
}

function isLargeShellRead(command) {
  const text = String(command ?? '').trim()
  if (text === '') {
    return false
  }

  if (/^\s*cat\s+\S+/.test(text)) {
    return true
  }

  const sedMatch = text.match(/sed\s+-n\s+['"]?(\d+)\s*,\s*(\d+)p['"]?/) 
  if (sedMatch) {
    const start = Number.parseInt(sedMatch[1], 10)
    const end = Number.parseInt(sedMatch[2], 10)
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      return (end - start) >= 120
    }
  }

  return false
}

function extractAssistantText(message) {
  if (!message || message.role !== 'assistant') {
    return ''
  }

  if (typeof message.content === 'string') {
    return message.content
  }

  if (!Array.isArray(message.content)) {
    return ''
  }

  return message.content
    .filter((item) => item?.type === 'text')
    .map((item) => item.text)
    .join('')
}

function getLastAssistantMessage(messages) {
  if (!Array.isArray(messages)) {
    return null
  }

  const reversed = [...messages].reverse()
  return reversed.find((message) => message?.role === 'assistant') ?? null
}

function addTokenUsage(total, value) {
  const next = normalizeTokenUsage(value)
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    totalTokens: total.totalTokens + next.totalTokens,
    cacheReadTokens: total.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + next.cacheWriteTokens,
  }
}

function applyRequestTelemetryEnv(request) {
  const previous = readRequestTelemetryContextFromEnv()
  const nextValues = {
    [REQUEST_TELEMETRY_ENV_KEYS.runId]: String(process.env.PI_RUN_ID ?? '').trim(),
    [REQUEST_TELEMETRY_ENV_KEYS.iteration]: Number.isFinite(Number(request?.metadata?.iteration))
      ? String(Number(request.metadata.iteration))
      : '',
    [REQUEST_TELEMETRY_ENV_KEYS.phase]: String(request?.phase ?? '').trim(),
    [REQUEST_TELEMETRY_ENV_KEYS.role]: String(request?.role ?? '').trim(),
    [REQUEST_TELEMETRY_ENV_KEYS.kind]: String(request?.kind ?? '').trim(),
    [REQUEST_TELEMETRY_ENV_KEYS.task]: String(request?.task ?? '').trim(),
  }

  for (const [key, value] of Object.entries(nextValues)) {
    if (value === '') {
      delete process.env[key]
      continue
    }
    process.env[key] = value
  }

  return () => {
    for (const [field, key] of Object.entries(REQUEST_TELEMETRY_ENV_KEYS)) {
      const previousValue = String(previous?.[field] ?? '').trim()
      if (previousValue === '') {
        delete process.env[key]
        continue
      }
      process.env[key] = previousValue
    }
  }
}

function deriveTokenAttributionKind({ activeToolName, pendingToolNames, pendingFiles, lastAssistantActivity }) {
  if (String(activeToolName ?? '').trim() !== '') {
    return 'tool_running'
  }
  if (pendingToolNames.size > 0 || pendingFiles.size > 0) {
    return 'tool_context'
  }
  if (lastAssistantActivity === 'thinking') {
    return 'thinking'
  }
  if (lastAssistantActivity === 'response') {
    return 'response'
  }
  return 'agent'
}

function emitTokenUsageAttribution({
  request,
  sessionId,
  model,
  tokenUsage,
  activeToolName,
  pendingToolNames,
  pendingFiles,
  lastAssistantActivity,
  includeContext = true,
  forcedAttributionKind = '',
}) {
  const usage = normalizeTokenUsage(tokenUsage)
  if (usage.totalTokens <= 0 && usage.inputTokens <= 0 && usage.outputTokens <= 0) {
    return
  }

  const toolNames = includeContext ? normalizeStringList([...pendingToolNames]) : []
  const files = includeContext ? normalizeStringList([...pendingFiles]) : []
  const attributionKind = forcedAttributionKind || deriveTokenAttributionKind({
    activeToolName: includeContext ? activeToolName : '',
    pendingToolNames: includeContext ? pendingToolNames : new Set(),
    pendingFiles: includeContext ? pendingFiles : new Set(),
    lastAssistantActivity,
  })

  emitLiveFeed(request, {
    type: 'token_usage',
    text: [
      formatTokenUsageSummary(usage),
      attributionKind !== 'agent' ? `attribution=${attributionKind}` : '',
      files.length > 0 ? `files=${files.slice(0, 3).join(',')}${files.length > 3 ? ',…' : ''}` : '',
    ].filter(Boolean).join(' '),
    ...usage,
    attributionKind,
    toolNames,
    files,
    primaryFile: files[0] ?? '',
    sessionId: String(sessionId ?? ''),
    model: String(model ?? ''),
  })
}

export function splitModelSpec(modelSpec) {
  const raw = String(modelSpec ?? '').trim()
  if (raw === '') {
    return {
      modelName: '',
      thinkingLevel: '',
    }
  }

  const lastColonIndex = raw.lastIndexOf(':')
  if (lastColonIndex === -1) {
    return {
      modelName: raw,
      thinkingLevel: '',
    }
  }

  const maybeThinking = raw.slice(lastColonIndex + 1).trim().toLowerCase()
  if (!THINKING_LEVELS.has(maybeThinking)) {
    return {
      modelName: raw,
      thinkingLevel: '',
    }
  }

  return {
    modelName: raw.slice(0, lastColonIndex).trim(),
    thinkingLevel: maybeThinking,
  }
}

export function normalizeToolNames(tools) {
  if (typeof tools !== 'string') {
    return []
  }

  return [...new Set(
    tools
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  )]
}

async function loadPiSdk() {
  const overrideModule = String(process.env.PI_SDK_MODULE ?? '').trim()
  if (overrideModule !== '') {
    try {
      const specifier = path.isAbsolute(overrideModule)
        ? pathToFileURL(overrideModule).href
        : overrideModule
      return await import(specifier)
    } catch (error) {
      throw new Error(
        `Failed to load PI SDK override module "${overrideModule}". `
        + `Original error: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  try {
    return await import('@mariozechner/pi-coding-agent')
  } catch (error) {
    throw new Error(
      'SDK transport requires @mariozechner/pi-coding-agent to be installed in this package. '
      + `Original error: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function resolveAgentDir(pi) {
  if (process.env.PI_CODING_AGENT_DIR) {
    return path.resolve(process.env.PI_CODING_AGENT_DIR)
  }
  return pi.getAgentDir()
}

function createSessionManager(pi, request, sessionDir) {
  if (request.sessionFile) {
    return pi.SessionManager.open(request.sessionFile, sessionDir)
  }

  if (request.sessionId) {
    return pi.SessionManager.continueRecent(request.cwd, sessionDir)
  }

  return pi.SessionManager.create(request.cwd, sessionDir)
}

export function createTools(pi, cwd, tools) {
  const names = normalizeToolNames(tools)
  if (names.length === 0) {
    return undefined
  }

  const factories = {
    read: pi.createReadTool,
    bash: pi.createBashTool,
    edit: pi.createEditTool,
    write: pi.createWriteTool,
    grep: pi.createGrepTool,
    find: pi.createFindTool,
    ls: pi.createLsTool,
  }

  return names.map((name) => {
    const factory = factories[name]
    if (!factory) {
      throw new Error(`Unsupported PI tool "${name}" in SDK transport.`)
    }
    return factory(cwd)
  })
}

export async function resolveModel(modelRegistry, requestedModel) {
  const raw = String(requestedModel ?? '').trim()
  if (raw === '') {
    return undefined
  }

  const { modelName } = splitModelSpec(raw)
  if (modelName === '') {
    return undefined
  }

  const slashIndex = modelName.indexOf('/')
  if (slashIndex !== -1) {
    const provider = modelName.slice(0, slashIndex).trim()
    const id = modelName.slice(slashIndex + 1).trim()
    const resolved = modelRegistry.find(provider, id)
    if (!resolved) {
      throw new Error(`Configured PI model "${raw}" could not be resolved via SDK model registry.`)
    }
    return resolved
  }

  const matches = modelRegistry.getAll().filter((model) => {
    if (!model || typeof model !== 'object') {
      return false
    }

    return model.id === modelName
      || model.name === modelName
      || `${model.provider}/${model.id}` === modelName
  })

  if (matches.length === 1) {
    return matches[0]
  }

  if (matches.length > 1) {
    const candidates = matches.map((model) => `${model.provider}/${model.id}`).join(', ')
    throw new Error(`Configured PI model "${raw}" is ambiguous in SDK model registry. Candidates: ${candidates}`)
  }

  throw new Error(`Configured PI model "${raw}" could not be resolved via SDK model registry.`)
}

export async function createSdkSession(pi, request) {
  const sessionDir = path.join(path.resolve(request.runtimeDir ?? path.join(request.cwd, '.pi-runtime')), 'sessions')
  const agentDir = resolveAgentDir(pi)
  const authStorage = pi.AuthStorage.create(path.join(agentDir, 'auth.json'))
  const modelRegistry = pi.ModelRegistry.create(authStorage, path.join(agentDir, 'models.json'))
  const settingsManager = pi.SettingsManager.create(request.cwd, agentDir)
  settingsManager.applyOverrides({
    retry: {
      enabled: false,
    },
  })

  const { thinkingLevel: modelSpecThinking } = splitModelSpec(request.model)
  const thinkingLevel = String(request.thinking || modelSpecThinking || '').trim()
  await ensureBundledRequestTelemetryExtension({
    cwd: request.cwd,
    enabled: request.noExtensions !== true && request.requestTelemetryEnabled !== false,
  })
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: request.cwd,
    agentDir,
    settingsManager,
    noExtensions: request.noExtensions === true,
    noSkills: request.noSkills === true,
    noPromptTemplates: request.noPromptTemplates === true,
    noThemes: request.noThemes !== false,
  })
  await resourceLoader.reload()

  const model = await resolveModel(modelRegistry, request.model)
  const tools = createTools(pi, request.cwd, request.tools)
  const sessionManager = createSessionManager(pi, request, sessionDir)

  return pi.createAgentSession({
    cwd: request.cwd,
    agentDir,
    authStorage,
    modelRegistry,
    resourceLoader,
    sessionManager,
    settingsManager,
    ...(model ? { model } : {}),
    ...(thinkingLevel !== '' ? { thinkingLevel } : {}),
    ...(tools ? { tools } : {}),
  })
}

function emitLiveFeed(request, event) {
  if (typeof request?.onLiveEvent !== 'function') {
    return
  }
  request.onLiveEvent({
    timestamp: new Date().toISOString(),
    iteration: Number(request?.metadata?.iteration ?? 0),
    retryCount: Number(request?.metadata?.retryCount ?? 0),
    reason: String(request?.metadata?.reason ?? request?.reason ?? ''),
    phase: String(request?.phase ?? ''),
    role: String(request?.role ?? ''),
    kind: String(request?.kind ?? ''),
    ...event,
  })
}

async function safeAbort(session) {
  try {
    await session.abort()
  } catch {}
}

export async function runSdkTurnWithPi(pi, request) {
  const restoreRequestTelemetryEnv = applyRequestTelemetryEnv(request)
  const streamTerminal = request.streamTerminal === true
  const requestedModel = typeof request.model === 'string' ? request.model : ''
  const loopRepeatThreshold = Number.isFinite(Number(request.loopRepeatThreshold))
    ? Number(request.loopRepeatThreshold)
    : 12
  const samePathRepeatThreshold = Number.isFinite(Number(request.samePathRepeatThreshold))
    ? Number(request.samePathRepeatThreshold)
    : 8
  const {
    continueAfterSeconds,
    noEventTimeoutSeconds,
    toolContinueAfterSeconds,
    toolNoEventTimeoutSeconds,
  } = resolveHeartbeatConfig(request)
  const continueMessage = typeof request.continueMessage === 'string' && request.continueMessage.trim() !== ''
    ? request.continueMessage.trim()
    : 'continue'

  let unsubscribe = () => {}
  let assistantLineOpen = false
  let streamedAssistantText = false
  let lastToolSignature = ''
  let repeatedToolCount = 0
  let lastToolTarget = ''
  let repeatedTargetCount = 0
  let loopDetected = false
  let loopSignature = ''
  let abortRequested = false
  let heartbeatTimedOut = false
  let heartbeatReason = ''
  let heartbeatInterval = null
  let continueAttempted = false
  let continueAccepted = false
  let continueRejected = false
  let agentStarted = false
  let agentEnded = false
  let activeToolName = ''
  let activeToolStartedAt = 0
  let lastEventAt = Date.now()
  let tokenUsageEvents = 0
  let tokenUsage = createEmptyTokenUsage()
  let lastAssistantActivity = ''
  const pendingToolNames = new Set()
  const pendingFiles = new Set()
  const events = []

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

  let session
  try {
    const created = await createSdkSession(pi, request)
    session = created.session

    if (!request.model && !session.model) {
      throw new Error('No PI model configured. Set PI_MODEL or configure a default model in PI.')
    }

    const requestAbortForLoop = () => {
      if (abortRequested) {
        return
      }

      abortRequested = true
      closeAssistantLine()
      writeLive(`[PI guard] repeated tool loop detected: ${loopSignature} x${repeatedToolCount}. Aborting current turn.\n`)
      void safeAbort(session)
    }

    const requestAbortForHeartbeat = (decision) => {
      if (abortRequested) {
        return
      }

      abortRequested = true
      heartbeatTimedOut = true
      heartbeatReason = formatHeartbeatReason(decision)
      closeAssistantLine()
      writeLive(`[PI guard] ${formatHeartbeatTimeoutMessage(decision)} Aborting current turn.\n`)
      void safeAbort(session)
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
      void session.steer(continueMessage)
        .then(() => {
          continueAccepted = true
          writeLive('[PI guard] soft continue accepted by PI.\n')
        })
        .catch((error) => {
          continueRejected = true
          writeLive(`[PI guard] soft continue failed: ${error instanceof Error ? error.message : String(error)}\n`)
        })
    }

    unsubscribe = session.subscribe((event) => {
      events.push(event)
      lastEventAt = Date.now()

      if (event.type === 'agent_start') {
        agentStarted = true
        emitLiveFeed(request, {
          type: 'agent_start',
          text: 'agent started',
        })
        writeLive('[PI] agent started\n')
      }

      if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'thinking_delta') {
        lastAssistantActivity = 'thinking'
        emitLiveFeed(request, {
          type: 'thinking_delta',
          text: event.assistantMessageEvent.delta,
        })
      }

      if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
        lastAssistantActivity = 'response'
        emitLiveFeed(request, {
          type: 'text_delta',
          text: event.assistantMessageEvent.delta,
        })
        ensureAssistantLine()
        writeLive(event.assistantMessageEvent.delta)
        streamedAssistantText = true
      }

      if (event.type === 'message_end' && event.message?.role === 'assistant') {
        const text = extractAssistantText(event.message)
        if (assistantLineOpen) {
          closeAssistantLine()
        } else if (!streamedAssistantText && text.trim() !== '') {
          writeLive(`[PI assistant] ${text}\n`)
        }
        streamedAssistantText = false
      }

      if (event.type === 'token_usage') {
        tokenUsageEvents += 1
        tokenUsage = addTokenUsage(tokenUsage, event)
        emitTokenUsageAttribution({
          request,
          sessionId: session?.sessionId ?? '',
          model: requestedModel,
          tokenUsage: event,
          activeToolName,
          pendingToolNames,
          pendingFiles,
          lastAssistantActivity,
        })
        pendingToolNames.clear()
        pendingFiles.clear()
      }

      if (event.type === 'tool_execution_start') {
        closeAssistantLine()
        const argsText = formatValue(event.args)
        const suffix = argsText === '' ? '' : ` ${argsText}`
        const signature = `${event.toolName}${suffix}`
        activeToolName = String(event.toolName ?? '')
        activeToolStartedAt = Date.now()
        const target = extractToolTarget(event.toolName, event.args)
        const shellCommand = event.toolName === 'bash' ? extractShellCommand(event.args) : ''
        if (activeToolName !== '') {
          pendingToolNames.add(activeToolName)
        }
        if (target !== '') {
          pendingFiles.add(target)
        }

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

        emitLiveFeed(request, {
          type: 'tool_start',
          toolName: String(event.toolName ?? ''),
          args: event.args,
          text: `${String(event.toolName ?? '')}${suffix}`.trim(),
        })
        writeLive(`[PI tool:start] ${event.toolName}${suffix}\n`)
        if (event.toolName === 'bash' && isLargeShellRead(shellCommand)) {
          writeLive('[PI warning] large bash file read detected; prefer read or a smaller exact window to avoid truncated context.\n')
        }
      }

      if (event.type === 'tool_execution_update') {
        emitLiveFeed(request, {
          type: 'tool_update',
          toolName: String(event.toolName ?? ''),
          partialResult: event.partialResult,
          text: formatValue(event.partialResult),
        })
      }

      if (event.type === 'tool_execution_end') {
        closeAssistantLine()
        if (activeToolName !== '') {
          pendingToolNames.add(activeToolName)
        }
        activeToolName = ''
        activeToolStartedAt = 0
        emitLiveFeed(request, {
          type: 'tool_end',
          toolName: String(event.toolName ?? ''),
          isError: event.isError === true,
          result: event.result,
          text: `${String(event.toolName ?? '')} ${event.isError ? 'error' : 'ok'}`,
        })
        writeLive(`[PI tool:end] ${event.toolName} ${event.isError ? 'error' : 'ok'}\n`)
      }

      if (event.type === 'agent_end') {
        agentEnded = true
        emitLiveFeed(request, {
          type: 'agent_end',
          text: 'agent finished',
        })
        closeAssistantLine()
        writeLive('[PI] agent finished\n')
      }
    })

    heartbeatInterval = setInterval(() => {
      const decision = getHeartbeatDecision({
        now: Date.now(),
        agentStarted,
        agentEnded,
        heartbeatTimedOut,
        childExited: false,
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
      await session.prompt(request.prompt)
    } catch (error) {
      if (!heartbeatTimedOut && !loopDetected) {
        throw error
      }
    }

    if (heartbeatTimedOut) {
      const toolCalls = events.filter((event) => event.type === 'tool_execution_start').length
      const toolErrors = events.filter((event) => event.type === 'tool_execution_end' && event.isError).length
      const messageUpdates = events.filter((event) => event.type === 'message_update').length
      const tokenSummary = formatTokenUsageSummary(tokenUsage)
      return {
        sessionId: session.sessionId ?? request.sessionId ?? '',
        sessionFile: session.sessionFile ?? request.sessionFile ?? '',
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
        ].join('\n').trim(),
        notes: [
          heartbeatReason,
          tokenSummary,
          continueAttempted ? `continue_attempted=${continueMessage}` : '',
          continueAccepted ? 'continue_accepted=true' : '',
          continueRejected ? 'continue_rejected=true' : '',
        ].join(' '),
        role: '',
        model: requestedModel,
        toolCalls,
        toolErrors,
        messageUpdates,
        ...tokenUsage,
        stopReason: '',
        loopDetected: false,
        loopSignature: '',
        terminalReason: 'heartbeat_timeout',
      }
    }

    const toolCalls = events.filter((event) => event.type === 'tool_execution_start').length
    const toolErrors = events.filter((event) => event.type === 'tool_execution_end' && event.isError).length
    const messageUpdates = events.filter((event) => event.type === 'message_update').length
    const lastAssistantMessage = getLastAssistantMessage(session.messages)
    if (tokenUsageEvents === 0) {
      const fallbackUsage = normalizeTokenUsage(lastAssistantMessage?.usage)
      tokenUsage = addTokenUsage(tokenUsage, fallbackUsage)
      emitTokenUsageAttribution({
        request,
        sessionId: session?.sessionId ?? '',
        model: requestedModel,
        tokenUsage: fallbackUsage,
        activeToolName,
        pendingToolNames,
        pendingFiles,
        lastAssistantActivity,
        includeContext: false,
        forcedAttributionKind: 'turn_fallback',
      })
      pendingToolNames.clear()
      pendingFiles.clear()
    }
    const assistantText = extractAssistantText(lastAssistantMessage).trim()
    const assistantError = String(lastAssistantMessage?.errorMessage ?? '').trim()
    const assistantStopReason = String(lastAssistantMessage?.stopReason ?? '').trim()
    const tokenSummary = formatTokenUsageSummary(tokenUsage)
    const status = loopDetected
      ? 'stalled'
      : assistantError !== '' || (assistantText === '' && toolCalls === 0 && messageUpdates === 0)
        ? 'failed'
        : 'success'
    const terminalReason = loopDetected
      ? 'loop_detected'
      : assistantError !== ''
        ? 'assistant_error'
        : assistantStopReason === 'length'
          ? 'assistant_stop_length'
          : status === 'failed'
            ? 'empty_agent_turn'
            : 'agent_completed'
    const notes = [
      `PI session ${session.sessionId}`,
      `tool_calls=${toolCalls}`,
      `tool_errors=${toolErrors}`,
      `message_updates=${messageUpdates}`,
      tokenSummary,
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
    ].join('').trim()

    return {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile ?? '',
      status,
      output,
      notes,
      role: '',
      model: requestedModel,
      toolCalls,
      toolErrors,
      messageUpdates,
      ...tokenUsage,
      stopReason: assistantStopReason,
      loopDetected,
      loopSignature,
      terminalReason,
    }
  } finally {
    restoreRequestTelemetryEnv()
    unsubscribe()
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval)
    }
    if (session) {
      session.dispose()
    }
  }
}

export async function runSdkTurn(request) {
  const pi = await loadPiSdk()
  return await runSdkTurnWithPi(pi, request)
}
