import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

let nextSessionNumber = 0

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
  const taskFile = path.join(cwd, 'TODOS.md')
  return await fs.readFile(taskFile, 'utf8')
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

async function writeImplementationFile(cwd, taskText) {
  const stamp = taskText.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'task'
  const filePath = path.join(cwd, `debug-${stamp}.txt`)
  await fs.writeFile(filePath, `implemented ${taskText}\n`, 'utf8')
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

function finalizeMessage(session, text) {
  const message = {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
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

async function runDeveloperPrompt(session, cwd) {
  const todos = await readTodos(cwd)
  const taskText = getCurrentTask(todos)
  emit(session, { type: 'agent_start' })
  await streamChunks((delta) => emitThinking(session, delta), [
    `Reading current task: ${taskText}. `,
    'Planning smallest coherent change. ',
    'Preparing file edit. ',
  ])

  emit(session, {
    type: 'tool_execution_start',
    toolName: 'write',
    args: { path: `${taskText}.txt` },
  })
  await sleep(150)
  emit(session, {
    type: 'tool_execution_update',
    toolName: 'write',
    args: { path: `${taskText}.txt` },
    partialResult: { progress: 'creating implementation file' },
  })
  const fileName = await writeImplementationFile(cwd, taskText)
  await sleep(150)
  emit(session, {
    type: 'tool_execution_update',
    toolName: 'write',
    args: { path: fileName },
    partialResult: { progress: `wrote ${fileName}` },
  })
  await markFirstTodoDone(cwd)
  emit(session, {
    type: 'tool_execution_end',
    toolName: 'write',
    result: { fileName },
    isError: false,
  })

  await streamChunks((delta) => emitText(session, delta), [
    `Finished ${taskText}. `,
    `Updated TODOs and wrote ${fileName}.`,
  ], 100)
  finalizeMessage(session, `Finished ${taskText}. Updated TODOs and wrote ${fileName}.`)
}

async function runTesterPrompt(session, cwd) {
  emit(session, { type: 'agent_start' })
  await streamChunks((delta) => emitThinking(session, delta), [
    'Reviewing changed files. ',
    'Staging task-scoped diff. ',
    'Preparing commit. ',
  ])

  emit(session, {
    type: 'tool_execution_start',
    toolName: 'bash',
    args: { command: 'git add . && git commit' },
  })
  await sleep(120)
  emit(session, {
    type: 'tool_execution_update',
    toolName: 'bash',
    args: { command: 'git add . && git commit' },
    partialResult: { progress: 'staging files' },
  })
  execFileSync('git', ['add', '.'], { cwd, stdio: 'ignore' })
  const commitMessage = 'test(debug): fake live agent pass'
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
    '- Fake live tester reviewed latest task.',
    'Player-facing result:',
    '- PASS.',
    'Regression check:',
    '- Smoke command passed.',
    'COMMIT_CREATED: true',
    `COMMIT_MESSAGE: ${commitMessage}`,
    `COMMIT_SHA: ${commitSha}`,
    'VERDICT: PASS',
  ].join('\n')

  await streamChunks((delta) => emitText(session, delta), [
    'Tester pass complete. ',
    'Creating commit metadata. ',
    'Returning PASS verdict.',
  ], 100)
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
