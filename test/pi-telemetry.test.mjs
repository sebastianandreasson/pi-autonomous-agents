import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { appendTelemetry, ensureTelemetryFiles } from '../src/pi-telemetry.mjs'

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
  assert.match(csv, /stop_reason/)
  assert.match(csv, /terminal_reason/)
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
    toolCalls: 3,
    toolErrors: 0,
    messageUpdates: 8,
    stopReason: 'length',
    loopDetected: false,
    loopSignature: '',
    testerVerdict: 'PASS',
    commitPlanFound: true,
    terminalReason: 'tester_pass_with_commit_plan',
    notes: 'ok',
  })

  const csv = await fs.readFile(config.telemetryCsv, 'utf8')
  assert.match(csv, /tester/)
  assert.match(csv, /local\/tester/)
  assert.match(csv, /tester_pass_with_commit_plan/)
  assert.match(csv, /run-1/)

  const runCsv = await fs.readFile(config.runTelemetryCsv, 'utf8')
  assert.match(runCsv, /run-1/)
})
