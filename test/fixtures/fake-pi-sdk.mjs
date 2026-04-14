import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

let nextSessionNumber = 0

function getScenario() {
  return String(process.env.FAKE_PI_SDK_SCENARIO ?? '').trim()
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
  return '/tmp/fake-pi-agent'
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

async function markTodoDone(cwd) {
  const taskFile = path.join(cwd, 'TODOS.md')
  const raw = await fs.readFile(taskFile, 'utf8')
  const next = raw.replace('- [ ]', '- [x]')
  await fs.writeFile(taskFile, next, 'utf8')
}

async function writeImplementationFile(cwd) {
  await fs.writeFile(path.join(cwd, 'sdk-implemented.txt'), 'implemented by fake sdk\n', 'utf8')
}

async function appendTesterMutation(cwd) {
  await fs.appendFile(path.join(cwd, 'sdk-implemented.txt'), 'tester mutation\n', 'utf8')
}

function emitText(session, text) {
  session.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'text_delta',
      delta: text,
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
  session.emit({ type: 'message_end', message })
  session.emit({ type: 'agent_end' })
}

async function runDeveloperPrompt(session, cwd) {
  session.emit({ type: 'agent_start' })
  session.emit({
    type: 'tool_execution_start',
    toolName: 'write',
    args: { path: 'sdk-implemented.txt' },
  })
  await writeImplementationFile(cwd)
  await markTodoDone(cwd)
  session.emit({
    type: 'tool_execution_end',
    toolName: 'write',
    isError: false,
  })
  const text = 'Implemented current task.'
  emitText(session, text)
  finalizeMessage(session, text)
}

async function runTesterPrompt(session, cwd) {
  session.emit({ type: 'agent_start' })
  const scenario = getScenario()

  if (scenario === 'pass_dirty_no_commit') {
    execFileSync('git', ['add', 'TODOS.md', 'sdk-implemented.txt'], { cwd, stdio: 'ignore' })
    const text = [
      'Observed flow:',
      '- Verified fake sdk change.',
      'Player-facing result:',
      '- PASS.',
      'Regression check:',
      '- Smoke command passed.',
      'VERDICT: PASS',
    ].join('\n')
    emitText(session, text)
    finalizeMessage(session, text)
    return
  }

  if (scenario === 'edit_pass_no_commit') {
    await appendTesterMutation(cwd)
    const text = [
      'Observed flow:',
      '- Verified fake sdk change.',
      'Player-facing result:',
      '- PASS.',
      'Regression check:',
      '- Smoke command passed after tester edit.',
      'VERDICT: PASS',
    ].join('\n')
    emitText(session, text)
    finalizeMessage(session, text)
    return
  }

  execFileSync('git', ['add', 'TODOS.md', 'sdk-implemented.txt'], { cwd, stdio: 'ignore' })
  const commitMessage = 'test(harness): complete sdk flow'
  execFileSync('git', ['commit', '-m', commitMessage], { cwd, stdio: 'ignore' })
  const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
  const text = [
    'Observed flow:',
    '- Verified fake sdk change.',
    'Player-facing result:',
    '- PASS.',
    'Regression check:',
    '- Smoke command passed.',
    'COMMIT_CREATED: true',
    `COMMIT_MESSAGE: ${commitMessage}`,
    `COMMIT_SHA: ${commitSha}`,
    'VERDICT: PASS',
  ].join('\n')
  emitText(session, text)
  finalizeMessage(session, text)
}

async function runTesterCommitPrompt(session) {
  session.emit({ type: 'agent_start' })
  const commitMessage = 'test(harness): complete sdk flow'
  const text = [
    `COMMIT_MESSAGE: ${commitMessage}`,
    'COMMIT_FILES:',
    'TODOS.md',
    'sdk-implemented.txt',
    'VERDICT: PASS',
  ].join('\n')
  emitText(session, text)
  finalizeMessage(session, text)
}

export async function createAgentSession(options) {
  nextSessionNumber += 1
  const sessionId = `fake-sdk-session-${nextSessionNumber}`
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
      const promptText = String(prompt)
      if (promptText.includes('The implementation already passed functional review, but the final commit was not created.')) {
        await runTesterCommitPrompt(this, options.cwd)
        return
      }

      if (promptText.includes('You are the TESTER role')) {
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
