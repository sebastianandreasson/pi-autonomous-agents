import fs from 'node:fs/promises'
import path from 'node:path'

export const TOKEN_ARTIFACT_SCHEMA_VERSION = 1

function now() {
  return new Date().toISOString()
}

function toFiniteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function roundMetric(value) {
  return Math.round(toFiniteNumber(value) * 10) / 10
}

function normalizeString(value, fallback = '') {
  const text = String(value ?? fallback).trim()
  return text === '' ? String(fallback ?? '') : text
}

export function normalizeStringList(values) {
  if (!Array.isArray(values)) {
    return []
  }

  return [...new Set(
    values
      .map((value) => String(value ?? '').trim())
      .filter(Boolean)
  )]
}

export function createEmptyTokenUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
}

export function normalizeTokenUsage(value) {
  if (!value || typeof value !== 'object') {
    return createEmptyTokenUsage()
  }

  return {
    inputTokens: toFiniteNumber(value.inputTokens),
    outputTokens: toFiniteNumber(value.outputTokens),
    totalTokens: toFiniteNumber(value.totalTokens),
    cacheReadTokens: toFiniteNumber(value.cacheReadTokens),
    cacheWriteTokens: toFiniteNumber(value.cacheWriteTokens),
  }
}

export function formatTokenUsageSummary(tokenUsage) {
  const usage = normalizeTokenUsage(tokenUsage)
  if (usage.totalTokens <= 0 && usage.inputTokens <= 0 && usage.outputTokens <= 0) {
    return ''
  }

  return [
    `tokens_total=${usage.totalTokens}`,
    `input_tokens=${usage.inputTokens}`,
    `output_tokens=${usage.outputTokens}`,
    usage.cacheReadTokens > 0 ? `cache_read_tokens=${usage.cacheReadTokens}` : '',
    usage.cacheWriteTokens > 0 ? `cache_write_tokens=${usage.cacheWriteTokens}` : '',
  ].filter(Boolean).join(' ')
}

function parseJsonlLines(raw) {
  const items = []
  for (const line of String(raw ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') {
      continue
    }
    try {
      items.push(JSON.parse(trimmed))
    } catch {
      // Ignore truncated records while files are being appended.
    }
  }
  return items
}

function createBucket(key, label = key) {
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

function cloneBucket(bucket) {
  return createBucket(bucket.key, bucket.label)
}

function addUsage(target, value) {
  const usage = normalizeTokenUsage(value)
  target.inputTokens += usage.inputTokens
  target.outputTokens += usage.outputTokens
  target.totalTokens += usage.totalTokens
  target.cacheReadTokens += usage.cacheReadTokens
  target.cacheWriteTokens += usage.cacheWriteTokens
  return target
}

function splitUsage(value, count) {
  const usage = normalizeTokenUsage(value)
  const divisor = Math.max(1, Number(count) || 1)
  return {
    inputTokens: usage.inputTokens / divisor,
    outputTokens: usage.outputTokens / divisor,
    totalTokens: usage.totalTokens / divisor,
    cacheReadTokens: usage.cacheReadTokens / divisor,
    cacheWriteTokens: usage.cacheWriteTokens / divisor,
  }
}

function formatDirectoryLabel(filePath) {
  const directory = path.dirname(filePath)
  if (directory === '.' || directory === '') {
    return '(repo root)'
  }
  return directory
}

function finalizeBucket(bucket) {
  return {
    ...bucket,
    inputTokens: roundMetric(bucket.inputTokens),
    outputTokens: roundMetric(bucket.outputTokens),
    totalTokens: roundMetric(bucket.totalTokens),
    cacheReadTokens: roundMetric(bucket.cacheReadTokens),
    cacheWriteTokens: roundMetric(bucket.cacheWriteTokens),
    eventCount: roundMetric(bucket.eventCount),
  }
}

function finalizeBucketMap(map) {
  return [...map.values()]
    .map(finalizeBucket)
    .sort((left, right) => {
      if (right.totalTokens !== left.totalTokens) {
        return right.totalTokens - left.totalTokens
      }
      return left.label.localeCompare(right.label)
    })
}

function indexBuckets(items) {
  const map = new Map()
  for (const item of Array.isArray(items) ? items : []) {
    const key = String(item?.key ?? '').trim()
    if (key === '') {
      continue
    }
    const bucket = createBucket(key, String(item?.label ?? key))
    addUsage(bucket, item)
    bucket.eventCount = toFiniteNumber(item?.eventCount)
    map.set(key, bucket)
  }
  return map
}

function addToBucket(map, key, label, value, eventCount = 1) {
  const normalizedKey = String(key ?? '').trim()
  if (normalizedKey === '') {
    return
  }

  const bucket = map.get(normalizedKey) ?? createBucket(normalizedKey, String(label ?? normalizedKey))
  addUsage(bucket, value)
  bucket.eventCount += toFiniteNumber(eventCount)
  map.set(normalizedKey, bucket)
}

export function createEmptyTokenBreakdown() {
  return {
    schemaVersion: TOKEN_ARTIFACT_SCHEMA_VERSION,
    generatedAt: '',
    source: {
      eventCount: 0,
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

function coerceBreakdown(breakdown) {
  const empty = createEmptyTokenBreakdown()
  if (!breakdown || typeof breakdown !== 'object') {
    return empty
  }

  return {
    schemaVersion: TOKEN_ARTIFACT_SCHEMA_VERSION,
    generatedAt: String(breakdown.generatedAt ?? ''),
    source: {
      eventCount: toFiniteNumber(breakdown?.source?.eventCount),
    },
    totals: {
      inputTokens: toFiniteNumber(breakdown?.totals?.inputTokens),
      outputTokens: toFiniteNumber(breakdown?.totals?.outputTokens),
      totalTokens: toFiniteNumber(breakdown?.totals?.totalTokens),
      cacheReadTokens: toFiniteNumber(breakdown?.totals?.cacheReadTokens),
      cacheWriteTokens: toFiniteNumber(breakdown?.totals?.cacheWriteTokens),
      eventCount: toFiniteNumber(breakdown?.totals?.eventCount),
    },
    coverage: {
      fileAttributedTokens: toFiniteNumber(breakdown?.coverage?.fileAttributedTokens),
      unattributedTokens: toFiniteNumber(breakdown?.coverage?.unattributedTokens),
      fileAttributionRatio: toFiniteNumber(breakdown?.coverage?.fileAttributionRatio),
    },
    breakdowns: {
      byKind: Array.isArray(breakdown?.breakdowns?.byKind) ? breakdown.breakdowns.byKind : empty.breakdowns.byKind,
      byRole: Array.isArray(breakdown?.breakdowns?.byRole) ? breakdown.breakdowns.byRole : empty.breakdowns.byRole,
      byPhase: Array.isArray(breakdown?.breakdowns?.byPhase) ? breakdown.breakdowns.byPhase : empty.breakdowns.byPhase,
      byModel: Array.isArray(breakdown?.breakdowns?.byModel) ? breakdown.breakdowns.byModel : empty.breakdowns.byModel,
      bySession: Array.isArray(breakdown?.breakdowns?.bySession) ? breakdown.breakdowns.bySession : empty.breakdowns.bySession,
      byAttribution: Array.isArray(breakdown?.breakdowns?.byAttribution) ? breakdown.breakdowns.byAttribution : empty.breakdowns.byAttribution,
      byTool: Array.isArray(breakdown?.breakdowns?.byTool) ? breakdown.breakdowns.byTool : empty.breakdowns.byTool,
      byFile: Array.isArray(breakdown?.breakdowns?.byFile) ? breakdown.breakdowns.byFile : empty.breakdowns.byFile,
      byDirectory: Array.isArray(breakdown?.breakdowns?.byDirectory) ? breakdown.breakdowns.byDirectory : empty.breakdowns.byDirectory,
    },
  }
}

export function normalizeTokenAttributionEvent(event, options = {}) {
  const usage = normalizeTokenUsage(event)
  return {
    schemaVersion: TOKEN_ARTIFACT_SCHEMA_VERSION,
    timestamp: String(event?.timestamp ?? now()),
    runId: normalizeString(event?.runId ?? options.runId, ''),
    transport: normalizeString(event?.transport ?? options.transport, ''),
    sessionId: normalizeString(event?.sessionId, ''),
    model: normalizeString(event?.model, ''),
    iteration: toFiniteNumber(event?.iteration),
    retryCount: toFiniteNumber(event?.retryCount),
    reason: normalizeString(event?.reason, ''),
    phase: normalizeString(event?.phase, ''),
    role: normalizeString(event?.role, ''),
    kind: normalizeString(event?.kind, ''),
    attributionKind: normalizeString(event?.attributionKind, 'agent'),
    toolNames: normalizeStringList(event?.toolNames),
    files: normalizeStringList(event?.files),
    primaryFile: normalizeString(event?.primaryFile, ''),
    ...usage,
  }
}

export function applyTokenAttributionEvent(currentBreakdown, event) {
  const breakdown = coerceBreakdown(currentBreakdown)
  const normalizedEvent = normalizeTokenAttributionEvent(event)
  const usage = normalizeTokenUsage(normalizedEvent)

  const totals = cloneBucket({ key: 'total', label: 'Total' })
  addUsage(totals, breakdown.totals)
  totals.eventCount = toFiniteNumber(breakdown.totals.eventCount)
  addUsage(totals, usage)
  totals.eventCount += 1

  const byKind = indexBuckets(breakdown.breakdowns.byKind)
  const byRole = indexBuckets(breakdown.breakdowns.byRole)
  const byPhase = indexBuckets(breakdown.breakdowns.byPhase)
  const byModel = indexBuckets(breakdown.breakdowns.byModel)
  const bySession = indexBuckets(breakdown.breakdowns.bySession)
  const byAttribution = indexBuckets(breakdown.breakdowns.byAttribution)
  const byTool = indexBuckets(breakdown.breakdowns.byTool)
  const byFile = indexBuckets(breakdown.breakdowns.byFile)
  const byDirectory = indexBuckets(breakdown.breakdowns.byDirectory)

  addToBucket(byKind, normalizedEvent.kind, normalizedEvent.kind, usage)
  addToBucket(byRole, normalizedEvent.role, normalizedEvent.role, usage)
  addToBucket(byPhase, normalizedEvent.phase, normalizedEvent.phase, usage)
  addToBucket(byModel, normalizedEvent.model, normalizedEvent.model, usage)
  addToBucket(bySession, normalizedEvent.sessionId, normalizedEvent.sessionId, usage)
  addToBucket(byAttribution, normalizedEvent.attributionKind, normalizedEvent.attributionKind, usage)

  if (normalizedEvent.toolNames.length > 0) {
    const split = splitUsage(usage, normalizedEvent.toolNames.length)
    for (const toolName of normalizedEvent.toolNames) {
      addToBucket(byTool, toolName, toolName, split, 1 / normalizedEvent.toolNames.length)
    }
  }

  let fileAttributedTokens = toFiniteNumber(breakdown.coverage.fileAttributedTokens)
  if (normalizedEvent.files.length > 0) {
    fileAttributedTokens += usage.totalTokens
    const split = splitUsage(usage, normalizedEvent.files.length)
    for (const file of normalizedEvent.files) {
      addToBucket(byFile, file, file, split, 1 / normalizedEvent.files.length)
      const directory = formatDirectoryLabel(file)
      addToBucket(byDirectory, directory, directory, split, 1 / normalizedEvent.files.length)
    }
  }

  const finalizedTotals = finalizeBucket(totals)
  const finalizedFileAttributedTokens = roundMetric(fileAttributedTokens)
  const unattributedTokens = roundMetric(Math.max(0, finalizedTotals.totalTokens - finalizedFileAttributedTokens))

  return {
    schemaVersion: TOKEN_ARTIFACT_SCHEMA_VERSION,
    generatedAt: now(),
    source: {
      eventCount: toFiniteNumber(breakdown.source.eventCount) + 1,
    },
    totals: {
      inputTokens: finalizedTotals.inputTokens,
      outputTokens: finalizedTotals.outputTokens,
      totalTokens: finalizedTotals.totalTokens,
      cacheReadTokens: finalizedTotals.cacheReadTokens,
      cacheWriteTokens: finalizedTotals.cacheWriteTokens,
      eventCount: finalizedTotals.eventCount,
    },
    coverage: {
      fileAttributedTokens: finalizedFileAttributedTokens,
      unattributedTokens,
      fileAttributionRatio: finalizedTotals.totalTokens > 0
        ? roundMetric(finalizedFileAttributedTokens / finalizedTotals.totalTokens)
        : 0,
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

export function deriveTokenBreakdown({ events = [] }) {
  let breakdown = createEmptyTokenBreakdown()
  for (const event of Array.isArray(events) ? events : []) {
    breakdown = applyTokenAttributionEvent(breakdown, event)
  }
  if (breakdown.generatedAt === '') {
    breakdown.generatedAt = now()
  }
  return breakdown
}

function getTokenArtifactTargets(config) {
  const targets = []
  const primaryEvents = String(config?.tokenUsageEventsFile ?? '').trim()
  const primarySummary = String(config?.tokenUsageSummaryFile ?? '').trim()
  const runEvents = String(config?.runTokenUsageEventsFile ?? '').trim()
  const runSummary = String(config?.runTokenUsageSummaryFile ?? '').trim()

  if (primaryEvents !== '') {
    targets.push({ eventsFile: primaryEvents, summaryFile: primarySummary })
  }

  if (runEvents !== '' && (runEvents !== primaryEvents || runSummary !== primarySummary)) {
    targets.push({ eventsFile: runEvents, summaryFile: runSummary })
  }

  return targets
}

export async function ensureTokenUsageFiles(config) {
  for (const target of getTokenArtifactTargets(config)) {
    await fs.mkdir(path.dirname(target.eventsFile), { recursive: true })
    await fs.appendFile(target.eventsFile, '', 'utf8')

    if (target.summaryFile !== '') {
      try {
        await fs.access(target.summaryFile)
      } catch {
        await fs.mkdir(path.dirname(target.summaryFile), { recursive: true })
        await fs.writeFile(target.summaryFile, `${JSON.stringify(createEmptyTokenBreakdown(), null, 2)}\n`, 'utf8')
      }
    }
  }
}

async function readTokenBreakdownFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return coerceBreakdown(JSON.parse(raw))
  } catch {
    return createEmptyTokenBreakdown()
  }
}

async function writeTokenBreakdownFile(filePath, breakdown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(coerceBreakdown(breakdown), null, 2)}\n`, 'utf8')
}

export async function appendTokenUsageEvent(config, event) {
  const normalizedEvent = normalizeTokenAttributionEvent(event, {
    runId: config?.runId,
    transport: config?.transport,
  })

  if (normalizedEvent.totalTokens <= 0 && normalizedEvent.inputTokens <= 0 && normalizedEvent.outputTokens <= 0) {
    return normalizedEvent
  }

  const line = `${JSON.stringify(normalizedEvent)}\n`
  for (const target of getTokenArtifactTargets(config)) {
    await fs.mkdir(path.dirname(target.eventsFile), { recursive: true })
    await fs.appendFile(target.eventsFile, line, 'utf8')

    if (target.summaryFile !== '') {
      const currentBreakdown = await readTokenBreakdownFile(target.summaryFile)
      const nextBreakdown = applyTokenAttributionEvent(currentBreakdown, normalizedEvent)
      await writeTokenBreakdownFile(target.summaryFile, nextBreakdown)
    }
  }

  return normalizedEvent
}

export async function readTokenUsageEvents(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return parseJsonlLines(raw).map((event) => normalizeTokenAttributionEvent(event))
  } catch {
    return []
  }
}

export async function readTokenUsageSummary(config) {
  const summaryFile = String(config?.tokenUsageSummaryFile ?? '').trim()
  const eventsFile = String(config?.tokenUsageEventsFile ?? '').trim()

  if (summaryFile !== '') {
    try {
      const raw = await fs.readFile(summaryFile, 'utf8')
      return coerceBreakdown(JSON.parse(raw))
    } catch {}
  }

  if (eventsFile !== '') {
    return deriveTokenBreakdown({
      events: await readTokenUsageEvents(eventsFile),
    })
  }

  return createEmptyTokenBreakdown()
}
