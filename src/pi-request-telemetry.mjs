import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const REQUEST_TELEMETRY_SCHEMA_VERSION = 1
export const REQUEST_TELEMETRY_EXTENSION_DIRNAME = 'pi-harness-request-telemetry'
export const REQUEST_TELEMETRY_ENV_KEYS = Object.freeze({
  runId: 'PI_REQUEST_RUN_ID',
  iteration: 'PI_REQUEST_ITERATION',
  phase: 'PI_REQUEST_PHASE',
  role: 'PI_REQUEST_ROLE',
  kind: 'PI_REQUEST_KIND',
  task: 'PI_REQUEST_TASK',
})

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(scriptDir, '..')
const bundledRequestTelemetryExtensionFile = path.join(
  packageRoot,
  'pi-extensions',
  'request-telemetry',
  'index.mjs'
)
const requestTelemetryShimHeader = [
  '// Managed by @sebastianandreasson/pi-autonomous-agents.',
  '// This shim lets Pi auto-discover the packaged request telemetry extension.',
].join('\n')

function now() {
  return new Date().toISOString()
}

function toFiniteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function normalizeString(value, fallback = '') {
  const text = String(value ?? fallback).trim()
  return text === '' ? String(fallback ?? '') : text
}

function normalizeStringList(values) {
  if (!Array.isArray(values)) {
    return []
  }

  return [...new Set(
    values
      .map((value) => String(value ?? '').trim())
      .filter(Boolean)
  )]
}

function safeJson(value) {
  if (value === undefined) {
    return ''
  }

  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function previewText(value, maxLength = 160) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= maxLength) {
    return text
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`
}

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8')
}

function isoFromValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString()
  }

  const text = String(value ?? '').trim()
  if (text === '') {
    return now()
  }

  const parsed = new Date(text)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : now()
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function createBucketMap() {
  return new Map()
}

function createBucket(key, label) {
  return {
    key,
    label,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    eventCount: 0,
  }
}

function addUsageToBucket(map, key, label, usage, eventCount = 0) {
  const normalizedKey = normalizeString(key, '')
  if (normalizedKey === '') {
    return
  }

  const current = map.get(normalizedKey) ?? createBucket(normalizedKey, normalizeString(label, normalizedKey))
  current.inputTokens += toFiniteNumber(usage?.inputTokens)
  current.outputTokens += toFiniteNumber(usage?.outputTokens)
  current.totalTokens += toFiniteNumber(usage?.totalTokens)
  current.cacheReadTokens += toFiniteNumber(usage?.cacheReadTokens)
  current.cacheWriteTokens += toFiniteNumber(usage?.cacheWriteTokens)
  current.eventCount += toFiniteNumber(eventCount)
  map.set(normalizedKey, current)
}

function finalizeBucketMap(map) {
  return [...map.values()]
    .map((bucket) => ({
      ...bucket,
      inputTokens: Math.round(bucket.inputTokens * 10) / 10,
      outputTokens: Math.round(bucket.outputTokens * 10) / 10,
      totalTokens: Math.round(bucket.totalTokens * 10) / 10,
      cacheReadTokens: Math.round(bucket.cacheReadTokens * 10) / 10,
      cacheWriteTokens: Math.round(bucket.cacheWriteTokens * 10) / 10,
      eventCount: Math.round(bucket.eventCount * 10) / 10,
    }))
    .sort((left, right) => {
      if (right.totalTokens !== left.totalTokens) {
        return right.totalTokens - left.totalTokens
      }
      return left.label.localeCompare(right.label)
    })
}

function createEmptyBreakdownShape(mode = 'request_telemetry') {
  return {
    schemaVersion: REQUEST_TELEMETRY_SCHEMA_VERSION,
    generatedAt: '',
    source: {
      mode,
      eventCount: 0,
      requestCount: 0,
      spanCount: 0,
      runId: '',
      sessionId: '',
    },
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      eventCount: 0,
    },
    coverage: {
      fileAttributedTokens: 0,
      unattributedTokens: 0,
      fileAttributionRatio: 0,
    },
    breakdowns: {
      byKind: [],
      byRole: [],
      byPhase: [],
      byModel: [],
      bySession: [],
      byAttribution: [],
      byTool: [],
      byFile: [],
      byDirectory: [],
    },
  }
}

function createEmptyAnalyticsShape() {
  return {
    schemaVersion: REQUEST_TELEMETRY_SCHEMA_VERSION,
    generatedAt: '',
    source: {
      mode: 'request_telemetry',
      requestCount: 0,
      runId: '',
      sessionId: '',
    },
    timeline: [],
    todos: [],
  }
}

function parseJsonLikeString(value) {
  if (typeof value !== 'string') {
    return value
  }

  const text = value.trim()
  if (text === '') {
    return value
  }

  if (
    !(text.startsWith('{') && text.endsWith('}'))
    && !(text.startsWith('[') && text.endsWith(']'))
    && !(text.startsWith('"') && text.endsWith('"'))
  ) {
    return value
  }

  try {
    const parsed = JSON.parse(text)
    if (typeof parsed === 'string' && parsed !== text) {
      return parseJsonLikeString(parsed)
    }
    return parsed
  } catch {
    return value
  }
}

function filterRequestsForScope(requests, { runId = '', sessionId = '' } = {}) {
  const normalizedRequests = (Array.isArray(requests) ? requests : []).map((request) => normalizeRequestTelemetryRecord(request))
  const requestedRunId = normalizeString(runId, '')
  const requestedSessionId = normalizeString(sessionId, '')
  const latestRequest = [...normalizedRequests]
    .sort((left, right) => String(right.timestamp).localeCompare(String(left.timestamp)))[0]

  const selectedRunId = requestedRunId !== '' && normalizedRequests.some((request) => request.runId === requestedRunId)
    ? requestedRunId
    : normalizeString(latestRequest?.runId, '')
  const selectedSessionId = selectedRunId === '' && requestedSessionId !== '' && normalizedRequests.some((request) => request.sessionId === requestedSessionId)
    ? requestedSessionId
    : selectedRunId === ''
      ? normalizeString(latestRequest?.sessionId, '')
      : ''

  const filteredRequests = selectedRunId !== ''
    ? normalizedRequests.filter((request) => request.runId === selectedRunId)
    : selectedSessionId === ''
      ? normalizedRequests
      : normalizedRequests.filter((request) => request.sessionId === selectedSessionId)

  return {
    filteredRequests,
    selectedRunId,
    selectedSessionId,
  }
}

export function createEmptyRequestUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
}

export function readRequestTelemetryContextFromEnv(env = process.env) {
  return {
    runId: normalizeString(env?.[REQUEST_TELEMETRY_ENV_KEYS.runId], ''),
    iteration: toFiniteNumber(env?.[REQUEST_TELEMETRY_ENV_KEYS.iteration]),
    phase: normalizeString(env?.[REQUEST_TELEMETRY_ENV_KEYS.phase], ''),
    role: normalizeString(env?.[REQUEST_TELEMETRY_ENV_KEYS.role], ''),
    kind: normalizeString(env?.[REQUEST_TELEMETRY_ENV_KEYS.kind], ''),
    task: normalizeString(env?.[REQUEST_TELEMETRY_ENV_KEYS.task], ''),
  }
}

export function normalizeRequestUsage(value) {
  if (!value || typeof value !== 'object') {
    return createEmptyRequestUsage()
  }

  const inputTokens = toFiniteNumber(
    value.inputTokens
    ?? value.input
    ?? value.promptTokens
    ?? value.prompt_tokens
  )
  const outputTokens = toFiniteNumber(
    value.outputTokens
    ?? value.output
    ?? value.completionTokens
    ?? value.completion_tokens
  )
  const cacheReadTokens = toFiniteNumber(
    value.cacheReadTokens
    ?? value.cacheRead
    ?? value.cache_read_tokens
  )
  const cacheWriteTokens = toFiniteNumber(
    value.cacheWriteTokens
    ?? value.cacheWrite
    ?? value.cache_write_tokens
  )
  const totalTokens = toFiniteNumber(
    value.totalTokens
    ?? value.total
    ?? value.total_tokens
  ) || (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens)

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens,
    cacheWriteTokens,
  }
}

export function extractUsageFromMessage(message) {
  return normalizeRequestUsage(
    message?.usage
    ?? message?.tokenUsage
    ?? message?.metrics
    ?? null
  )
}

export function deriveToolPaths(toolName, value) {
  const object = asObject(parseJsonLikeString(value))
  const paths = []

  const candidates = [
    object.path,
    object.file,
    object.filePath,
    object.target,
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      paths.push(candidate)
    }
  }

  const listCandidates = [
    object.paths,
    object.files,
    object.filePaths,
    object.targets,
  ]

  for (const candidate of listCandidates) {
    if (!Array.isArray(candidate)) {
      continue
    }

    for (const item of candidate) {
      if (typeof item === 'string' && item.trim() !== '') {
        paths.push(item)
      }
    }
  }

  if (toolName === 'edit' && typeof object.newPath === 'string' && object.newPath.trim() !== '') {
    paths.push(object.newPath)
  }

  return normalizeStringList(paths)
}

function normalizeTextPart(part) {
  const object = asObject(part)
  const type = normalizeString(object.type, 'text')

  if (
    type === 'text'
    || type === 'input_text'
    || type === 'output_text'
    || type === 'summary_text'
  ) {
    return {
      type: 'text',
      text: String(object.text ?? ''),
    }
  }

  if (type === 'thinking' || type === 'reasoning') {
    const text = object.text
      ?? object.thinking
      ?? object.summary
      ?? safeJson(object)
    return {
      type: 'thinking',
      thinking: String(text ?? ''),
    }
  }

  if (type === 'toolCall') {
    return {
      type: 'toolCall',
      id: normalizeString(object.id, ''),
      name: normalizeString(object.name, ''),
      arguments: parseJsonLikeString(object.arguments),
    }
  }

  return null
}

function parseStructuredTextArray(items) {
  if (!Array.isArray(items)) {
    return []
  }

  const parts = []
  for (const item of items) {
    const normalized = normalizeTextPart(item)
    if (normalized) {
      parts.push(normalized)
    }
  }
  return parts
}

function normalizeProviderToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) {
    return []
  }

  const parts = []
  for (const item of toolCalls) {
    const object = asObject(item)
    const functionObject = asObject(object.function)
    const id = normalizeString(object.id ?? object.call_id, '')
    const name = normalizeString(
      functionObject.name
      ?? object.name,
      ''
    )
    const argumentsValue = parseJsonLikeString(
      functionObject.arguments
      ?? object.arguments
    )

    if (name === '' && id === '' && argumentsValue === undefined) {
      continue
    }

    parts.push({
      type: 'toolCall',
      id,
      name,
      arguments: argumentsValue,
    })
  }

  return parts
}

function normalizeMessageContent(content) {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }

  if (Array.isArray(content)) {
    return parseStructuredTextArray(content)
  }

  return []
}

function normalizeProviderRoleMessage(object) {
  const role = normalizeString(object.role, '')
  if (role === '') {
    return null
  }

  if (role === 'tool') {
    return {
      role: 'toolResult',
      toolCallId: normalizeString(object.tool_call_id ?? object.call_id ?? object.id, ''),
      toolName: normalizeString(object.name, ''),
      details: object,
      content: [{
        type: 'text',
        text: typeof object.content === 'string' ? object.content : safeJson(object.content),
      }],
    }
  }

  const content = normalizeMessageContent(object.content)
  const toolCalls = normalizeProviderToolCalls(object.tool_calls)

  return {
    role,
    content: [...content, ...toolCalls],
    toolCallId: normalizeString(object.toolCallId ?? object.tool_call_id ?? object.call_id, ''),
    toolName: normalizeString(object.toolName ?? object.name, ''),
    details: object.details,
  }
}

function convertProviderInputItemToMessage(item) {
  const object = asObject(item)

  if (typeof item === 'string') {
    return {
      role: 'user',
      content: [{ type: 'text', text: item }],
    }
  }

  if (object.type === 'message') {
    return {
      role: normalizeString(object.role, 'user'),
      content: parseStructuredTextArray(object.content),
    }
  }

  if (object.type === 'function_call') {
    return {
      role: 'assistant',
      content: [{
        type: 'toolCall',
        id: normalizeString(object.call_id ?? object.id, ''),
        name: normalizeString(object.name, ''),
        arguments: parseJsonLikeString(object.arguments),
      }],
    }
  }

  if (object.type === 'function_call_output') {
    return {
      role: 'toolResult',
      toolCallId: normalizeString(object.call_id ?? object.id, ''),
      toolName: normalizeString(object.name, ''),
      details: object,
      content: [{
        type: 'text',
        text: typeof object.output === 'string' ? object.output : safeJson(object.output),
      }],
    }
  }

  if (object.role) {
    return normalizeProviderRoleMessage(object)
  }

  const normalized = normalizeTextPart(object)
  if (normalized) {
    return {
      role: 'user',
      content: [normalized],
    }
  }

  return {
    role: 'user',
    content: [{ type: 'text', text: safeJson(object) }],
  }
}

export function extractMessagesFromProviderPayload(payload) {
  const object = asObject(payload)

  if (Array.isArray(object.messages)) {
    return object.messages
      .map((item) => {
        if (typeof item === 'string') {
          return {
            role: 'user',
            content: [{ type: 'text', text: item }],
          }
        }
        if (!item || typeof item !== 'object') {
          return null
        }
        if (item.role) {
          return normalizeProviderRoleMessage(asObject(item))
        }
        return convertProviderInputItemToMessage(item)
      })
      .filter((message) => normalizeString(message?.role, '') !== '')
  }

  if (typeof object.input === 'string') {
    return [{
      role: 'user',
      content: [{ type: 'text', text: object.input }],
    }]
  }

  if (!Array.isArray(object.input)) {
    return []
  }

  return object.input
    .map((item) => convertProviderInputItemToMessage(item))
    .filter((message) => normalizeString(message?.role, '') !== '')
}

function createSpanBase({
  requestId,
  sessionId,
  turnIndex,
  timestamp,
  role,
  messageIndex,
  spanIndex,
  source = 'context',
}) {
  return {
    schemaVersion: REQUEST_TELEMETRY_SCHEMA_VERSION,
    timestamp: isoFromValue(timestamp),
    requestId: normalizeString(requestId, ''),
    sessionId: normalizeString(sessionId, ''),
    turnIndex: toFiniteNumber(turnIndex),
    source: normalizeString(source, 'context'),
    role: normalizeString(role, ''),
    messageIndex: toFiniteNumber(messageIndex),
    spanIndex: toFiniteNumber(spanIndex),
  }
}

export function normalizeRequestSpanRecord(record) {
  const text = String(record?.text ?? '')
  return {
    ...createSpanBase(record),
    spanKind: normalizeString(record?.spanKind, 'unknown'),
    toolCallId: normalizeString(record?.toolCallId, ''),
    toolName: normalizeString(record?.toolName, ''),
    paths: normalizeStringList(record?.paths),
    primaryPath: normalizeString(record?.primaryPath, ''),
    charCount: toFiniteNumber(record?.charCount ?? text.length),
    byteCount: toFiniteNumber(record?.byteCount ?? byteLength(text)),
    text,
    preview: normalizeString(record?.preview ?? previewText(text), ''),
  }
}

export function createEmptyRequestTelemetryBreakdown() {
  return createEmptyBreakdownShape('request_telemetry')
}

function createTextSpan(base, partial) {
  const text = String(partial?.text ?? '')
  return normalizeRequestSpanRecord({
    ...base,
    ...partial,
    text,
    charCount: text.length,
    byteCount: byteLength(text),
    preview: previewText(text),
  })
}

function extractMessageParts(message) {
  if (typeof message?.content === 'string') {
    return [{ type: 'text', text: message.content }]
  }

  if (Array.isArray(message?.content)) {
    return message.content
  }

  return []
}

export function collectMessageSpans({
  requestId = '',
  sessionId = '',
  turnIndex = 0,
  messages = [],
  toolCallIndex = new Map(),
  source = 'context',
  timestamp = now(),
} = {}) {
  const spans = []
  const localToolCallIndex = new Map(toolCallIndex)

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex]
    const role = normalizeString(message?.role, '')
    const base = createSpanBase({
      requestId,
      sessionId,
      turnIndex,
      timestamp: message?.timestamp ?? timestamp,
      role,
      messageIndex,
      spanIndex: 0,
      source,
    })

    const parts = extractMessageParts(message)
    let localSpanIndex = 0

    if (parts.length === 0 && role === 'toolResult') {
      const indexedTool = localToolCallIndex.get(String(message?.toolCallId ?? '')) ?? null
      const toolName = normalizeString(message?.toolName, indexedTool?.toolName ?? '')
      const paths = normalizeStringList([
        ...deriveToolPaths(toolName, message?.details),
        ...(indexedTool?.paths ?? []),
      ])
      spans.push(createTextSpan(base, {
        spanIndex: localSpanIndex,
        spanKind: 'tool_result',
        toolCallId: normalizeString(message?.toolCallId, ''),
        toolName,
        paths,
        primaryPath: paths[0] ?? '',
        text: safeJson(message?.details),
      }))
      continue
    }

    for (const part of parts) {
      const type = normalizeString(part?.type, 'unknown')
      const nextBase = {
        ...base,
        spanIndex: localSpanIndex,
      }

      if (type === 'text') {
        const indexedTool = localToolCallIndex.get(String(message?.toolCallId ?? '')) ?? null
        const toolName = normalizeString(message?.toolName, indexedTool?.toolName ?? '')
        const toolPaths = role === 'toolResult'
          ? normalizeStringList([
            ...deriveToolPaths(toolName, message?.details),
            ...(indexedTool?.paths ?? []),
          ])
          : []
        spans.push(createTextSpan(nextBase, {
          spanKind: role === 'toolResult' ? 'tool_result' : 'text',
          toolCallId: normalizeString(message?.toolCallId, ''),
          toolName,
          paths: toolPaths,
          primaryPath: toolPaths[0] ?? '',
          text: String(part?.text ?? ''),
        }))
      } else if (type === 'thinking') {
        spans.push(createTextSpan(nextBase, {
          spanKind: 'thinking',
          text: String(part?.thinking ?? ''),
        }))
      } else if (type === 'toolCall') {
        const toolName = normalizeString(part?.name, '')
        const paths = deriveToolPaths(toolName, part?.arguments)
        const toolCallId = normalizeString(part?.id, '')
        if (toolCallId !== '') {
          localToolCallIndex.set(toolCallId, { toolName, paths })
        }
        spans.push(createTextSpan(nextBase, {
          spanKind: 'tool_call',
          toolCallId,
          toolName,
          paths,
          primaryPath: paths[0] ?? '',
          text: safeJson(part?.arguments),
        }))
      } else if (type === 'image') {
        spans.push(createTextSpan(nextBase, {
          spanKind: 'image',
          text: '',
        }))
      } else {
        spans.push(createTextSpan(nextBase, {
          spanKind: type,
          text: safeJson(part),
        }))
      }

      localSpanIndex += 1
    }
  }

  return spans
}

export function collectProviderPayloadSpans({
  requestId = '',
  sessionId = '',
  turnIndex = 0,
  payload,
  toolCallIndex = new Map(),
  timestamp = now(),
} = {}) {
  const messages = extractMessagesFromProviderPayload(payload)
  return {
    messages,
    spans: collectMessageSpans({
      requestId,
      sessionId,
      turnIndex,
      messages,
      toolCallIndex,
      source: 'provider_payload',
      timestamp,
    }),
  }
}

export function summarizeRequestSpans(spans = []) {
  const toolNames = new Set()
  const files = new Set()
  let charCount = 0
  let byteCountTotal = 0

  for (const span of Array.isArray(spans) ? spans : []) {
    const normalized = normalizeRequestSpanRecord(span)
    charCount += normalized.charCount
    byteCountTotal += normalized.byteCount

    if (normalized.toolName !== '') {
      toolNames.add(normalized.toolName)
    }

    for (const file of normalized.paths) {
      files.add(file)
    }
  }

  return {
    spanCount: Array.isArray(spans) ? spans.length : 0,
    textChars: charCount,
    textBytes: byteCountTotal,
    toolNames: [...toolNames],
    files: [...files],
  }
}

export function summarizeProviderPayload(payload) {
  const object = asObject(payload)
  const messages = extractMessagesFromProviderPayload(payload)
  const tools = Array.isArray(object.tools) ? object.tools : []
  const payloadText = safeJson(payload)

  return {
    model: normalizeString(object.model, ''),
    messageCount: messages.length,
    toolCount: tools.length,
    keyCount: Object.keys(object).length,
    topLevelKeys: Object.keys(object).slice(0, 20),
    textChars: payloadText.length,
    textBytes: byteLength(payloadText),
  }
}

export function normalizeRequestTelemetryRecord(record) {
  const usage = normalizeRequestUsage(record)
  return {
    schemaVersion: REQUEST_TELEMETRY_SCHEMA_VERSION,
    timestamp: isoFromValue(record?.timestamp),
    requestId: normalizeString(record?.requestId, ''),
    runId: normalizeString(record?.runId, ''),
    sessionId: normalizeString(record?.sessionId, ''),
    iteration: toFiniteNumber(record?.iteration),
    phase: normalizeString(record?.phase, ''),
    role: normalizeString(record?.role, ''),
    kind: normalizeString(record?.kind, ''),
    task: normalizeString(record?.task, ''),
    turnIndex: toFiniteNumber(record?.turnIndex),
    startedAt: normalizeString(record?.startedAt, ''),
    finishedAt: normalizeString(record?.finishedAt, ''),
    durationMs: toFiniteNumber(record?.durationMs),
    statusCode: toFiniteNumber(record?.statusCode),
    provider: normalizeString(record?.provider, ''),
    model: normalizeString(record?.model, ''),
    api: normalizeString(record?.api, ''),
    stopReason: normalizeString(record?.stopReason, ''),
    usageSource: normalizeString(record?.usageSource, 'unavailable'),
    source: normalizeString(record?.source, 'pi-extension'),
    spanSource: normalizeString(record?.spanSource, ''),
    contextMessageCount: toFiniteNumber(record?.contextMessageCount),
    spanCount: toFiniteNumber(record?.spanCount),
    textChars: toFiniteNumber(record?.textChars),
    textBytes: toFiniteNumber(record?.textBytes),
    toolNames: normalizeStringList(record?.toolNames),
    files: normalizeStringList(record?.files),
    providerPayloadSummary: asObject(record?.providerPayloadSummary),
    responseHeaders: asObject(record?.responseHeaders),
    ...usage,
  }
}

export function getRequestTelemetryPaths({ cwd, baseDir = 'pi-output/request-telemetry' } = {}) {
  const rootDir = path.resolve(String(cwd || process.cwd()), baseDir)
  return {
    rootDir,
    hooksFile: path.join(rootDir, 'hooks.jsonl'),
    requestsFile: path.join(rootDir, 'requests.jsonl'),
    spansFile: path.join(rootDir, 'spans.jsonl'),
  }
}

export function getBundledRequestTelemetryExtensionFile() {
  return bundledRequestTelemetryExtensionFile
}

export function getManagedRequestTelemetryExtensionPaths({ cwd } = {}) {
  const repoRoot = path.resolve(String(cwd || process.cwd()))
  const extensionRoot = path.join(repoRoot, '.pi', 'extensions')
  const extensionDir = path.join(extensionRoot, REQUEST_TELEMETRY_EXTENSION_DIRNAME)

  return {
    repoRoot,
    extensionRoot,
    extensionDir,
    entryFile: path.join(extensionDir, 'index.mjs'),
    manifestFile: path.join(extensionDir, 'package.json'),
    sourceFile: bundledRequestTelemetryExtensionFile,
  }
}

function renderRequestTelemetryExtensionShim(sourceFile) {
  const sourceUrl = pathToFileURL(sourceFile).href
  return [
    requestTelemetryShimHeader,
    `export * from ${JSON.stringify(sourceUrl)}`,
    `export { default } from ${JSON.stringify(sourceUrl)}`,
    '',
  ].join('\n')
}

function renderRequestTelemetryExtensionManifest() {
  return `${JSON.stringify({
    name: REQUEST_TELEMETRY_EXTENSION_DIRNAME,
    private: true,
    type: 'module',
    pi: {
      extensions: ['./index.mjs'],
    },
  }, null, 2)}\n`
}

export async function ensureBundledRequestTelemetryExtension({ cwd, enabled = true } = {}) {
  const paths = getManagedRequestTelemetryExtensionPaths({ cwd })

  if (!enabled) {
    await fs.rm(paths.extensionDir, { recursive: true, force: true })
    return {
      ...paths,
      enabled: false,
      installed: false,
      updated: false,
      removed: true,
    }
  }

  await fs.access(paths.sourceFile)
  await fs.mkdir(paths.extensionDir, { recursive: true })

  const entryContent = renderRequestTelemetryExtensionShim(paths.sourceFile)
  const manifestContent = renderRequestTelemetryExtensionManifest()
  let existingEntry = ''
  let existingManifest = ''
  try {
    existingEntry = await fs.readFile(paths.entryFile, 'utf8')
  } catch {}
  try {
    existingManifest = await fs.readFile(paths.manifestFile, 'utf8')
  } catch {}

  const updated = existingEntry !== entryContent || existingManifest !== manifestContent
  if (existingEntry !== entryContent) {
    await fs.writeFile(paths.entryFile, entryContent, 'utf8')
  }
  if (existingManifest !== manifestContent) {
    await fs.writeFile(paths.manifestFile, manifestContent, 'utf8')
  }

  return {
    ...paths,
    enabled: true,
    installed: true,
    updated,
    removed: false,
  }
}

async function readJsonlRecords(filePath, normalize) {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => normalize(JSON.parse(line)))
  } catch {
    return []
  }
}

export async function ensureRequestTelemetryFiles(paths) {
  const hooksFile = String(paths?.hooksFile ?? '').trim()
  const requestsFile = String(paths?.requestsFile ?? '').trim()
  const spansFile = String(paths?.spansFile ?? '').trim()

  for (const filePath of [hooksFile, requestsFile, spansFile]) {
    if (filePath === '') {
      continue
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.appendFile(filePath, '', 'utf8')
  }
}

export async function appendRequestTelemetryHook(paths, event) {
  const hooksFile = String(paths?.hooksFile ?? '').trim()
  if (hooksFile === '') {
    return null
  }

  const normalizedEvent = {
    schemaVersion: REQUEST_TELEMETRY_SCHEMA_VERSION,
    timestamp: isoFromValue(event?.timestamp),
    sequence: toFiniteNumber(event?.sequence),
    type: normalizeString(event?.type, ''),
    sessionId: normalizeString(event?.sessionId, ''),
    turnIndex: toFiniteNumber(event?.turnIndex),
    requestId: normalizeString(event?.requestId, ''),
    activeRequestId: normalizeString(event?.activeRequestId, ''),
    messageRole: normalizeString(event?.messageRole, ''),
    spanSource: normalizeString(event?.spanSource, ''),
    stopReason: normalizeString(event?.stopReason, ''),
    contextMessageCount: toFiniteNumber(event?.contextMessageCount),
    spanCount: toFiniteNumber(event?.spanCount),
    detail: asObject(event?.detail),
  }

  await ensureRequestTelemetryFiles(paths)
  await fs.appendFile(hooksFile, `${JSON.stringify(normalizedEvent)}\n`, 'utf8')
  return normalizedEvent
}

export async function appendRequestTelemetryArtifacts(paths, { request, spans = [] } = {}) {
  const normalizedRequest = normalizeRequestTelemetryRecord(request)
  const normalizedSpans = (Array.isArray(spans) ? spans : []).map((span) => normalizeRequestSpanRecord(span))

  await ensureRequestTelemetryFiles(paths)

  if (String(paths?.requestsFile ?? '').trim() !== '') {
    await fs.appendFile(paths.requestsFile, `${JSON.stringify(normalizedRequest)}\n`, 'utf8')
  }

  if (String(paths?.spansFile ?? '').trim() !== '' && normalizedSpans.length > 0) {
    const content = normalizedSpans.map((span) => JSON.stringify(span)).join('\n')
    await fs.appendFile(paths.spansFile, `${content}\n`, 'utf8')
  }

  return {
    request: normalizedRequest,
    spans: normalizedSpans,
  }
}

export function deriveRequestTelemetryBreakdown({ requests = [], spans = [], sessionId = '', runId = '' } = {}) {
  const empty = createEmptyRequestTelemetryBreakdown()
  const normalizedRequests = (Array.isArray(requests) ? requests : [])
    .map((request) => normalizeRequestTelemetryRecord(request))

  if (normalizedRequests.length === 0) {
    return empty
  }

  const { filteredRequests, selectedRunId, selectedSessionId } = filterRequestsForScope(normalizedRequests, {
    runId,
    sessionId,
  })
  const requestIds = new Set(filteredRequests.map((request) => request.requestId))
  const filteredSpans = (Array.isArray(spans) ? spans : [])
    .map((span) => normalizeRequestSpanRecord(span))
    .filter((span) => requestIds.has(span.requestId))

  const spansByRequestId = new Map()
  for (const span of filteredSpans) {
    const existing = spansByRequestId.get(span.requestId) ?? []
    existing.push(span)
    spansByRequestId.set(span.requestId, existing)
  }

  const totals = { ...empty.totals }
  const byAttribution = createBucketMap()
  const byKind = createBucketMap()
  const byRole = createBucketMap()
  const byPhase = createBucketMap()
  const byModel = createBucketMap()
  const bySession = createBucketMap()
  const byTool = createBucketMap()
  const byFile = createBucketMap()
  const byDirectory = createBucketMap()

  let fileAttributedTokens = 0
  let unattributedTokens = 0

  for (const request of filteredRequests) {
    const exactUsage = {
      inputTokens: request.inputTokens,
      outputTokens: request.outputTokens,
      totalTokens: request.totalTokens,
      cacheReadTokens: request.cacheReadTokens,
      cacheWriteTokens: request.cacheWriteTokens,
    }
    totals.inputTokens += request.inputTokens
    totals.outputTokens += request.outputTokens
    totals.totalTokens += request.totalTokens
    totals.cacheReadTokens += request.cacheReadTokens
    totals.cacheWriteTokens += request.cacheWriteTokens
    totals.eventCount += 1

    addUsageToBucket(byAttribution, request.spanSource, request.spanSource, exactUsage, 1)
    addUsageToBucket(byKind, request.kind, request.kind, exactUsage, 1)
    addUsageToBucket(byRole, request.role, request.role, exactUsage, 1)
    addUsageToBucket(byPhase, request.phase, request.phase, exactUsage, 1)
    addUsageToBucket(byModel, request.model, request.model, exactUsage, 1)
    addUsageToBucket(bySession, request.sessionId, request.sessionId, exactUsage, 1)

    const inputContextBudget = request.inputTokens + request.cacheReadTokens + request.cacheWriteTokens
    const requestSpans = spansByRequestId.get(request.requestId) ?? []
    const attributableSpans = requestSpans.filter((span) => span.byteCount > 0)
    const totalAttributedBytes = attributableSpans.reduce((sum, span) => sum + span.byteCount, 0)
    const requestHasFiles = request.files.length > 0

    if (requestHasFiles) {
      fileAttributedTokens += inputContextBudget
    } else {
      unattributedTokens += inputContextBudget
    }

    if (inputContextBudget <= 0 || totalAttributedBytes <= 0) {
      continue
    }

    const toolHits = new Set()
    const fileHits = new Set()
    const directoryHits = new Set()

    for (const span of attributableSpans) {
      const share = inputContextBudget * (span.byteCount / totalAttributedBytes)

      if (span.toolName !== '') {
        addUsageToBucket(byTool, span.toolName, span.toolName, {
          inputTokens: share,
          outputTokens: 0,
          totalTokens: share,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        })
        toolHits.add(span.toolName)
      }

      const spanPaths = Array.isArray(span.paths) ? span.paths : []
      const perPathShare = spanPaths.length > 0 ? share / spanPaths.length : 0
      for (const filePath of spanPaths) {
        addUsageToBucket(byFile, filePath, filePath, {
          inputTokens: perPathShare,
          outputTokens: 0,
          totalTokens: perPathShare,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        })
        fileHits.add(filePath)

        const directory = path.dirname(filePath).replace(/\\/g, '/')
        if (directory !== '.' && directory !== '') {
          addUsageToBucket(byDirectory, directory, directory, {
            inputTokens: perPathShare,
            outputTokens: 0,
            totalTokens: perPathShare,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          })
          directoryHits.add(directory)
        }
      }
    }

    for (const key of toolHits) {
      addUsageToBucket(byTool, key, key, {}, 1)
    }
    for (const key of fileHits) {
      addUsageToBucket(byFile, key, key, {}, 1)
    }
    for (const key of directoryHits) {
      addUsageToBucket(byDirectory, key, key, {}, 1)
    }
  }

  const totalInputContextTokens = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens

  return {
    schemaVersion: REQUEST_TELEMETRY_SCHEMA_VERSION,
    generatedAt: now(),
    source: {
      mode: 'request_telemetry',
      eventCount: filteredRequests.length,
      requestCount: filteredRequests.length,
      spanCount: filteredSpans.length,
      runId: selectedRunId,
      sessionId: selectedSessionId,
    },
    totals: {
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      totalTokens: totals.totalTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      eventCount: filteredRequests.length,
    },
    coverage: {
      fileAttributedTokens: Math.round(fileAttributedTokens * 10) / 10,
      unattributedTokens: Math.round(unattributedTokens * 10) / 10,
      fileAttributionRatio: totalInputContextTokens > 0 ? fileAttributedTokens / totalInputContextTokens : 0,
    },
    breakdowns: {
      byKind: finalizeBucketMap(byKind),
      byRole: finalizeBucketMap(byRole),
      byPhase: finalizeBucketMap(byPhase),
      byModel: finalizeBucketMap(byModel),
      bySession: finalizeBucketMap(bySession),
      byAttribution: finalizeBucketMap(byAttribution),
      byTool: finalizeBucketMap(byTool),
      byFile: finalizeBucketMap(byFile),
      byDirectory: finalizeBucketMap(byDirectory),
    },
  }
}

function formatTimelineLabel(timestamp) {
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) {
    return ''
  }
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function summarizeTodoRequests(requests, iterationSummary) {
  const sorted = [...requests].sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)))
  const firstRequest = sorted[0]
  const lastRequest = sorted.at(-1)
  const task = sorted.find((request) => request.task !== '')?.task || iterationSummary?.task || `Iteration ${firstRequest?.iteration ?? 0}`
  const phase = sorted.find((request) => request.phase !== '')?.phase || iterationSummary?.phase || ''
  const roleSet = new Set(sorted.map((request) => request.role).filter(Boolean))
  const kindSet = new Set(sorted.map((request) => request.kind).filter(Boolean))

  return {
    key: `iteration-${firstRequest?.iteration ?? 0}`,
    iteration: Number(firstRequest?.iteration ?? 0),
    phase,
    task,
    status: String(iterationSummary?.status ?? ''),
    requestCount: sorted.length,
    firstTimestamp: String(firstRequest?.timestamp ?? ''),
    lastTimestamp: String(lastRequest?.timestamp ?? ''),
    roles: [...roleSet],
    kinds: [...kindSet],
    inputTokens: sorted.reduce((sum, request) => sum + request.inputTokens, 0),
    outputTokens: sorted.reduce((sum, request) => sum + request.outputTokens, 0),
    totalTokens: sorted.reduce((sum, request) => sum + request.totalTokens, 0),
    cacheReadTokens: sorted.reduce((sum, request) => sum + request.cacheReadTokens, 0),
    cacheWriteTokens: sorted.reduce((sum, request) => sum + request.cacheWriteTokens, 0),
  }
}

export function deriveRequestTelemetryAnalytics({ requests = [], telemetry = [], runId = '', sessionId = '' } = {}) {
  const empty = createEmptyAnalyticsShape()
  const normalizedRequests = (Array.isArray(requests) ? requests : [])
    .map((request) => normalizeRequestTelemetryRecord(request))

  if (normalizedRequests.length === 0) {
    return empty
  }

  const { filteredRequests, selectedRunId, selectedSessionId } = filterRequestsForScope(normalizedRequests, {
    runId,
    sessionId,
  })

  if (filteredRequests.length === 0) {
    return empty
  }

  const sortedRequests = [...filteredRequests].sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)))
  const timeline = []

  if (sortedRequests.length <= 36) {
    for (const request of sortedRequests) {
      timeline.push({
        key: request.requestId,
        timestamp: request.timestamp,
        label: formatTimelineLabel(request.timestamp),
        requestCount: 1,
        inputTokens: request.inputTokens,
        outputTokens: request.outputTokens,
        totalTokens: request.totalTokens,
        cacheReadTokens: request.cacheReadTokens,
        cacheWriteTokens: request.cacheWriteTokens,
      })
    }
  } else {
    const startedAt = new Date(sortedRequests[0].timestamp).getTime()
    const finishedAt = new Date(sortedRequests.at(-1)?.timestamp ?? sortedRequests[0].timestamp).getTime()
    const bucketCount = 36
    const bucketMs = Math.max(1, Math.ceil((finishedAt - startedAt + 1) / bucketCount))
    const buckets = new Map()

    for (const request of sortedRequests) {
      const bucketIndex = Math.max(0, Math.min(bucketCount - 1, Math.floor((new Date(request.timestamp).getTime() - startedAt) / bucketMs)))
      const bucketStart = new Date(startedAt + (bucketIndex * bucketMs)).toISOString()
      const current = buckets.get(bucketIndex) ?? {
        key: `bucket-${bucketIndex}`,
        timestamp: bucketStart,
        label: formatTimelineLabel(bucketStart),
        requestCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }
      current.requestCount += 1
      current.inputTokens += request.inputTokens
      current.outputTokens += request.outputTokens
      current.totalTokens += request.totalTokens
      current.cacheReadTokens += request.cacheReadTokens
      current.cacheWriteTokens += request.cacheWriteTokens
      buckets.set(bucketIndex, current)
    }

    timeline.push(...[...buckets.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([, bucket]) => bucket))
  }

  const iterationSummaries = new Map()
  for (const event of Array.isArray(telemetry) ? telemetry : []) {
    if (String(event?.kind ?? '') !== 'iteration_summary') {
      continue
    }
    iterationSummaries.set(Number(event?.iteration ?? 0), {
      iteration: Number(event?.iteration ?? 0),
      phase: String(event?.phase ?? ''),
      status: String(event?.status ?? ''),
      timestamp: String(event?.timestamp ?? ''),
    })
  }

  const requestsByIteration = new Map()
  for (const request of sortedRequests) {
    const iteration = Number(request.iteration ?? 0)
    if (!Number.isFinite(iteration) || iteration <= 0) {
      continue
    }
    const existing = requestsByIteration.get(iteration) ?? []
    existing.push(request)
    requestsByIteration.set(iteration, existing)
  }

  const todos = [...requestsByIteration.entries()]
    .map(([iteration, iterationRequests]) => summarizeTodoRequests(iterationRequests, iterationSummaries.get(iteration)))
    .filter((todo) => todo.status === 'success')
    .sort((left, right) => right.iteration - left.iteration)

  return {
    schemaVersion: REQUEST_TELEMETRY_SCHEMA_VERSION,
    generatedAt: now(),
    source: {
      mode: 'request_telemetry',
      requestCount: sortedRequests.length,
      runId: selectedRunId,
      sessionId: selectedSessionId,
    },
    timeline,
    todos,
  }
}

export async function readRequestTelemetryRecords({ cwd, baseDir } = {}) {
  const paths = getRequestTelemetryPaths({ cwd, baseDir })
  const [requests, spans] = await Promise.all([
    readJsonlRecords(paths.requestsFile, normalizeRequestTelemetryRecord),
    readJsonlRecords(paths.spansFile, normalizeRequestSpanRecord),
  ])
  return { requests, spans }
}

export async function readRequestTelemetryBreakdown({ cwd, sessionId = '', runId = '', baseDir } = {}) {
  const { requests, spans } = await readRequestTelemetryRecords({ cwd, baseDir })
  return deriveRequestTelemetryBreakdown({ requests, spans, sessionId, runId })
}
