import fs from 'node:fs/promises'
import path from 'node:path'

function unique(values) {
  return [...new Set(values)]
}

function isWithinCwd(cwd, targetPath) {
  const relativePath = path.relative(cwd, targetPath)
  return relativePath !== '' && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
}

export function collectHistoryTargets(config) {
  return unique([
    config.logFile,
    config.telemetryJsonl,
    config.telemetryCsv,
    config.stateFile,
    config.sessionFile,
    config.lastAgentOutputFile,
    config.lastVerificationOutputFile,
    config.changedFilesFile,
    config.lastPromptFile,
    config.lastIterationSummaryFile,
    config.piRuntimeDir,
    config.visualFeedbackFile,
    config.testerFeedbackFile,
    config.testerFeedbackHistoryDir,
    config.visualReviewHistoryDir,
    config.visualCaptureDir,
  ].map((value) => String(value ?? '').trim()).filter(Boolean))
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

function validateHistoryTargets(config, targets) {
  const invalidTargets = targets.filter((targetPath) => {
    if (!path.isAbsolute(targetPath)) {
      return true
    }
    if (targetPath === config.cwd || targetPath === path.parse(targetPath).root) {
      return true
    }
    return !isWithinCwd(config.cwd, targetPath)
  })

  if (invalidTargets.length > 0) {
    throw new Error(
      `Refusing to clear history outside the repo root. Invalid targets: ${invalidTargets.join(', ')}`
    )
  }
}

export async function clearHarnessHistory(config) {
  const targets = collectHistoryTargets(config)
  validateHistoryTargets(config, targets)

  const existingTargets = []
  for (const targetPath of targets) {
    if (await pathExists(targetPath)) {
      existingTargets.push(targetPath)
    }
  }

  for (const targetPath of [...existingTargets].sort((left, right) => right.length - left.length)) {
    await fs.rm(targetPath, { recursive: true, force: true })
  }

  const remainingTargets = []
  for (const targetPath of targets) {
    if (await pathExists(targetPath)) {
      remainingTargets.push(targetPath)
    }
  }

  if (remainingTargets.length > 0) {
    throw new Error(`Failed to clear harness history for: ${remainingTargets.join(', ')}`)
  }

  return {
    targets,
    clearedTargets: existingTargets,
    remainingTargets,
  }
}
