#!/usr/bin/env node

import { loadConfig } from './pi-config.mjs'
import {
  appendLog,
  ensureDir,
  listChangedFiles,
  runShellCommand,
  runVisualCapture,
} from './pi-repo.mjs'

async function main() {
  const config = loadConfig('once')

  if (config.visualCaptureCommand.trim() === '') {
    throw new Error('visualCaptureCommand is empty. Set PI_VISUAL_CAPTURE_CMD or provide it in your project pi.config.json.')
  }

  if (config.visualReviewModel.trim() === '') {
    throw new Error('visualReviewModel is empty. Set PI_VISUAL_REVIEW_MODEL or provide it in your project pi.config.json.')
  }

  if (!config.visualReviewModelProfile?.baseUrl) {
    throw new Error(`No model profile/baseUrl configured for visual review model "${config.visualReviewModel}".`)
  }

  await ensureDir(config.visualReviewHistoryDir)

  const iteration = Date.now()
  const changedFiles = listChangedFiles(config.cwd)

  const capture = await runVisualCapture(config, {
    iteration,
    phase: 'manual-visual-review',
    changedFiles,
  })

  if (capture.status !== 'passed') {
    console.error(capture.output || 'Visual capture failed.')
    process.exitCode = 1
    return
  }

  const request = {
    iteration,
    phase: 'manual-visual-review',
    task: 'Manual visual review',
    changedFiles,
    screenshots: capture.screenshots,
    feedbackFile: config.visualFeedbackFile,
    model: config.visualReviewModel,
    modelProfile: config.visualReviewModelProfile,
    maxImages: config.visualReviewMaxImages,
  }

  await appendLog(config.logFile, `Starting manual visual review via: ${config.visualReviewCommand}`)
  const result = await runShellCommand({
    cwd: config.cwd,
    command: config.visualReviewCommand,
    timeoutSeconds: config.visualReviewTimeoutSeconds,
    stdinText: `${JSON.stringify(request)}\n`,
  })

  const stdout = result.stdout.trim()
  let parsed = null
  try {
    parsed = JSON.parse(stdout || '{}')
  } catch {
    parsed = null
  }

  if (result.timedOut || result.exitCode !== 0 || !parsed || parsed.status !== 'success') {
    console.error(parsed?.output || result.combinedOutput || 'Visual review failed.')
    process.exitCode = 1
    return
  }

  console.log(`Visual review verdict: ${parsed.verdict}`)
  console.log(`Feedback file: ${parsed.feedbackFile}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
