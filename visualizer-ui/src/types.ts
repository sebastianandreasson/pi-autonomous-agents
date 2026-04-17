export type RunSummary = {
  runId: string
  active?: boolean
  mtimeMs?: number
  status?: string
  iteration?: number
  phase?: string
  task?: string
  runStartedAt?: string
  lastRunAt?: string
}

export type ActiveRun = {
  runId?: string
  status?: string
  phase?: string
  task?: string
  activeKind?: string
  activeRole?: string
  activeReason?: string
  lastStatus?: string
  lastCompletedIteration?: number
}

export type TodoItem = {
  id: string
  kind: 'task'
  lineNumber: number
  level: number
  text: string
  phase?: string
  raw?: string
  checked: boolean
  active?: boolean
}

export type FlowStep = {
  key: string
  label: string
  status: 'pending' | 'active' | 'done' | 'error' | 'skipped' | string
  latestEvent?: {
    _vizId?: string
    kind?: string
    status?: string
    terminalReason?: string
    durationSeconds?: number
    notes?: string
    outputExcerpt?: string
  }
  latestEventId?: string
  activeStartedAt?: string
  durationSeconds?: number | null
}

export type FlowSnapshot = {
  activeLabel?: string
  iteration?: number
  steps: FlowStep[]
}

export type GraphNode = {
  id: string
  label: string
  status: 'pending' | 'active' | 'done' | 'error' | 'skipped' | string
  kind?: string
  retryCount?: number
  role?: string
  terminalReason?: string
  notes?: string
  event?: unknown
}

export type GraphSnapshot = {
  nodes: GraphNode[]
}

export type CurrentEdit = {
  file: string
  diff: string
}

export type LiveFeedEntry = {
  seq?: number
  timestamp?: string
  type?: string
  text?: string
  role?: string
  kind?: string
  toolName?: string
  sessionId?: string
  model?: string
  attributionKind?: string
  primaryFile?: string
  toolNames?: string[]
  files?: string[]
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export type TelemetryEvent = {
  _vizId: string
  timestamp?: string
  iteration?: number
  kind?: string
  status?: string
  notes?: string
  outputExcerpt?: string
  durationSeconds?: number
  terminalReason?: string
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export type TokenBucket = {
  key: string
  label: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  eventCount: number
}

export type TokenBreakdown = {
  schemaVersion?: number
  generatedAt?: string
  source: {
    eventCount: number
  }
  totals: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    eventCount: number
  }
  coverage: {
    fileAttributedTokens: number
    unattributedTokens: number
    fileAttributionRatio: number
  }
  breakdowns: {
    byKind: TokenBucket[]
    byRole: TokenBucket[]
    byPhase: TokenBucket[]
    byModel: TokenBucket[]
    bySession: TokenBucket[]
    byAttribution: TokenBucket[]
    byTool: TokenBucket[]
    byFile: TokenBucket[]
    byDirectory: TokenBucket[]
  }
}

export type VisualizerSnapshot = {
  now: string
  config: {
    cwd: string
    transport?: string
    telemetryJsonl?: string
    activeRunFile?: string
    stateFile?: string
    lastIterationSummaryFile?: string
    selectedRunId?: string
  }
  runs: RunSummary[]
  activeRun: ActiveRun | null
  state: Record<string, unknown> | null
  summary: Record<string, unknown> | null
  flow: FlowSnapshot
  graph: GraphSnapshot
  todos: TodoItem[]
  currentEdits: CurrentEdit[]
  lastOutput: string
  liveFeed: LiveFeedEntry[]
  recentTelemetry: TelemetryEvent[]
  tokenBreakdown: TokenBreakdown
}
