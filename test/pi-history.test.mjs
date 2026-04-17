import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { clearHarnessHistory, collectHistoryTargets } from '../src/pi-history.mjs'

async function makeTempRepo() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-'))
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

test('collectHistoryTargets includes configured harness outputs', () => {
  const cwd = '/tmp/example'
  const config = {
    cwd,
    logFile: path.join(cwd, 'pi.log'),
    telemetryJsonl: path.join(cwd, 'pi_telemetry.jsonl'),
    telemetryCsv: path.join(cwd, 'pi_telemetry.csv'),
    stateFile: path.join(cwd, '.pi-state.json'),
    sessionFile: path.join(cwd, '.pi-session-id'),
    lastAgentOutputFile: path.join(cwd, '.pi-last-output.txt'),
    lastVerificationOutputFile: path.join(cwd, '.pi-last-verification.txt'),
    changedFilesFile: path.join(cwd, '.pi-changed-files.txt'),
    lastPromptFile: path.join(cwd, '.pi-last-prompt.txt'),
    lastIterationSummaryFile: path.join(cwd, '.pi-last-iteration.json'),
    tokenUsageEventsFile: path.join(cwd, 'pi-output/token-usage/events.jsonl'),
    tokenUsageSummaryFile: path.join(cwd, 'pi-output/token-usage/summary.json'),
    piRuntimeDir: path.join(cwd, '.pi-runtime'),
    visualFeedbackFile: path.join(cwd, 'pi-output/visual-review/FEEDBACK.md'),
    testerFeedbackFile: path.join(cwd, 'pi-output/tester-feedback/FEEDBACK.md'),
    testerFeedbackHistoryDir: path.join(cwd, 'pi-output/tester-feedback/history'),
    visualReviewHistoryDir: path.join(cwd, 'pi-output/visual-review/history'),
    visualCaptureDir: path.join(cwd, 'pi-output/visual-capture'),
  }

  assert.equal(collectHistoryTargets(config).length, 18)
})

test('clearHarnessHistory removes configured state and verifies clean slate', async () => {
  const cwd = await makeTempRepo()
  const config = {
    cwd,
    logFile: path.join(cwd, 'pi.log'),
    telemetryJsonl: path.join(cwd, 'pi_telemetry.jsonl'),
    telemetryCsv: path.join(cwd, 'pi_telemetry.csv'),
    stateFile: path.join(cwd, '.pi-state.json'),
    sessionFile: path.join(cwd, '.pi-session-id'),
    lastAgentOutputFile: path.join(cwd, '.pi-last-output.txt'),
    lastVerificationOutputFile: path.join(cwd, '.pi-last-verification.txt'),
    changedFilesFile: path.join(cwd, '.pi-changed-files.txt'),
    lastPromptFile: path.join(cwd, '.pi-last-prompt.txt'),
    lastIterationSummaryFile: path.join(cwd, '.pi-last-iteration.json'),
    tokenUsageEventsFile: path.join(cwd, 'pi-output/token-usage/events.jsonl'),
    tokenUsageSummaryFile: path.join(cwd, 'pi-output/token-usage/summary.json'),
    piRuntimeDir: path.join(cwd, '.pi-runtime'),
    visualFeedbackFile: path.join(cwd, 'pi-output/visual-review/FEEDBACK.md'),
    testerFeedbackFile: path.join(cwd, 'pi-output/tester-feedback/FEEDBACK.md'),
    testerFeedbackHistoryDir: path.join(cwd, 'pi-output/tester-feedback/history'),
    visualReviewHistoryDir: path.join(cwd, 'pi-output/visual-review/history'),
    visualCaptureDir: path.join(cwd, 'pi-output/visual-capture'),
  }

  await fs.mkdir(config.piRuntimeDir, { recursive: true })
  await fs.mkdir(path.dirname(config.visualFeedbackFile), { recursive: true })
  await fs.mkdir(config.testerFeedbackHistoryDir, { recursive: true })
  await fs.writeFile(config.logFile, 'log\n', 'utf8')
  await fs.writeFile(config.stateFile, '{}\n', 'utf8')
  await fs.writeFile(path.join(config.piRuntimeDir, 'session.jsonl'), '{}\n', 'utf8')
  await fs.writeFile(config.visualFeedbackFile, 'feedback\n', 'utf8')

  const result = await clearHarnessHistory(config)

  assert.ok(result.clearedTargets.length >= 4)
  assert.equal(await exists(config.logFile), false)
  assert.equal(await exists(config.stateFile), false)
  assert.equal(await exists(config.piRuntimeDir), false)
  assert.equal(await exists(config.visualFeedbackFile), false)
})

test('clearHarnessHistory refuses to remove targets outside cwd', async () => {
  const cwd = await makeTempRepo()
  const config = {
    cwd,
    logFile: path.join(cwd, 'pi.log'),
    telemetryJsonl: path.join(cwd, 'pi_telemetry.jsonl'),
    telemetryCsv: path.join(cwd, 'pi_telemetry.csv'),
    stateFile: path.join(cwd, '.pi-state.json'),
    sessionFile: path.join(cwd, '.pi-session-id'),
    lastAgentOutputFile: path.join(cwd, '.pi-last-output.txt'),
    lastVerificationOutputFile: path.join(cwd, '.pi-last-verification.txt'),
    changedFilesFile: path.join(cwd, '.pi-changed-files.txt'),
    lastPromptFile: path.join(cwd, '.pi-last-prompt.txt'),
    lastIterationSummaryFile: path.join(cwd, '.pi-last-iteration.json'),
    tokenUsageEventsFile: path.join(cwd, 'pi-output/token-usage/events.jsonl'),
    tokenUsageSummaryFile: path.join(cwd, 'pi-output/token-usage/summary.json'),
    piRuntimeDir: path.join(cwd, '.pi-runtime'),
    visualFeedbackFile: path.join(cwd, 'pi-output/visual-review/FEEDBACK.md'),
    testerFeedbackFile: path.join(cwd, 'pi-output/tester-feedback/FEEDBACK.md'),
    testerFeedbackHistoryDir: path.join(cwd, 'pi-output/tester-feedback/history'),
    visualReviewHistoryDir: path.join(cwd, 'pi-output/visual-review/history'),
    visualCaptureDir: '/tmp/outside-visual-capture',
  }

  await assert.rejects(() => clearHarnessHistory(config), /outside the repo root/)
})
