function readTimeout(raw, fallback) {
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

export function resolveHeartbeatConfig(request = {}) {
  const continueAfterSeconds = readTimeout(request.continueAfterSeconds, 300)
  const noEventTimeoutSeconds = readTimeout(request.noEventTimeoutSeconds, 900)
  const toolContinueAfterSeconds = readTimeout(request.toolContinueAfterSeconds, 900)
  const toolNoEventTimeoutSeconds = readTimeout(request.toolNoEventTimeoutSeconds, 1800)

  return {
    continueAfterSeconds,
    noEventTimeoutSeconds,
    toolContinueAfterSeconds,
    toolNoEventTimeoutSeconds,
  }
}

export function getHeartbeatThresholds({
  continueAfterSeconds,
  noEventTimeoutSeconds,
  toolContinueAfterSeconds,
  toolNoEventTimeoutSeconds,
  activeToolName,
}) {
  if (activeToolName) {
    return {
      continueAfterSeconds: toolContinueAfterSeconds,
      noEventTimeoutSeconds: toolNoEventTimeoutSeconds,
      timeoutClass: 'tool_idle',
    }
  }

  return {
    continueAfterSeconds,
    noEventTimeoutSeconds,
    timeoutClass: 'agent_idle',
  }
}

export function getActiveToolInfo(activeToolName, activeToolStartedAt, now = Date.now()) {
  if (!activeToolName || !Number.isFinite(activeToolStartedAt)) {
    return {
      activeToolName: '',
      toolRuntimeSeconds: 0,
      isToolActive: false,
    }
  }

  return {
    activeToolName,
    toolRuntimeSeconds: Math.max(0, Math.floor((now - activeToolStartedAt) / 1000)),
    isToolActive: true,
  }
}

export function getHeartbeatDecision({
  now = Date.now(),
  agentStarted,
  agentEnded,
  heartbeatTimedOut,
  childExited,
  lastEventAt,
  continueAttempted,
  activeToolName = '',
  activeToolStartedAt = 0,
  continueAfterSeconds,
  noEventTimeoutSeconds,
  toolContinueAfterSeconds,
  toolNoEventTimeoutSeconds,
}) {
  if (!agentStarted || agentEnded || heartbeatTimedOut || childExited) {
    return { action: 'none' }
  }

  const idleSeconds = Math.max(0, Math.floor((now - lastEventAt) / 1000))
  const { activeToolName: resolvedToolName, toolRuntimeSeconds, isToolActive } = getActiveToolInfo(
    activeToolName,
    activeToolStartedAt,
    now
  )
  const thresholds = getHeartbeatThresholds({
    continueAfterSeconds,
    noEventTimeoutSeconds,
    toolContinueAfterSeconds,
    toolNoEventTimeoutSeconds,
    activeToolName: resolvedToolName,
  })

  if (!continueAttempted && thresholds.continueAfterSeconds > 0 && idleSeconds > thresholds.continueAfterSeconds) {
    return {
      action: 'soft_continue',
      idleSeconds,
      ...thresholds,
      activeToolName: resolvedToolName,
      toolRuntimeSeconds,
      isToolActive,
    }
  }

  if (thresholds.noEventTimeoutSeconds > 0 && idleSeconds > thresholds.noEventTimeoutSeconds) {
    return {
      action: 'abort',
      idleSeconds,
      ...thresholds,
      activeToolName: resolvedToolName,
      toolRuntimeSeconds,
      isToolActive,
    }
  }

  return {
    action: 'none',
    idleSeconds,
    ...thresholds,
    activeToolName: resolvedToolName,
    toolRuntimeSeconds,
    isToolActive,
  }
}

export function formatHeartbeatReason({
  timeoutClass,
  noEventTimeoutSeconds,
  activeToolName,
  toolRuntimeSeconds,
}) {
  const parts = [
    `timeout_class=${timeoutClass}`,
    `no_pi_events_for=${noEventTimeoutSeconds}s`,
  ]

  if (activeToolName) {
    parts.push(`active_tool=${activeToolName}`)
    parts.push(`tool_runtime_seconds=${toolRuntimeSeconds}`)
  }

  return parts.join(' ')
}

export function formatHeartbeatTimeoutMessage({
  noEventTimeoutSeconds,
  activeToolName,
  toolRuntimeSeconds,
}) {
  if (activeToolName) {
    return `No PI RPC events were received for ${noEventTimeoutSeconds} seconds while tool "${activeToolName}" was running (runtime ${toolRuntimeSeconds}s).`
  }

  return `No PI RPC events were received for ${noEventTimeoutSeconds} seconds.`
}
