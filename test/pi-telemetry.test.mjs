import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { appendTelemetry, ensureTelemetryFiles, readJsonlTail, readTelemetryTail } from '../src/pi-telemetry.mjs'

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'pi-telemetry-'))
}

test('ensureTelemetryFiles prepares summary artifacts and structured CSV header', async () => {
  const cwd = await makeTempDir()
  const config = {
    lastAgentOutputFile: path.join(cwd, '.pi-last-output.txt'),
    lastVerificationOutputFile: path.join(cwd, '.pi-last-verification.txt'),
    changedFilesFile: path.join(cwd, '.pi-changed-files.txt'),
    lastPromptFile: path.join(cwd, '.pi-last-prompt.txt'),
    lastIterationSummaryFile: path.join(cwd, '.pi-last-iteration.json'),
    logFile: path.join(cwd, 'pi.log'),
    telemetryJsonl: path.join(cwd, 'pi_telemetry.jsonl'),
    telemetryCsv: path.join(cwd, 'pi_telemetry.csv'),
    runTelemetryJsonl: path.join(cwd, '.pi-runtime', 'runs', 'run-1', 'pi_telemetry.jsonl'),
    runTelemetryCsv: path.join(cwd, '.pi-runtime', 'runs', 'run-1', 'pi_telemetry.csv'),
  }

  await ensureTelemetryFiles(config)

  const csv = await fs.readFile(config.telemetryCsv, 'utf8')
  assert.match(csv, /tool_calls/)
  assert.match(csv, /run_id/)
  assert.match(csv, /input_tokens/)
  assert.match(csv, /total_tokens/)
  assert.match(csv, /stop_reason/)
  assert.match(csv, /terminal_reason/)
  assert.match(csv, /artifact_path/)
  assert.match(csv, /output_excerpt/)
  assert.equal(await fs.readFile(config.lastIterationSummaryFile, 'utf8'), '')
})

test('appendTelemetry writes structured telemetry columns', async () => {
  const cwd = await makeTempDir()
  const config = {
    lastAgentOutputFile: path.join(cwd, '.pi-last-output.txt'),
    lastVerificationOutputFile: path.join(cwd, '.pi-last-verification.txt'),
    changedFilesFile: path.join(cwd, '.pi-changed-files.txt'),
    lastPromptFile: path.join(cwd, '.pi-last-prompt.txt'),
    lastIterationSummaryFile: path.join(cwd, '.pi-last-iteration.json'),
    logFile: path.join(cwd, 'pi.log'),
    telemetryJsonl: path.join(cwd, 'pi_telemetry.jsonl'),
    telemetryCsv: path.join(cwd, 'pi_telemetry.csv'),
    runTelemetryJsonl: path.join(cwd, '.pi-runtime', 'runs', 'run-1', 'pi_telemetry.jsonl'),
    runTelemetryCsv: path.join(cwd, '.pi-runtime', 'runs', 'run-1', 'pi_telemetry.csv'),
  }

  await ensureTelemetryFiles(config)
  await appendTelemetry(config, {
    timestamp: '2026-04-11T00:00:00.000Z',
    runId: 'run-1',
    iteration: 1,
    phase: 'Phase 1',
    kind: 'tester_agent',
    status: 'success',
    transport: 'sdk',
    sessionId: 'session-1',
    timedOut: false,
    exitCode: 0,
    durationSeconds: 12,
    commitBefore: 'abc',
    commitAfter: 'def',
    repoChanged: true,
    changedFilesCount: 2,
    verificationStatus: 'passed',
    retryCount: 0,
    role: 'tester',
    model: 'local/tester',
    inputTokens: 500,
    outputTokens: 80,
    totalTokens: 580,
    cacheReadTokens: 25,
    cacheWriteTokens: 0,
    toolCalls: 3,
    toolErrors: 0,
    messageUpdates: 8,
    stopReason: 'length',
    loopDetected: false,
    loopSignature: '',
    testerVerdict: 'PASS',
    commitPlanFound: true,
    terminalReason: 'tester_pass_with_commit_plan',
    artifactPath: 'pi-output/failure-artifacts/1-tester.md',
    outputExcerpt: 'TypeError: nope',
    notes: 'ok',
  })

  const csv = await fs.readFile(config.telemetryCsv, 'utf8')
  assert.match(csv, /tester/)
  assert.match(csv, /local\/tester/)
  assert.match(csv, /580/)
  assert.match(csv, /tester_pass_with_commit_plan/)
  assert.match(csv, /run-1/)
  assert.match(csv, /failure-artifacts/)
  assert.match(csv, /TypeError: nope/)

  const runCsv = await fs.readFile(config.runTelemetryCsv, 'utf8')
  assert.match(runCsv, /run-1/)
})

test('readJsonlTail returns recent complete records without loading whole file semantics into caller', async () => {
  const cwd = await makeTempDir()
  const filePath = path.join(cwd, 'events.jsonl')
  const records = []
  for (let index = 1; index <= 40; index += 1) {
    records.push(JSON.stringify({ seq: index, text: `event-${index}` }))
  }
  records.push('{"seq": 41, "text": "partial"')
  await fs.writeFile(filePath, `${records.join('\n')}\n`, 'utf8')

  const tail = await readJsonlTail(filePath, { maxItems: 5, maxBytes: 512 })
  assert.deepEqual(tail.map((entry) => entry.seq), [36, 37, 38, 39, 40])
})

test('readTelemetryTail returns recent telemetry records', async () => {
  const cwd = await makeTempDir()
  const config = {
    telemetryJsonl: path.join(cwd, 'pi_telemetry.jsonl'),
  }

  const lines = []
  for (let index = 1; index <= 12; index += 1) {
    lines.push(JSON.stringify({ iteration: index, status: 'success' }))
  }
  await fs.writeFile(config.telemetryJsonl, `${lines.join('\n')}\n`, 'utf8')

  const tail = await readTelemetryTail(config, 3, 256)
  assert.deepEqual(tail.map((entry) => entry.iteration), [10, 11, 12])
})
