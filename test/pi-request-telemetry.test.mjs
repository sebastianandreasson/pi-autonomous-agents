import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  appendRequestTelemetryHook,
  appendRequestTelemetryArtifacts,
  collectMessageSpans,
  collectProviderPayloadSpans,
  createEmptyRequestTelemetryBreakdown,
  deriveRequestTelemetryBreakdown,
  deriveToolPaths,
  ensureBundledRequestTelemetryExtension,
  extractMessagesFromProviderPayload,
  extractUsageFromMessage,
  getBundledRequestTelemetryExtensionFile,
  getManagedRequestTelemetryExtensionPaths,
  getRequestTelemetryPaths,
  normalizeRequestUsage,
  summarizeProviderPayload,
  summarizeRequestSpans,
} from '../src/pi-request-telemetry.mjs'
import { createRequestTelemetryExtension } from '../pi-extensions/request-telemetry/index.mjs'

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'pi-request-telemetry-'))
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

function createMockPi() {
  const handlers = new Map()

  return {
    on(eventName, handler) {
      const existing = handlers.get(eventName) ?? []
      existing.push(handler)
      handlers.set(eventName, existing)
    },
    async emit(eventName, event = {}) {
      for (const handler of handlers.get(eventName) ?? []) {
        await handler(event)
      }
    },
  }
}

test('normalizeRequestUsage accepts Pi-style usage objects', () => {
  assert.deepEqual(normalizeRequestUsage({
    input: 120,
    output: 40,
    cacheRead: 5,
    cacheWrite: 7,
    totalTokens: 172,
  }), {
    inputTokens: 120,
    outputTokens: 40,
    totalTokens: 172,
    cacheReadTokens: 5,
    cacheWriteTokens: 7,
  })

  assert.deepEqual(extractUsageFromMessage({
    usage: {
      input: 12,
      output: 4,
      totalTokens: 16,
    },
  }), {
    inputTokens: 12,
    outputTokens: 4,
    totalTokens: 16,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  })
})

test('deriveToolPaths extracts stable file lists from common tool payload shapes', () => {
  assert.deepEqual(deriveToolPaths('read', { path: 'src/a.ts' }), ['src/a.ts'])
  assert.deepEqual(deriveToolPaths('read', '{"path":"src/from-json.ts"}'), ['src/from-json.ts'])
  assert.deepEqual(deriveToolPaths('edit', {
    path: 'src/a.ts',
    newPath: 'src/b.ts',
    files: ['src/c.ts'],
  }), ['src/a.ts', 'src/c.ts', 'src/b.ts'])
})

test('ensureBundledRequestTelemetryExtension installs and removes managed Pi extension shim', async () => {
  const cwd = await makeTempDir()
  const installed = await ensureBundledRequestTelemetryExtension({ cwd, enabled: true })

  assert.equal(installed.installed, true)
  assert.equal(await pathExists(installed.entryFile), true)
  assert.equal(await pathExists(installed.manifestFile), true)

  const shim = await fs.readFile(installed.entryFile, 'utf8')
  assert.match(shim, /Managed by @sebastianandreasson\/pi-autonomous-agents/)
  assert.match(shim, new RegExp(pathToFileURL(getBundledRequestTelemetryExtensionFile()).href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  const manifest = JSON.parse(await fs.readFile(installed.manifestFile, 'utf8'))
  assert.deepEqual(manifest.pi?.extensions, ['./index.mjs'])

  const secondInstall = await ensureBundledRequestTelemetryExtension({ cwd, enabled: true })
  assert.equal(secondInstall.updated, false)

  const managedPaths = getManagedRequestTelemetryExtensionPaths({ cwd })
  const removed = await ensureBundledRequestTelemetryExtension({ cwd, enabled: false })
  assert.equal(removed.removed, true)
  assert.equal(await pathExists(managedPaths.extensionDir), false)
})

test('collectMessageSpans captures tool calls, tool results, and file context', () => {
  const spans = collectMessageSpans({
    requestId: 'req-1',
    sessionId: 'session-1',
    turnIndex: 2,
    messages: [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: [{ type: 'text', text: 'Fix src/a.ts' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Need to inspect file.' },
          { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'src/a.ts' } },
        ],
      },
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'read',
        details: { path: 'src/a.ts' },
        content: [{ type: 'text', text: 'export const value = 1' }],
      },
    ],
    toolCallIndex: new Map([
      ['call-1', { toolName: 'read', paths: ['src/a.ts'] }],
    ]),
  })

  assert.equal(spans.length, 5)
  assert.equal(spans.find((span) => span.spanKind === 'thinking')?.role, 'assistant')
  assert.equal(spans.find((span) => span.spanKind === 'tool_call')?.toolName, 'read')
  assert.deepEqual(spans.find((span) => span.spanKind === 'tool_call')?.paths, ['src/a.ts'])
  assert.deepEqual(spans.find((span) => span.spanKind === 'tool_result')?.paths, ['src/a.ts'])

  const summary = summarizeRequestSpans(spans)
  assert.equal(summary.spanCount, 5)
  assert.deepEqual(summary.toolNames, ['read'])
  assert.deepEqual(summary.files, ['src/a.ts'])
})

test('summarizeProviderPayload records basic request-shape metadata', () => {
  const summary = summarizeProviderPayload({
    model: 'openai/gpt-5',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    tools: [{ type: 'function', function: { name: 'read' } }],
    temperature: 0,
  })

  assert.equal(summary.model, 'openai/gpt-5')
  assert.equal(summary.messageCount, 1)
  assert.equal(summary.toolCount, 1)
  assert.equal(summary.keyCount, 4)
  assert.deepEqual(summary.topLevelKeys, ['model', 'input', 'tools', 'temperature'])
  assert.ok(summary.textChars > 0)
  assert.ok(summary.textBytes > 0)
})

test('extractMessagesFromProviderPayload normalizes responses-style input items', () => {
  const messages = extractMessagesFromProviderPayload({
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'Explain the repo' }] },
      { type: 'function_call', call_id: 'call-1', name: 'read', arguments: { path: 'README.md' } },
      { type: 'function_call_output', call_id: 'call-1', output: '# README' },
    ],
  })

  assert.equal(messages.length, 3)
  assert.equal(messages[0].role, 'user')
  assert.equal(messages[1].role, 'assistant')
  assert.equal(messages[1].content[0].type, 'toolCall')
  assert.equal(messages[2].role, 'toolResult')
})

test('collectProviderPayloadSpans derives exact spans from provider payload input', () => {
  const snapshot = collectProviderPayloadSpans({
    requestId: 'req-1',
    sessionId: 'session-1',
    turnIndex: 1,
    payload: {
      model: 'gpt-5.4',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'Explain the repo' }] },
        { type: 'function_call', call_id: 'call-1', name: 'read', arguments: { path: 'README.md' } },
        { type: 'function_call_output', call_id: 'call-1', output: '# README' },
      ],
    },
  })

  assert.equal(snapshot.messages.length, 3)
  assert.equal(snapshot.spans.length, 3)
  assert.equal(snapshot.spans[0].source, 'provider_payload')
  assert.equal(snapshot.spans[1].spanKind, 'tool_call')
  assert.deepEqual(snapshot.spans[1].paths, ['README.md'])
  assert.equal(snapshot.spans[2].spanKind, 'tool_result')
})

test('collectProviderPayloadSpans parses stringified tool args and recovers tool-result paths from call ids', () => {
  const snapshot = collectProviderPayloadSpans({
    requestId: 'req-2',
    sessionId: 'session-1',
    turnIndex: 2,
    payload: {
      model: 'gpt-5.4',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'Inspect README' }] },
        { type: 'function_call', call_id: 'call-1', name: 'read', arguments: '{"path":"README.md"}' },
        { type: 'function_call_output', call_id: 'call-1', output: '# README' },
      ],
    },
  })

  assert.equal(snapshot.messages.length, 3)
  assert.equal(snapshot.spans.length, 3)
  assert.deepEqual(snapshot.spans[1].paths, ['README.md'])
  assert.equal(snapshot.spans[2].toolName, 'read')
  assert.deepEqual(snapshot.spans[2].paths, ['README.md'])
})

test('appendRequestTelemetryArtifacts writes request and span JSONL files', async () => {
  const cwd = await makeTempDir()
  const paths = getRequestTelemetryPaths({ cwd })

  const result = await appendRequestTelemetryArtifacts(paths, {
    request: {
      timestamp: '2026-04-17T12:00:10.000Z',
      requestId: 'req-1',
      sessionId: 'session-1',
      turnIndex: 1,
      startedAt: '2026-04-17T12:00:00.000Z',
      finishedAt: '2026-04-17T12:00:10.000Z',
      durationMs: 10000,
      model: 'local/dev',
      usageSource: 'message_usage',
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      toolNames: ['read'],
      files: ['src/a.ts'],
    },
    spans: [
      {
        timestamp: '2026-04-17T12:00:00.000Z',
        requestId: 'req-1',
        sessionId: 'session-1',
        turnIndex: 1,
        role: 'user',
        messageIndex: 0,
        spanIndex: 0,
        spanKind: 'text',
        text: 'Fix src/a.ts',
      },
    ],
  })

  const requestsRaw = await fs.readFile(paths.requestsFile, 'utf8')
  const spansRaw = await fs.readFile(paths.spansFile, 'utf8')
  const requestRows = requestsRaw.trim().split('\n').map((line) => JSON.parse(line))
  const spanRows = spansRaw.trim().split('\n').map((line) => JSON.parse(line))

  assert.equal(result.request.totalTokens, 120)
  assert.equal(requestRows.length, 1)
  assert.equal(spanRows.length, 1)
  assert.equal(requestRows[0].requestId, 'req-1')
  assert.equal(requestRows[0].usageSource, 'message_usage')
  assert.equal(requestRows[0].spanSource, '')
  assert.deepEqual(requestRows[0].files, ['src/a.ts'])
  assert.equal(spanRows[0].spanKind, 'text')
})

test('appendRequestTelemetryHook writes hook trace JSONL rows', async () => {
  const cwd = await makeTempDir()
  const paths = getRequestTelemetryPaths({ cwd })

  const row = await appendRequestTelemetryHook(paths, {
    timestamp: '2026-04-17T12:00:00.000Z',
    sequence: 1,
    type: 'before_provider_request',
    sessionId: 'session-1',
    turnIndex: 2,
    requestId: 'req-1',
    activeRequestId: 'req-1',
    messageRole: '',
    spanSource: 'provider_payload',
    detail: { messageCount: 4 },
  })

  const raw = await fs.readFile(paths.hooksFile, 'utf8')
  const rows = raw.trim().split('\n').map((line) => JSON.parse(line))

  assert.equal(row.type, 'before_provider_request')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].requestId, 'req-1')
  assert.equal(rows[0].spanSource, 'provider_payload')
  assert.deepEqual(rows[0].detail, { messageCount: 4 })
})

test('request telemetry extension records provider-request-scoped rows', async () => {
  const cwd = await makeTempDir()
  const pi = createMockPi()
  const install = createRequestTelemetryExtension({ cwd })

  install(pi)

  await pi.emit('session_start')
  await pi.emit('model_select', { model: 'local/dev-model' })
  await pi.emit('turn_start', {
    turnIndex: 1,
    timestamp: Date.parse('2026-04-17T12:00:00.000Z'),
  })
  await pi.emit('context', {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Explain README.md' }] },
    ],
  })
  await pi.emit('before_provider_request', {
    payload: {
      model: 'local/dev-model',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'Explain README.md' }] },
        { type: 'function_call', call_id: 'call-1', name: 'read', arguments: { path: 'README.md' } },
      ],
    },
  })
  await pi.emit('after_provider_response', {
    status: 200,
    headers: { 'x-test': '1' },
  })
  await pi.emit('message_end', {
    message: {
      role: 'assistant',
      provider: 'local',
      model: 'local/dev-model',
      api: 'responses',
      stopReason: 'tool_use',
      usage: {
        input: 10,
        output: 3,
        totalTokens: 13,
      },
      content: [
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'README.md' } },
      ],
    },
  })
  await pi.emit('turn_end', {
    turnIndex: 1,
    message: { stopReason: 'tool_use' },
  })

  const paths = getRequestTelemetryPaths({ cwd })
  const requestsRaw = await fs.readFile(paths.requestsFile, 'utf8')
  const spansRaw = await fs.readFile(paths.spansFile, 'utf8')
  const hooksRaw = await fs.readFile(paths.hooksFile, 'utf8')
  const requestRows = requestsRaw.trim().split('\n').map((line) => JSON.parse(line))
  const spanRows = spansRaw.trim().split('\n').map((line) => JSON.parse(line))
  const hookRows = hooksRaw.trim().split('\n').map((line) => JSON.parse(line))

  assert.equal(requestRows.length, 1)
  assert.equal(requestRows[0].turnIndex, 1)
  assert.equal(requestRows[0].usageSource, 'message_usage')
  assert.equal(requestRows[0].spanSource, 'provider_payload')
  assert.equal(requestRows[0].providerPayloadSummary.messageCount, 2)
  assert.deepEqual(requestRows[0].files, ['README.md'])
  assert.equal(requestRows[0].inputTokens, 10)
  assert.equal(requestRows[0].outputTokens, 3)
  assert.equal(requestRows[0].totalTokens, 13)
  assert.equal(spanRows.length, 2)
  assert.ok(hookRows.some((row) => row.type === 'before_provider_request' && row.requestId === requestRows[0].requestId))
  assert.ok(hookRows.some((row) => row.type === 'turn_end' && row.requestId === requestRows[0].requestId))
})

test('deriveRequestTelemetryBreakdown uses exact request totals and file-aware prompt-span allocation', () => {
  const breakdown = deriveRequestTelemetryBreakdown({
    requests: [
      {
        requestId: 'req-1',
        sessionId: 'session-1',
        model: 'gpt-5.4',
        spanSource: 'provider_payload',
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cacheReadTokens: 50,
        cacheWriteTokens: 0,
        files: ['README.md', 'src/index.mjs'],
        toolNames: ['read'],
      },
      {
        requestId: 'req-2',
        sessionId: 'session-1',
        model: 'gpt-5.4',
        spanSource: 'session_history',
        inputTokens: 40,
        outputTokens: 10,
        totalTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        files: [],
        toolNames: [],
      },
    ],
    spans: [
      {
        requestId: 'req-1',
        sessionId: 'session-1',
        turnIndex: 1,
        source: 'provider_payload',
        role: 'assistant',
        messageIndex: 0,
        spanIndex: 0,
        spanKind: 'tool_call',
        toolCallId: 'call-1',
        toolName: 'read',
        paths: ['README.md'],
        primaryPath: 'README.md',
        byteCount: 100,
        charCount: 100,
        text: '{"path":"README.md"}',
      },
      {
        requestId: 'req-1',
        sessionId: 'session-1',
        turnIndex: 1,
        source: 'provider_payload',
        role: 'toolResult',
        messageIndex: 1,
        spanIndex: 0,
        spanKind: 'tool_result',
        toolCallId: 'call-2',
        toolName: 'read',
        paths: ['src/index.mjs'],
        primaryPath: 'src/index.mjs',
        byteCount: 300,
        charCount: 300,
        text: 'export {}',
      },
    ],
    sessionId: 'session-1',
  })

  assert.notDeepEqual(breakdown, createEmptyRequestTelemetryBreakdown())
  assert.equal(breakdown.source.mode, 'request_telemetry')
  assert.equal(breakdown.source.requestCount, 2)
  assert.equal(breakdown.totals.totalTokens, 170)
  assert.equal(breakdown.breakdowns.byAttribution[0].key, 'provider_payload')
  assert.equal(breakdown.breakdowns.byModel[0].key, 'gpt-5.4')
  assert.equal(breakdown.breakdowns.byTool[0].key, 'read')
  assert.ok(breakdown.breakdowns.byFile.some((entry) => entry.key === 'README.md'))
  assert.ok(breakdown.breakdowns.byFile.some((entry) => entry.key === 'src/index.mjs'))
  assert.equal(breakdown.coverage.fileAttributedTokens, 150)
  assert.equal(breakdown.coverage.unattributedTokens, 40)
})
