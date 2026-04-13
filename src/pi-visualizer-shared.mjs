const FLOW_STEPS = [
  { key: 'developer', label: 'Developer' },
  { key: 'verification', label: 'Verification' },
  { key: 'tester', label: 'Tester' },
  { key: 'fix', label: 'Fix' },
  { key: 'git_finalize', label: 'Git Finalize' },
  { key: 'visual_capture', label: 'Visual Capture' },
  { key: 'visual_review', label: 'Visual Review' },
  { key: 'summary', label: 'Summary' },
]

const SUCCESS_STATUSES = new Set(['success', 'passed', 'complete'])
const ERROR_STATUSES = new Set(['failed', 'timed_out', 'stalled', 'blocked', 'canceled'])
const SKIP_STATUSES = new Set(['skipped', 'not_run', 'not_needed'])

export function getFlowSteps() {
  return FLOW_STEPS.map((step) => ({ ...step }))
}

export function getStepKeyForKind(kind) {
  switch (String(kind ?? '')) {
    case 'main_agent':
      return 'developer'
    case 'developer_verification':
    case 'developer_reverification':
    case 'tester_reverification':
      return 'verification'
    case 'tester_agent':
    case 'tester_commit':
      return 'tester'
    case 'fix_agent':
      return 'fix'
    case 'git_finalize':
      return 'git_finalize'
    case 'visual_capture':
      return 'visual_capture'
    case 'visual_review':
      return 'visual_review'
    case 'iteration_summary':
      return 'summary'
    default:
      return ''
  }
}

export function getStepKeyForActiveRun(activeRun) {
  const activeKind = String(activeRun?.activeKind ?? '').trim()
  if (activeKind !== '') {
    return getStepKeyForKind(activeKind)
  }

  const status = String(activeRun?.status ?? '').trim()
  if (status === 'starting_iteration' || status === 'iteration_in_progress' || status === 'agent_running') {
    return 'developer'
  }
  if (status === 'verification_running') {
    return 'verification'
  }
  if (status === 'git_finalize_running') {
    return 'git_finalize'
  }
  if (status === 'visual_capture_running') {
    return 'visual_capture'
  }
  if (status === 'visual_review_running') {
    return 'visual_review'
  }

  return ''
}

function normalizeEventStatus(status) {
  const value = String(status ?? '').trim().toLowerCase()
  if (SUCCESS_STATUSES.has(value)) {
    return 'done'
  }
  if (ERROR_STATUSES.has(value)) {
    return 'error'
  }
  if (SKIP_STATUSES.has(value)) {
    return 'skipped'
  }
  return 'pending'
}

export function deriveCurrentIteration({ activeRun, summary, telemetry }) {
  const activeIteration = Number(activeRun?.iteration)
  if (Number.isFinite(activeIteration) && activeIteration > 0) {
    return activeIteration
  }

  const summaryIteration = Number(summary?.iteration)
  if (Number.isFinite(summaryIteration) && summaryIteration > 0) {
    return summaryIteration
  }

  const lastTelemetryIteration = Number(telemetry?.at?.(-1)?.iteration)
  if (Number.isFinite(lastTelemetryIteration) && lastTelemetryIteration > 0) {
    return lastTelemetryIteration
  }

  return 0
}

export function deriveFlowSnapshot({ activeRun, summary, telemetry }) {
  const currentIteration = deriveCurrentIteration({ activeRun, summary, telemetry })
  const iterationTelemetry = Array.isArray(telemetry)
    ? telemetry.filter((event) => Number(event?.iteration) === currentIteration)
    : []
  const activeStepKey = getStepKeyForActiveRun(activeRun)
  const steps = FLOW_STEPS.map((step) => {
    const matchingEvents = iterationTelemetry.filter((event) => getStepKeyForKind(event?.kind) === step.key)
    const latestEvent = matchingEvents.at(-1) ?? null
    const status = activeStepKey === step.key
      ? 'active'
      : latestEvent
        ? normalizeEventStatus(latestEvent.status)
        : 'pending'

    return {
      ...step,
      status,
      latestEvent,
    }
  })

  return {
    iteration: currentIteration,
    activeStepKey,
    steps,
  }
}

export function formatActiveLabel(activeRun, flow) {
  const activeStepKey = flow?.activeStepKey || getStepKeyForActiveRun(activeRun)
  if (activeStepKey !== '') {
    const step = FLOW_STEPS.find((entry) => entry.key === activeStepKey)
    if (step) {
      return step.label
    }
  }

  const status = String(activeRun?.status ?? '').trim()
  if (status === 'idle') {
    return 'Idle'
  }
  if (status === 'starting') {
    return 'Starting'
  }
  if (status === 'starting_iteration') {
    return 'Starting Iteration'
  }
  return status === '' ? 'Unknown' : status
}
