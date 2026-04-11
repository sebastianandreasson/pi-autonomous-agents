import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(scriptDir, '..')
const bundledConfigFile = path.join(packageRoot, 'pi.config.json')

function hasValue(value) {
  return value !== undefined && value !== null && value !== ''
}

function normalizeString(value, fallback) {
  return hasValue(value) ? String(value) : fallback
}

function readString(name, fileValue, fallback) {
  const value = process.env[name]
  if (value !== undefined) {
    return value
  }
  return normalizeString(fileValue, fallback)
}

function normalizeInt(name, raw, fallback) {
  if (!hasValue(raw)) {
    return fallback
  }

  const value = Number.parseInt(String(raw), 10)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Expected ${name} to be a non-negative integer, received "${raw}"`)
  }

  return value
}

function readInt(name, fileValue, fallback) {
  const raw = process.env[name]
  if (raw !== undefined && raw !== '') {
    return normalizeInt(name, raw, fallback)
  }
  return normalizeInt(name, fileValue, fallback)
}

function normalizeBool(name, raw, fallback) {
  if (!hasValue(raw)) {
    return fallback
  }

  if (typeof raw === 'boolean') {
    return raw
  }

  const normalized = String(raw).toLowerCase()
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') {
    return true
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no') {
    return false
  }

  throw new Error(`Expected ${name} to be a boolean flag, received "${raw}"`)
}

function readBool(name, fileValue, fallback) {
  const raw = process.env[name]
  if (raw !== undefined && raw !== '') {
    return normalizeBool(name, raw, fallback)
  }
  return normalizeBool(name, fileValue, fallback)
}

function readRepoConfig(cwd) {
  const configFallback = fs.existsSync(bundledConfigFile) ? bundledConfigFile : 'pi.config.json'
  const configFile = path.resolve(cwd, normalizeString(process.env.PI_CONFIG_FILE, configFallback))

  if (!fs.existsSync(configFile)) {
    return {
      configFile,
      values: {},
    }
  }

  const raw = fs.readFileSync(configFile, 'utf8')
  const parsed = JSON.parse(raw)

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected ${configFile} to contain a JSON object.`)
  }

  return {
    configFile,
    values: parsed,
  }
}

function resolveFromCwd(cwd, name, fileValue, fallback) {
  return path.resolve(cwd, readString(name, fileValue, fallback))
}

function resolveInstructionsFile(cwd, envName, fileValue, fallback) {
  if (!hasValue(fileValue) && process.env[envName] === undefined) {
    return path.resolve(cwd, fallback)
  }
  return resolveFromCwd(cwd, envName, fileValue, fallback)
}

function readObject(name, raw, fallback) {
  const value = raw === undefined ? fallback : raw
  if (value === undefined || value === null) {
    return fallback
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected ${name} to be an object.`)
  }
  return value
}

function normalizeRoleModels(raw) {
  const value = readObject('roleModels', raw, {})
  const normalized = {}
  for (const [role, modelName] of Object.entries(value)) {
    if (!hasValue(modelName)) {
      continue
    }
    normalized[String(role)] = String(modelName)
  }
  return normalized
}

function normalizeCommitMode(raw) {
  const value = normalizeString(raw, 'agent').trim().toLowerCase()
  if (value === 'agent' || value === 'plan') {
    return value
  }
  throw new Error(`Expected commitMode to be "agent" or "plan", received "${raw}"`)
}

function normalizePromptMode(raw) {
  const value = normalizeString(raw, 'compact').trim().toLowerCase()
  if (value === 'compact' || value === 'full') {
    return value
  }
  throw new Error(`Expected promptMode to be "compact" or "full", received "${raw}"`)
}

function resolveModelProfile(modelProfiles, modelName) {
  if (!modelName || typeof modelName !== 'string') {
    return null
  }

  const profile = modelProfiles[modelName]
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return null
  }

  const apiKey = hasValue(profile.apiKey)
    ? String(profile.apiKey)
    : hasValue(profile.apiKeyEnv) && process.env[String(profile.apiKeyEnv)] !== undefined
      ? String(process.env[String(profile.apiKeyEnv)])
      : ''

  return {
    name: modelName,
    baseUrl: normalizeString(profile.baseUrl, ''),
    apiKey,
    apiKeyEnv: normalizeString(profile.apiKeyEnv, ''),
    vision: normalizeBool(`${modelName}.vision`, profile.vision, false),
  }
}

export function resolveRoleModelName(config, role) {
  const roleName = String(role ?? '').trim()
  if (roleName !== '' && hasValue(config?.roleModels?.[roleName])) {
    return String(config.roleModels[roleName])
  }

  if (roleName === 'visualReview') {
    return String(config?.visualReviewModel ?? '')
  }

  return String(config?.piModel ?? '')
}

export function resolveRoleModel(config, role) {
  const model = resolveRoleModelName(config, role)
  return {
    model,
    modelProfile: resolveModelProfile(config?.modelProfiles ?? {}, model),
  }
}

export function loadConfig(mode = 'once') {
  const cwd = process.cwd()
  const repoConfig = readRepoConfig(cwd)
  const file = repoConfig.values
  const bundledAdapterCommand = 'pi-harness adapter'
  const bundledDeveloperInstructionsFile = path.join(packageRoot, 'templates', 'DEVELOPER.md')
  const bundledTesterInstructionsFile = path.join(packageRoot, 'templates', 'TESTER.md')
  const modelProfiles = readObject('models', file.models, {})
  const roleModels = normalizeRoleModels(file.roleModels)
  const piModel = readString('PI_MODEL', file.piModel, '')
  const visualReviewModel = readString('PI_VISUAL_REVIEW_MODEL', file.visualReviewModel, '')
  const resolvedPiModel = resolveModelProfile(modelProfiles, piModel)
  const resolvedVisualReviewModel = resolveModelProfile(modelProfiles, visualReviewModel)
  const developerInstructionsFile = resolveInstructionsFile(
    cwd,
    'PI_DEVELOPER_INSTRUCTIONS_FILE',
    file.developerInstructionsFile,
    hasValue(file.instructionsFile)
      ? String(file.instructionsFile)
      : bundledDeveloperInstructionsFile
  )
  const testerInstructionsFile = resolveInstructionsFile(
    cwd,
    'PI_TESTER_INSTRUCTIONS_FILE',
    file.testerInstructionsFile,
    hasValue(file.instructionsFile)
      ? String(file.instructionsFile)
      : bundledTesterInstructionsFile
  )

  return {
    cwd,
    configFile: repoConfig.configFile,
    mode: mode === 'run' ? 'run' : 'once',
    transport: readString('PI_TRANSPORT', file.transport, 'adapter'),
    agentName: readString('PI_AGENT_NAME', file.agentName, 'PI'),
    adapterCommand: readString('PI_ADAPTER_COMMAND', file.adapterCommand, bundledAdapterCommand),
    taskFile: resolveFromCwd(cwd, 'PI_TASK_FILE', file.taskFile, 'TODOS.md'),
    instructionsFile: resolveInstructionsFile(cwd, 'PI_INSTRUCTIONS_FILE', file.instructionsFile, bundledDeveloperInstructionsFile),
    developerInstructionsFile,
    testerInstructionsFile,
    usingBundledDeveloperInstructions: developerInstructionsFile === bundledDeveloperInstructionsFile,
    usingBundledTesterInstructions: testerInstructionsFile === bundledTesterInstructionsFile,
    logFile: resolveFromCwd(cwd, 'PI_LOG_FILE', file.logFile, 'pi.log'),
    telemetryJsonl: resolveFromCwd(cwd, 'PI_TELEMETRY_JSONL', file.telemetryJsonl, 'pi_telemetry.jsonl'),
    telemetryCsv: resolveFromCwd(cwd, 'PI_TELEMETRY_CSV', file.telemetryCsv, 'pi_telemetry.csv'),
    stateFile: resolveFromCwd(cwd, 'PI_STATE_FILE', file.stateFile, '.pi-state.json'),
    sessionFile: resolveFromCwd(cwd, 'PI_SESSION_FILE', file.sessionFile, '.pi-session-id'),
    lastAgentOutputFile: resolveFromCwd(cwd, 'PI_LAST_AGENT_OUTPUT_FILE', file.lastAgentOutputFile, '.pi-last-output.txt'),
    lastVerificationOutputFile: resolveFromCwd(cwd, 'PI_LAST_VERIFICATION_OUTPUT_FILE', file.lastVerificationOutputFile, '.pi-last-verification.txt'),
    changedFilesFile: resolveFromCwd(cwd, 'PI_CHANGED_FILES_FILE', file.changedFilesFile, '.pi-changed-files.txt'),
    lastPromptFile: resolveFromCwd(cwd, 'PI_LAST_PROMPT_FILE', file.lastPromptFile, '.pi-last-prompt.txt'),
    lastIterationSummaryFile: resolveFromCwd(cwd, 'PI_LAST_ITERATION_SUMMARY_FILE', file.lastIterationSummaryFile, '.pi-last-iteration.json'),
    piRuntimeDir: resolveFromCwd(cwd, 'PI_RUNTIME_DIR', file.piRuntimeDir, '.pi-runtime'),
    piCli: readString('PI_CLI', file.piCli, 'pi'),
    piModel,
    piModelProfile: resolvedPiModel,
    modelProfiles,
    roleModels,
    commitMode: normalizeCommitMode(readString('PI_COMMIT_MODE', file.commitMode, 'agent')),
    promptMode: normalizePromptMode(readString('PI_PROMPT_MODE', file.promptMode, 'compact')),
    maxPromptChangedFiles: readInt('PI_MAX_PROMPT_CHANGED_FILES', file.maxPromptChangedFiles, 10),
    maxVisualFeedbackLines: readInt('PI_MAX_VISUAL_FEEDBACK_LINES', file.maxVisualFeedbackLines, 20),
    maxTesterFeedbackLines: readInt('PI_MAX_TESTER_FEEDBACK_LINES', file.maxTesterFeedbackLines, 32),
    maxPromptNotesLines: readInt('PI_MAX_PROMPT_NOTES_LINES', file.maxPromptNotesLines, 16),
    maxVerificationExcerptLines: readInt('PI_MAX_VERIFICATION_EXCERPT_LINES', file.maxVerificationExcerptLines, 40),
    piTools: readString('PI_TOOLS', file.piTools, 'read,bash,edit,write,grep,find,ls'),
    piThinking: readString('PI_THINKING', file.piThinking, ''),
    piNoExtensions: readBool('PI_NO_EXTENSIONS', file.piNoExtensions, false),
    piNoSkills: readBool('PI_NO_SKILLS', file.piNoSkills, false),
    piNoPromptTemplates: readBool('PI_NO_PROMPT_TEMPLATES', file.piNoPromptTemplates, false),
    piNoThemes: readBool('PI_NO_THEMES', file.piNoThemes, true),
    streamTerminal: readBool('PI_STREAM_TERMINAL', file.streamTerminal, false),
    loopRepeatThreshold: readInt('PI_LOOP_REPEAT_THRESHOLD', file.loopRepeatThreshold, 12),
    samePathRepeatThreshold: readInt('PI_SAME_PATH_REPEAT_THRESHOLD', file.samePathRepeatThreshold, 8),
    continueAfterSeconds: readInt('PI_CONTINUE_AFTER', file.continueAfterSeconds, 300),
    continueMessage: readString('PI_CONTINUE_MESSAGE', file.continueMessage, 'continue'),
    noEventTimeoutSeconds: readInt('PI_NO_EVENT_TIMEOUT', file.noEventTimeoutSeconds, 900),
    toolContinueAfterSeconds: readInt('PI_TOOL_CONTINUE_AFTER', file.toolContinueAfterSeconds, 900),
    toolNoEventTimeoutSeconds: readInt('PI_TOOL_NO_EVENT_TIMEOUT', file.toolNoEventTimeoutSeconds, 1800),
    testCommand: readString('PI_TEST_CMD', file.testCommand, ''),
    agentTimeoutSeconds: readInt('PI_AGENT_TIMEOUT', file.agentTimeoutSeconds, 3600),
    verificationTimeoutSeconds: readInt('PI_VERIFICATION_TIMEOUT', file.verificationTimeoutSeconds, 300),
    idleRetryLimit: readInt('PI_IDLE_RETRY_LIMIT', file.idleRetryLimit, 1),
    noChangeRetryLimit: readInt('PI_NO_CHANGE_RETRY_LIMIT', file.noChangeRetryLimit, 1),
    visualFeedbackFile: resolveFromCwd(
      cwd,
      'PI_VISUAL_FEEDBACK_FILE',
      file.visualFeedbackFile,
      'pi-output/visual-review/FEEDBACK.md'
    ),
    testerFeedbackFile: resolveFromCwd(
      cwd,
      'PI_TESTER_FEEDBACK_FILE',
      file.testerFeedbackFile,
      'pi-output/tester-feedback/FEEDBACK.md'
    ),
    testerFeedbackHistoryDir: resolveFromCwd(
      cwd,
      'PI_TESTER_FEEDBACK_HISTORY_DIR',
      file.testerFeedbackHistoryDir,
      'pi-output/tester-feedback/history'
    ),
    visualReviewHistoryDir: resolveFromCwd(
      cwd,
      'PI_VISUAL_REVIEW_HISTORY_DIR',
      file.visualReviewHistoryDir,
      'pi-output/visual-review/history'
    ),
    visualCaptureDir: resolveFromCwd(
      cwd,
      'PI_VISUAL_CAPTURE_DIR',
      file.visualCaptureDir,
      'pi-output/visual-capture'
    ),
    visualCaptureCommand: readString('PI_VISUAL_CAPTURE_CMD', file.visualCaptureCommand, ''),
    visualCaptureTimeoutSeconds: readInt('PI_VISUAL_CAPTURE_TIMEOUT', file.visualCaptureTimeoutSeconds, 300),
    visualReviewEnabled: readBool('PI_VISUAL_REVIEW_ENABLED', file.visualReviewEnabled, false),
    visualReviewEveryNSuccesses: readInt('PI_VISUAL_REVIEW_EVERY', file.visualReviewEveryNSuccesses, 5),
    visualReviewModel,
    visualReviewModelProfile: resolvedVisualReviewModel,
    visualReviewCommand: readString(
      'PI_VISUAL_REVIEW_COMMAND',
      file.visualReviewCommand,
      'pi-harness visual-review-worker'
    ),
    visualReviewMaxImages: readInt('PI_VISUAL_REVIEW_MAX_IMAGES', file.visualReviewMaxImages, 8),
    visualReviewTimeoutSeconds: readInt('PI_VISUAL_REVIEW_TIMEOUT', file.visualReviewTimeoutSeconds, 300),
    maxIterations: readInt('PI_MAX_ITERS', file.maxIterations, 200),
    sleepBetweenSeconds: readInt('PI_SLEEP_BETWEEN', file.sleepBetweenSeconds, 2),
    reportLimit: readInt('PI_REPORT_LIMIT', file.reportLimit, 20),
  }
}
