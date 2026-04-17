import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  appendTokenUsageEvent,
  createEmptyTokenBreakdown,
  deriveTokenBreakdown,
  readTokenUsageEvents,
  readTokenUsageSummary,
} from '../src/pi-token-analysis.mjs'

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'pi-token-analysis-'))
}

test('deriveTokenBreakdown aggregates by phase, attribution, tool, file, and directory', () => {
  const breakdown = deriveTokenBreakdown({
    events: [
      {
        timestamp: '2026-04-17T12:00:00.000Z',
        kind: 'main_agent',
        role: 'developer',
        phase: 'Phase 1',
        model: 'local/dev',
        sessionId: 'session-1',
        attributionKind: 'thinking',
        inputTokens: 60,
        outputTokens: 20,
        totalTokens: 80,
      },
      {
        timestamp: '2026-04-17T12:00:01.000Z',
        kind: 'main_agent',
        role: 'developer',
        phase: 'Phase 1',
        model: 'local/dev',
        sessionId: 'session-1',
        attributionKind: 'tool_context',
        toolNames: ['read', 'edit'],
        files: ['src/a.js', 'src/b.js'],
        inputTokens: 90,
        outputTokens: 30,
        totalTokens: 120,
      },
      {
        timestamp: '2026-04-17T12:00:02.000Z',
        kind: 'tester_agent',
        role: 'tester',
        phase: 'Phase 1',
        model: 'local/tester',
        sessionId: 'session-2',
        attributionKind: 'response',
        inputTokens: 15,
        outputTokens: 5,
        totalTokens: 20,
      },
    ],
  })

  assert.equal(breakdown.totals.totalTokens, 220)
  assert.equal(breakdown.coverage.fileAttributedTokens, 120)
  assert.equal(breakdown.coverage.unattributedTokens, 100)
  assert.equal(breakdown.breakdowns.byAttribution[0].key, 'tool_context')
  assert.equal(breakdown.breakdowns.byAttribution[0].totalTokens, 120)
  assert.equal(breakdown.breakdowns.byTool.find((entry) => entry.key === 'read')?.totalTokens, 60)
  assert.equal(breakdown.breakdowns.byTool.find((entry) => entry.key === 'edit')?.totalTokens, 60)
  assert.equal(breakdown.breakdowns.byFile.find((entry) => entry.key === 'src/a.js')?.totalTokens, 60)
  assert.equal(breakdown.breakdowns.byDirectory.find((entry) => entry.key === 'src')?.totalTokens, 120)
  assert.equal(breakdown.breakdowns.byKind.find((entry) => entry.key === 'main_agent')?.totalTokens, 200)
  assert.equal(breakdown.breakdowns.byModel.find((entry) => entry.key === 'local/dev')?.totalTokens, 200)
  assert.equal(breakdown.breakdowns.bySession.find((entry) => entry.key === 'session-1')?.totalTokens, 200)
})

test('appendTokenUsageEvent writes normalized JSONL and summary artifacts for repo and run scopes', async () => {
  const cwd = await makeTempDir()
  const config = {
    runId: 'run-1',
    transport: 'sdk',
    tokenUsageEventsFile: path.join(cwd, 'pi-output/token-usage/events.jsonl'),
    tokenUsageSummaryFile: path.join(cwd, 'pi-output/token-usage/summary.json'),
    runTokenUsageEventsFile: path.join(cwd, '.pi-runtime/runs/run-1/token-usage.events.jsonl'),
    runTokenUsageSummaryFile: path.join(cwd, '.pi-runtime/runs/run-1/token-usage.summary.json'),
  }

  await appendTokenUsageEvent(config, {
    timestamp: '2026-04-17T12:00:00.000Z',
    iteration: 1,
    retryCount: 0,
    reason: 'developer',
    phase: 'Phase 1',
    role: 'developer',
    kind: 'main_agent',
    sessionId: 'session-1',
    model: 'local/dev',
    attributionKind: 'tool_context',
    toolNames: ['read'],
    files: ['src/a.js'],
    primaryFile: 'src/a.js',
    inputTokens: 44,
    outputTokens: 16,
    totalTokens: 60,
    cacheReadTokens: 10,
  })

  const repoEvents = await readTokenUsageEvents(config.tokenUsageEventsFile)
  const runEvents = await readTokenUsageEvents(config.runTokenUsageEventsFile)
  const repoSummary = await readTokenUsageSummary(config)
  const runSummary = await readTokenUsageSummary({
    tokenUsageSummaryFile: config.runTokenUsageSummaryFile,
    tokenUsageEventsFile: config.runTokenUsageEventsFile,
  })

  assert.equal(repoEvents.length, 1)
  assert.equal(runEvents.length, 1)
  assert.equal(repoEvents[0].runId, 'run-1')
  assert.equal(repoEvents[0].transport, 'sdk')
  assert.deepEqual(repoEvents[0].toolNames, ['read'])
  assert.deepEqual(repoEvents[0].files, ['src/a.js'])
  assert.equal(repoSummary.totals.totalTokens, 60)
  assert.equal(repoSummary.coverage.fileAttributedTokens, 60)
  assert.equal(repoSummary.breakdowns.byFile[0].key, 'src/a.js')
  assert.equal(runSummary.totals.totalTokens, 60)
})

test('readTokenUsageSummary falls back to empty structured payload', async () => {
  const summary = await readTokenUsageSummary({
    tokenUsageSummaryFile: '/tmp/does-not-exist-summary.json',
    tokenUsageEventsFile: '/tmp/does-not-exist-events.jsonl',
  })

  assert.deepEqual(summary, {
    ...createEmptyTokenBreakdown(),
    generatedAt: summary.generatedAt,
  })
  assert.match(summary.generatedAt, /^\d{4}-\d{2}-\d{2}T/)
})
