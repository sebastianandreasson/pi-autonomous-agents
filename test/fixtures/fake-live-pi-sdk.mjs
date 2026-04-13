import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'

let nextSessionNumber = 0
let retryFailureInjected = false
let developerTurnCount = 0

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readScenario() {
  return String(process.env.PI_FAKE_LIVE_SCENARIO ?? 'default').trim() || 'default'
}

function createModelRegistry() {
  const models = [
    {
      provider: 'fake',
      id: 'fake-model',
      name: 'fake-model',
    },
  ]

  return {
    find(provider, modelId) {
      return models.find((model) => model.provider === provider && model.id === modelId)
    },
    getAll() {
      return models
    },
  }
}

export function getAgentDir() {
  return '/tmp/fake-live-pi-agent'
}

export const AuthStorage = {
  create(file) {
    return { file }
  },
}

export const ModelRegistry = {
  create() {
    return createModelRegistry()
  },
}

export const SettingsManager = {
  create() {
    return {
      applyOverrides() {},
    }
  },
}

export class DefaultResourceLoader {
  constructor(options) {
    this.options = options
  }

  async reload() {}
}

export const SessionManager = {
  create(cwd, sessionDir) {
    return { kind: 'create', cwd, sessionDir }
  },
  open(sessionFile, sessionDir) {
    return { kind: 'open', sessionFile, sessionDir }
  },
  continueRecent(cwd, sessionDir) {
    return { kind: 'continueRecent', cwd, sessionDir }
  },
}

function createTool(name, cwd) {
  return { name, cwd }
}

export const createReadTool = (cwd) => createTool('read', cwd)
export const createBashTool = (cwd) => createTool('bash', cwd)
export const createEditTool = (cwd) => createTool('edit', cwd)
export const createWriteTool = (cwd) => createTool('write', cwd)
export const createGrepTool = (cwd) => createTool('grep', cwd)
export const createFindTool = (cwd) => createTool('find', cwd)
export const createLsTool = (cwd) => createTool('ls', cwd)

async function readTodos(cwd) {
  return await fs.readFile(path.join(cwd, 'TODOS.md'), 'utf8')
}

async function markFirstTodoDone(cwd) {
  const taskFile = path.join(cwd, 'TODOS.md')
  const raw = await readTodos(cwd)
  const next = raw.replace(/- \[ \]/, '- [x]')
  await fs.writeFile(taskFile, next, 'utf8')
}

function getCurrentTask(raw) {
  const match = raw.match(/^\s*[-*]\s+\[ \]\s+(.+)$/m)
  return match?.[1]?.trim() || 'unknown task'
}

async function writeImplementationFile(cwd, taskText, phase) {
  const stamp = taskText.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'task'
  const filePath = path.join(cwd, `debug-${stamp}.txt`)
  const lines = [
    `implemented ${taskText}`,
    `scenario ${readScenario()}`,
    `phase ${phase}`,
  ]
  await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8')
  return path.basename(filePath)
}

async function appendRepairNote(cwd, taskText) {
  const stamp = taskText.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'task'
  const filePath = path.join(cwd, `debug-${stamp}.txt`)
  await fs.appendFile(filePath, 'repair note: tightened behavior after tester failure\n', 'utf8')
  return path.basename(filePath)
}

function emit(session, event) {
  session.emit(event)
}

function emitThinking(session, delta) {
  emit(session, {
    type: 'message_update',
    assistantMessageEvent: {
      type: 'thinking_delta',
      delta,
    },
  })
}

function emitText(session, delta) {
  emit(session, {
    type: 'message_update',
    assistantMessageEvent: {
      type: 'text_delta',
      delta,
    },
  })
}

function finalizeMessage(session, text, stopReason = 'stop') {
  const message = {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason,
  }
  session.messages.push(message)
  emit(session, { type: 'message_end', message })
  emit(session, { type: 'agent_end' })
}

async function streamChunks(fn, chunks, delay = 120) {
  for (const chunk of chunks) {
    fn(chunk)
    await sleep(delay)
  }
}

function buildThinkingChunks(taskText, scenario, isRepair) {
  const chunks = [
    `Reading current task: ${taskText}. `,
    isRepair ? 'Applying focused repair from tester feedback. ' : 'Planning smallest coherent change. ',
    'Preparing file edit. ',
  ]
  if (scenario === 'noisy') {
    chunks.push(
      'Scanning related files. ',
      'Checking previous output for regressions. ',
      'Comparing before and after state. ',
      'Preparing richer tool trace for UI debugging. '
    )
  }
  return chunks
}

async function emitWriteToolFlow(session, taskText, fileName, scenario, { isRepair = false } = {}) {
  emit(session, {
    type: 'tool_execution_start',
    toolName: isRepair ? 'edit' : 'write',
    args: { path: fileName },
  })

  const updates = scenario === 'noisy'
    ? [
        { progress: 'opening target file' },
        { progress: 'writing task summary block' },
        { progress: 'recording implementation details' },
        { progress: 'finalizing output artifact' },
      ]
    : [
        { progress: isRepair ? 'applying repair note' : 'creating implementation file' },
        { progress: `wrote ${fileName}` },
      ]

  for (const partialResult of updates) {
    await sleep(scenario === 'noisy' ? 90 : 150)
    emit(session, {
      type: 'tool_execution_update',
      toolName: isRepair ? 'edit' : 'write',
      args: { path: fileName, task: taskText },
      partialResult,
    })
  }

  emit(session, {
    type: 'tool_execution_end',
    toolName: isRepair ? 'edit' : 'write',
    result: { fileName, repaired: isRepair },
    isError: false,
  })
}

async function runDeveloperPrompt(session, cwd) {
  developerTurnCount += 1
  const scenario = readScenario()
  const todos = await readTodos(cwd)
  const taskText = getCurrentTask(todos)
  const isRepair = scenario === 'retry' && retryFailureInjected === true
  const phase = isRepair ? 'repair' : 'develop'

  emit(session, { type: 'agent_start' })
  await streamChunks((delta) => emitThinking(session, delta), buildThinkingChunks(taskText, scenario, isRepair), scenario === 'noisy' ? 70 : 120)

  const fileName = isRepair
    ? await appendRepairNote(cwd, taskText)
    : await writeImplementationFile(cwd, taskText, phase)

  await emitWriteToolFlow(session, taskText, fileName, scenario, { isRepair })
  if (!isRepair) {
    await markFirstTodoDone(cwd)
  }

  const chunks = scenario === 'noisy'
    ? [
        `Finished ${taskText}. `,
        `Updated TODOs and wrote ${fileName}. `,
        'Streaming extra confirmation for feed stability checks.',
      ]
    : [
        `Finished ${taskText}. `,
        isRepair ? `Applied repair note in ${fileName}.` : `Updated TODOs and wrote ${fileName}.`,
      ]

  const finalText = isRepair
    ? `Applied focused repair for ${taskText}. Updated ${fileName}.`
    : `Finished ${taskText}. Updated TODOs and wrote ${fileName}.`

  await streamChunks((delta) => emitText(session, delta), chunks, scenario === 'noisy' ? 60 : 100)
  finalizeMessage(session, finalText)
}

async function runTesterPrompt(session, cwd) {
  const scenario = readScenario()
  emit(session, { type: 'agent_start' })
  await streamChunks((delta) => emitThinking(session, delta), [
    'Reviewing changed files. ',
    'Staging task-scoped diff. ',
    scenario === 'retry' && !retryFailureInjected ? 'Injecting synthetic tester failure for repair loop. ' : 'Preparing commit. ',
  ], scenario === 'noisy' ? 70 : 120)

  if (scenario === 'retry' && !retryFailureInjected) {
    retryFailureInjected = true
    emit(session, {
      type: 'tool_execution_start',
      toolName: 'bash',
      args: { command: 'git diff --stat' },
    })
    await sleep(90)
    emit(session, {
      type: 'tool_execution_update',
      toolName: 'bash',
      args: { command: 'git diff --stat' },
      partialResult: { progress: 'detected mismatch in simulated review' },
    })
    emit(session, {
      type: 'tool_execution_end',
      toolName: 'bash',
      result: { ok: false },
      isError: true,
    })

    const failText = [
      'Observed flow:',
      '- Fake live tester found synthetic issue for repair-loop testing.',
      'Player-facing result:',
      '- FAIL.',
      'Regression check:',
      '- Re-run with focused repair.',
      'VERDICT: FAIL',
    ].join('\n')

    await streamChunks((delta) => emitText(session, delta), [
      'Tester synthetic fail injected. ',
      'Requesting focused repair pass.',
    ], 90)
    finalizeMessage(session, failText)
    return
  }

  emit(session, {
    type: 'tool_execution_start',
    toolName: 'bash',
    args: { command: 'git add . && git commit' },
  })

  const updates = scenario === 'noisy'
    ? [
        { progress: 'collecting changed files' },
        { progress: 'staging files' },
        { progress: 'writing commit message' },
        { progress: 'finalizing commit metadata' },
      ]
    : [
        { progress: 'staging files' },
      ]

  for (const partialResult of updates) {
    await sleep(scenario === 'noisy' ? 80 : 120)
    emit(session, {
      type: 'tool_execution_update',
      toolName: 'bash',
      args: { command: 'git add . && git commit' },
      partialResult,
    })
  }

  execFileSync('git', ['add', '.'], { cwd, stdio: 'ignore' })
  const commitMessage = `test(debug): fake live ${scenario} pass`
  execFileSync('git', ['commit', '-m', commitMessage], { cwd, stdio: 'ignore' })
  const commitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf8' }).trim()

  emit(session, {
    type: 'tool_execution_end',
    toolName: 'bash',
    result: { commitMessage, commitSha },
    isError: false,
  })

  const finalText = [
    'Observed flow:',
    `- Fake live tester reviewed latest task in ${scenario} scenario.`,
    'Player-facing result:',
    '- PASS.',
    'Regression check:',
    '- Smoke command passed.',
    'COMMIT_CREATED: true',
    `COMMIT_MESSAGE: ${commitMessage}`,
    `COMMIT_SHA: ${commitSha}`,
    'VERDICT: PASS',
  ].join('\n')

  await streamChunks((delta) => emitText(session, delta), scenario === 'noisy'
    ? [
        'Tester pass complete. ',
        'Creating commit metadata. ',
        'Returning PASS verdict. ',
        'Leaving extra feed traces for UI debugging.',
      ]
    : [
        'Tester pass complete. ',
        'Creating commit metadata. ',
        'Returning PASS verdict.',
      ], scenario === 'noisy' ? 60 : 100)
  finalizeMessage(session, finalText)
}

export async function createAgentSession(options) {
  nextSessionNumber += 1
  const sessionId = `fake-live-sdk-session-${nextSessionNumber}`
  const sessionFile = options.sessionManager?.sessionFile
    ?? path.join(options.sessionManager?.sessionDir ?? options.cwd ?? process.cwd(), `${sessionId}.jsonl`)

  const session = {
    sessionId,
    sessionFile,
    model: options.model ?? { provider: 'fake', id: 'fake-model', name: 'fake-model' },
    messages: [],
    _listener: null,
    subscribe(listener) {
      this._listener = listener
      return () => {
        if (this._listener === listener) {
          this._listener = null
        }
      }
    },
    emit(event) {
      this._listener?.(event)
    },
    async prompt(prompt) {
      if (String(prompt).includes('You are the TESTER role')) {
        await runTesterPrompt(this, options.cwd)
        return
      }
      await runDeveloperPrompt(this, options.cwd)
    },
    async steer() {},
    async abort() {
      const message = {
        role: 'assistant',
        content: [{ type: 'text', text: 'aborted' }],
        stopReason: 'aborted',
      }
      this.messages.push(message)
      this.emit({ type: 'message_end', message })
      this.emit({ type: 'agent_end' })
    },
    dispose() {},
  }

  return { session }
}
