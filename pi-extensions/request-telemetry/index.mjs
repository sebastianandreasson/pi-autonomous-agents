import { randomUUID } from 'node:crypto'
import process from 'node:process'
import {
  appendRequestTelemetryHook,
  appendRequestTelemetryArtifacts,
  collectMessageSpans,
  collectProviderPayloadSpans,
  collectToolHookSpans,
  deriveToolPaths,
  extractMessagesFromProviderPayload,
  extractUsageFromMessage,
  getRequestTelemetryPaths,
  readRequestTelemetryContextFromEnv,
  readRequestTelemetryStorageOptionsFromEnv,
  summarizeProviderPayload,
  summarizeRequestSpans,
} from '../../src/pi-request-telemetry.mjs'

function toModelName(value) {
  if (typeof value === 'string') {
    return value
  }
  if (!value || typeof value !== 'object') {
    return ''
  }
  return String(value.id ?? value.name ?? value.model ?? '').trim()
}

function sanitizeHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  const entries = Object.entries(value)
    .filter(([key, headerValue]) => String(key).trim() !== '' && typeof headerValue === 'string')
    .slice(0, 64)

  return Object.fromEntries(entries)
}

function usageAvailable(usage) {
  return usage.totalTokens > 0 || usage.inputTokens > 0 || usage.outputTokens > 0
}

function createTurnState({ turnIndex = 0, startedAt = '', model = '' } = {}) {
  return {
    turnIndex,
    startedAt,
    model,
    contextMessages: [],
    contextMessageCount: 0,
    contextSpanCount: 0,
    lastAssistantMessage: null,
    recentToolEvents: [],
  }
}

function createRequestState({ sessionId, turnIndex = 0, startedAt, model = '', metadata = {} } = {}) {
  return {
    requestId: randomUUID(),
    sessionId,
    runId: String(metadata?.runId ?? '').trim(),
    iteration: Number(metadata?.iteration ?? 0) || 0,
    phase: String(metadata?.phase ?? '').trim(),
    role: String(metadata?.role ?? '').trim(),
    kind: String(metadata?.kind ?? '').trim(),
    task: String(metadata?.task ?? '').trim(),
    turnIndex,
    startedAt,
    finishedAt: '',
    durationMs: 0,
    model,
    provider: '',
    api: '',
    stopReason: '',
    usageSource: 'unavailable',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    statusCode: 0,
    responseHeaders: {},
    providerPayloadSummary: {},
    contextMessages: [],
    spans: [],
    spanSource: '',
    contextMessageCount: 0,
    spanCount: 0,
    textChars: 0,
    textBytes: 0,
    toolNames: new Set(),
    files: new Set(),
  }
}

function applySpanSnapshot(requestState, { messages = [], spans = [], source = '' } = {}) {
  if (!Array.isArray(spans) || spans.length === 0) {
    return
  }

  requestState.contextMessages = Array.isArray(messages) ? messages : []
  requestState.spans = spans
  requestState.spanSource = source
}

function mergeSpanSummary(requestState) {
  const summary = summarizeRequestSpans(requestState.spans)
  requestState.contextMessageCount = requestState.contextMessages.length
  requestState.spanCount = summary.spanCount
  requestState.textChars = summary.textChars
  requestState.textBytes = summary.textBytes

  for (const toolName of summary.toolNames) {
    requestState.toolNames.add(toolName)
  }
  for (const file of summary.files) {
    requestState.files.add(file)
  }
}

function getSpanSignal(requestState) {
  const spans = Array.isArray(requestState?.spans) ? requestState.spans : []
  let toolSpanCount = 0

  for (const span of spans) {
    const kind = String(span?.spanKind ?? '').trim()
    if (kind === 'tool_call' || kind === 'tool_result') {
      toolSpanCount += 1
    }
  }

  return {
    spanCount: spans.length,
    toolSpanCount,
    toolNameCount: requestState?.toolNames?.size ?? 0,
    fileCount: requestState?.files?.size ?? 0,
  }
}

function shouldPreferSnapshot(currentState, candidateState) {
  const current = getSpanSignal(currentState)
  const candidate = getSpanSignal(candidateState)

  const currentHasToolContext = current.toolSpanCount > 0 || current.toolNameCount > 0 || current.fileCount > 0
  const candidateHasToolContext = candidate.toolSpanCount > 0 || candidate.toolNameCount > 0 || candidate.fileCount > 0

  if (candidateHasToolContext && !currentHasToolContext) {
    return true
  }

  if (candidate.fileCount !== current.fileCount) {
    return candidate.fileCount > current.fileCount
  }

  if (candidate.toolSpanCount !== current.toolSpanCount) {
    return candidate.toolSpanCount > current.toolSpanCount
  }

  if (candidate.toolNameCount !== current.toolNameCount) {
    return candidate.toolNameCount > current.toolNameCount
  }

  if (current.spanCount === 0 && candidate.spanCount > 0) {
    return true
  }

  return false
}

function applyAssistantMessage(requestState, message) {
  requestState.provider = String(message?.provider ?? requestState.provider ?? '').trim()
  requestState.model = String(message?.model ?? requestState.model ?? '').trim()
  requestState.api = String(message?.api ?? requestState.api ?? '').trim()
  requestState.stopReason = String(message?.stopReason ?? requestState.stopReason ?? '').trim()

  const usage = extractUsageFromMessage(message)
  if (usageAvailable(usage)) {
    requestState.usage = usage
    requestState.usageSource = 'message_usage'
  }
}

export function createRequestTelemetryExtension({ cwd = process.cwd() } = {}) {
  const artifacts = getRequestTelemetryPaths({ cwd })
  const storage = readRequestTelemetryStorageOptionsFromEnv()
  const state = {
    sessionId: randomUUID(),
    currentModel: '',
    currentTurn: null,
    pendingRequests: [],
    sessionMessages: [],
    toolCallIndex: new Map(),
    hookSequence: 0,
    traceChain: Promise.resolve(),
  }

  function getCurrentTurn(overrides = {}) {
    if (!state.currentTurn) {
      state.currentTurn = createTurnState({
        model: state.currentModel,
        ...overrides,
      })
    }

    if (state.currentModel !== '' && state.currentTurn.model === '') {
      state.currentTurn.model = state.currentModel
    }

    return state.currentTurn
  }

  function getLatestPendingRequest() {
    return state.pendingRequests.at(-1) ?? null
  }

  function trace(type, detail = {}) {
    if (!storage.storeHooks) {
      return Promise.resolve()
    }

    state.hookSequence += 1
    const activeRequest = getLatestPendingRequest()
    const currentTurn = state.currentTurn
    const event = {
      timestamp: new Date().toISOString(),
      sequence: state.hookSequence,
      type,
      sessionId: state.sessionId,
      turnIndex: currentTurn?.turnIndex ?? detail.turnIndex ?? 0,
      requestId: detail.requestId ?? activeRequest?.requestId ?? '',
      activeRequestId: activeRequest?.requestId ?? '',
      messageRole: detail.messageRole ?? '',
      spanSource: detail.spanSource ?? activeRequest?.spanSource ?? '',
      stopReason: detail.stopReason ?? '',
      contextMessageCount: activeRequest?.contextMessageCount ?? currentTurn?.contextMessageCount ?? 0,
      spanCount: activeRequest?.spanCount ?? currentTurn?.contextSpanCount ?? 0,
      detail,
    }

    state.traceChain = state.traceChain
      .then(() => appendRequestTelemetryHook(artifacts, event))
      .catch(() => {})

    return state.traceChain
  }

  function applySessionHistorySnapshot(requestState) {
    if (state.sessionMessages.length === 0) {
      return false
    }

    applySpanSnapshot(requestState, {
      messages: state.sessionMessages,
      spans: collectMessageSpans({
        requestId: requestState.requestId,
        sessionId: requestState.sessionId,
        turnIndex: requestState.turnIndex,
        messages: state.sessionMessages,
        toolCallIndex: state.toolCallIndex,
        source: 'session_history',
      }),
      source: 'session_history',
    })
    mergeSpanSummary(requestState)
    return requestState.spans.length > 0
  }

  function applyContextSnapshot(requestState) {
    const currentTurn = getCurrentTurn()
    if (!Array.isArray(currentTurn.contextMessages) || currentTurn.contextMessages.length === 0) {
      return false
    }

    applySpanSnapshot(requestState, {
      messages: currentTurn.contextMessages,
      spans: collectMessageSpans({
        requestId: requestState.requestId,
        sessionId: requestState.sessionId,
        turnIndex: requestState.turnIndex,
        messages: currentTurn.contextMessages,
        toolCallIndex: state.toolCallIndex,
      }),
      source: 'context',
    })
    mergeSpanSummary(requestState)
    return requestState.spans.length > 0
  }

  function applyProviderPayloadSnapshot(requestState, payload) {
    requestState.providerPayloadSummary = summarizeProviderPayload(payload)
    if (requestState.providerPayloadSummary.model) {
      requestState.model = requestState.providerPayloadSummary.model
    }

    const payloadSnapshot = collectProviderPayloadSpans({
      requestId: requestState.requestId,
      sessionId: requestState.sessionId,
      turnIndex: requestState.turnIndex,
      payload,
      toolCallIndex: state.toolCallIndex,
    })

    if (payloadSnapshot.spans.length > 0) {
      applySpanSnapshot(requestState, {
        messages: payloadSnapshot.messages,
        spans: payloadSnapshot.spans,
        source: 'provider_payload',
      })
      mergeSpanSummary(requestState)
      return true
    }

    const payloadMessages = extractMessagesFromProviderPayload(payload)
    if (payloadMessages.length > 0) {
      applySpanSnapshot(requestState, {
        messages: payloadMessages,
        spans: collectMessageSpans({
          requestId: requestState.requestId,
          sessionId: requestState.sessionId,
          turnIndex: requestState.turnIndex,
          messages: payloadMessages,
          toolCallIndex: state.toolCallIndex,
          source: 'provider_payload',
        }),
        source: 'provider_payload',
      })
      mergeSpanSummary(requestState)
      return requestState.spans.length > 0
    }

    return false
  }

  function applyToolHookSnapshot(requestState) {
    const currentTurn = getCurrentTurn()
    const toolEvents = Array.isArray(currentTurn.recentToolEvents) ? currentTurn.recentToolEvents : []
    if (toolEvents.length === 0) {
      return false
    }

    const spans = collectToolHookSpans({
      requestId: requestState.requestId,
      sessionId: requestState.sessionId,
      turnIndex: requestState.turnIndex,
      toolEvents,
    })
    if (spans.length === 0) {
      return false
    }

    applySpanSnapshot(requestState, {
      messages: [],
      spans,
      source: 'tool_hooks',
    })
    mergeSpanSummary(requestState)
    return true
  }

  function createProviderRequest(overrides = {}) {
    const currentTurn = getCurrentTurn()
    return createRequestState({
      sessionId: state.sessionId,
      turnIndex: currentTurn.turnIndex,
      startedAt: new Date().toISOString(),
      model: state.currentModel || currentTurn.model,
      metadata: readRequestTelemetryContextFromEnv(),
      ...overrides,
    })
  }

  function createComparableRequestState(baseState) {
    return createRequestState({
      sessionId: baseState.sessionId,
      turnIndex: baseState.turnIndex,
      startedAt: baseState.startedAt,
      model: baseState.model,
      metadata: {
        runId: baseState.runId,
        iteration: baseState.iteration,
        phase: baseState.phase,
        role: baseState.role,
        kind: baseState.kind,
        task: baseState.task,
      },
    })
  }

  function createFallbackRequest() {
    const requestState = createProviderRequest()

    if (!applyContextSnapshot(requestState)) {
      applySessionHistorySnapshot(requestState)
    }

    return requestState
  }

  async function finalizeRequest(requestState, message) {
    requestState.finishedAt = new Date().toISOString()
    if (requestState.startedAt !== '' && requestState.finishedAt !== '') {
      requestState.durationMs = Math.max(
        0,
        new Date(requestState.finishedAt).getTime() - new Date(requestState.startedAt).getTime()
      )
    }

    applyAssistantMessage(requestState, message)
    mergeSpanSummary(requestState)

    await appendRequestTelemetryArtifacts(artifacts, {
      request: {
        timestamp: requestState.finishedAt,
        requestId: requestState.requestId,
        runId: requestState.runId,
        sessionId: requestState.sessionId,
        iteration: requestState.iteration,
        phase: requestState.phase,
        role: requestState.role,
        kind: requestState.kind,
        task: requestState.task,
        turnIndex: requestState.turnIndex,
        startedAt: requestState.startedAt,
        finishedAt: requestState.finishedAt,
        durationMs: requestState.durationMs,
        statusCode: requestState.statusCode,
        provider: requestState.provider,
        model: requestState.model,
        api: requestState.api,
        stopReason: requestState.stopReason,
        usageSource: requestState.usageSource,
        source: 'pi-extension',
        spanSource: requestState.spanSource,
        contextMessageCount: requestState.contextMessageCount,
        spanCount: requestState.spanCount,
        textChars: requestState.textChars,
        textBytes: requestState.textBytes,
        toolNames: [...requestState.toolNames],
        files: [...requestState.files],
        providerPayloadSummary: requestState.providerPayloadSummary,
        responseHeaders: requestState.responseHeaders,
        ...requestState.usage,
      },
      spans: requestState.spans,
    }, {
      includeSpanText: storage.storeSpanText,
    })
  }

  function requestTelemetryExtension(pi) {
    pi.on('session_start', () => {
      state.sessionId = randomUUID()
      state.currentTurn = null
      state.pendingRequests = []
      state.sessionMessages = []
      state.toolCallIndex.clear()
      void trace('session_start')
    })

    pi.on('session_switch', () => {
      state.sessionId = randomUUID()
      state.currentTurn = null
      state.pendingRequests = []
      state.sessionMessages = []
      state.toolCallIndex.clear()
      void trace('session_switch')
    })

    pi.on('model_select', (event) => {
      state.currentModel = toModelName(event?.model)
      if (state.currentTurn && state.currentModel !== '') {
        state.currentTurn.model = state.currentModel
      }
      const activeRequest = getLatestPendingRequest()
      if (activeRequest && state.currentModel !== '') {
        activeRequest.model = state.currentModel
      }
    })

    pi.on('turn_start', (event) => {
      state.currentTurn = createTurnState({
        turnIndex: event?.turnIndex ?? 0,
        startedAt: new Date(Number(event?.timestamp) || Date.now()).toISOString(),
        model: state.currentModel,
      })
      state.pendingRequests = []

      void trace('turn_start', {
        turnIndex: event?.turnIndex ?? 0,
        detail: undefined,
        sessionMessageCount: state.sessionMessages.length,
      })
    })

    pi.on('context', (event) => {
      const currentTurn = getCurrentTurn()
      const contextMessages = Array.isArray(event?.messages) ? event.messages : []
      currentTurn.contextMessages = contextMessages

      const contextSpans = collectMessageSpans({
        requestId: '',
        sessionId: state.sessionId,
        turnIndex: currentTurn.turnIndex,
        messages: contextMessages,
        toolCallIndex: state.toolCallIndex,
      })
      const contextSummary = summarizeRequestSpans(contextSpans)
      currentTurn.contextMessageCount = contextMessages.length
      currentTurn.contextSpanCount = contextSummary.spanCount

      void trace('context', {
        contextMessages: contextMessages.length,
        spanCount: contextSummary.spanCount,
      })
    })

    pi.on('before_provider_request', (event) => {
      const currentTurn = getCurrentTurn()
      const requestState = createProviderRequest()
      const providerApplied = applyProviderPayloadSnapshot(requestState, event?.payload)

      const contextCandidate = createComparableRequestState(requestState)
      const contextApplied = applyContextSnapshot(contextCandidate)
      if (contextApplied && shouldPreferSnapshot(requestState, contextCandidate)) {
        requestState.contextMessages = contextCandidate.contextMessages
        requestState.spans = contextCandidate.spans
        requestState.spanSource = contextCandidate.spanSource
        requestState.contextMessageCount = contextCandidate.contextMessageCount
        requestState.spanCount = contextCandidate.spanCount
        requestState.textChars = contextCandidate.textChars
        requestState.textBytes = contextCandidate.textBytes
        requestState.toolNames = contextCandidate.toolNames
        requestState.files = contextCandidate.files
      }

      const sessionHistoryCandidate = createComparableRequestState(requestState)
      const sessionHistoryApplied = applySessionHistorySnapshot(sessionHistoryCandidate)
      if (sessionHistoryApplied && shouldPreferSnapshot(requestState, sessionHistoryCandidate)) {
        requestState.contextMessages = sessionHistoryCandidate.contextMessages
        requestState.spans = sessionHistoryCandidate.spans
        requestState.spanSource = sessionHistoryCandidate.spanSource
        requestState.contextMessageCount = sessionHistoryCandidate.contextMessageCount
        requestState.spanCount = sessionHistoryCandidate.spanCount
        requestState.textChars = sessionHistoryCandidate.textChars
        requestState.textBytes = sessionHistoryCandidate.textBytes
        requestState.toolNames = sessionHistoryCandidate.toolNames
        requestState.files = sessionHistoryCandidate.files
      }

      const toolHookCandidate = createComparableRequestState(requestState)
      const toolHookApplied = applyToolHookSnapshot(toolHookCandidate)
      if (toolHookApplied && shouldPreferSnapshot(requestState, toolHookCandidate)) {
        requestState.contextMessages = toolHookCandidate.contextMessages
        requestState.spans = toolHookCandidate.spans
        requestState.spanSource = toolHookCandidate.spanSource
        requestState.contextMessageCount = toolHookCandidate.contextMessageCount
        requestState.spanCount = toolHookCandidate.spanCount
        requestState.textChars = toolHookCandidate.textChars
        requestState.textBytes = toolHookCandidate.textBytes
        requestState.toolNames = toolHookCandidate.toolNames
        requestState.files = toolHookCandidate.files
      }

      if (!providerApplied && requestState.spans.length === 0 && !contextApplied && !sessionHistoryApplied && !toolHookApplied) {
        applySessionHistorySnapshot(requestState)
      }
      state.pendingRequests.push(requestState)
      currentTurn.recentToolEvents = []

      void trace('before_provider_request', {
        requestId: requestState.requestId,
        payloadKeys: Object.keys(requestState.providerPayloadSummary),
        messageCount: requestState.providerPayloadSummary.messageCount ?? 0,
        spanSource: requestState.spanSource,
      })
    })

    pi.on('after_provider_response', (event) => {
      const requestState = getLatestPendingRequest()
      if (!requestState) {
        void trace('after_provider_response', {
          requestId: '',
          statusCode: Number(event?.status) || 0,
        })
        return
      }
      requestState.statusCode = Number(event?.status) || 0
      requestState.responseHeaders = sanitizeHeaders(event?.headers)
      void trace('after_provider_response', {
        requestId: requestState.requestId,
        statusCode: requestState.statusCode,
      })
    })

    pi.on('tool_execution_start', (event) => {
      const currentTurn = getCurrentTurn()
      const toolCallId = String(event?.toolCallId ?? '').trim()
      const toolName = String(event?.toolName ?? '').trim()
      const paths = deriveToolPaths(toolName, event?.args)
      if (toolCallId !== '') {
        state.toolCallIndex.set(toolCallId, { toolName, paths })
      }
      currentTurn.recentToolEvents = [
        ...(currentTurn.recentToolEvents ?? []).filter((item) => String(item?.toolCallId ?? '') !== toolCallId),
        {
          toolCallId,
          toolName,
          args: event?.args,
          details: undefined,
          content: [],
          timestamp: new Date().toISOString(),
        },
      ]
    })

    pi.on('tool_result', (event) => {
      const currentTurn = getCurrentTurn()
      const toolCallId = String(event?.toolCallId ?? '').trim()
      if (toolCallId === '') {
        return
      }

      const current = state.toolCallIndex.get(toolCallId) ?? {
        toolName: String(event?.toolName ?? '').trim(),
        paths: [],
      }
      const resultPaths = deriveToolPaths(
        current.toolName,
        event?.output ?? event?.result ?? event?.details,
      )

      state.toolCallIndex.set(toolCallId, {
        toolName: current.toolName,
        paths: [...new Set([...current.paths, ...resultPaths])],
      })
      currentTurn.recentToolEvents = [
        ...(currentTurn.recentToolEvents ?? []).filter((item) => String(item?.toolCallId ?? '') !== toolCallId),
        {
          toolCallId,
          toolName: current.toolName,
          args: event?.input,
          details: event?.details,
          content: Array.isArray(event?.content) ? event.content : [],
          timestamp: new Date().toISOString(),
        },
      ]
    })

    pi.on('message_end', async (event) => {
      const message = event?.message
      const currentTurn = getCurrentTurn()

      if (message && typeof message === 'object') {
        state.sessionMessages.push(message)
        if (message.role === 'assistant') {
          currentTurn.lastAssistantMessage = message
        }
      }

      await trace('message_end', {
        messageRole: String(message?.role ?? ''),
        requestId: getLatestPendingRequest()?.requestId ?? '',
        spanSource: getLatestPendingRequest()?.spanSource ?? '',
        finalizedRequestId: '',
        pendingRequestCount: state.pendingRequests.length,
      })
    })

    pi.on('turn_end', async (event) => {
      const currentTurn = getCurrentTurn({
        turnIndex: event?.turnIndex ?? 0,
      })
      const assistantMessage = currentTurn.lastAssistantMessage ?? event?.message ?? null
      let finalizedRequest = null

      if (assistantMessage?.role === 'assistant') {
        finalizedRequest = state.pendingRequests.pop() ?? createFallbackRequest()
        await finalizeRequest(finalizedRequest, assistantMessage)
      }

      await trace('turn_end', {
        turnIndex: event?.turnIndex ?? getCurrentTurn().turnIndex,
        requestId: finalizedRequest?.requestId ?? getLatestPendingRequest()?.requestId ?? '',
        spanSource: finalizedRequest?.spanSource ?? '',
        stopReason: String(assistantMessage?.stopReason ?? event?.message?.stopReason ?? ''),
        pendingRequestCount: state.pendingRequests.length,
        finalizedRequestId: finalizedRequest?.requestId ?? '',
        discardedRequestIds: state.pendingRequests.map((request) => request.requestId),
      })

      state.pendingRequests = []
      state.currentTurn = null
    })
  }

  return requestTelemetryExtension
}

export default createRequestTelemetryExtension()
