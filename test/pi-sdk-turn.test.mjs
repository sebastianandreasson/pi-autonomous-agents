import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  createSdkSession,
  createTools,
  normalizeToolNames,
  resolveModel,
  runSdkTurnWithPi,
  splitModelSpec,
} from '../src/pi-sdk-turn.mjs'

function createFakePi({
  models = [
    { provider: 'local', id: 'dev-model', name: 'Local Dev Model' },
  ],
  promptImpl,
} = {}) {
  const toolCalls = []
  let appliedOverrides = null

  class DefaultResourceLoader {
    constructor(options) {
      this.options = options
    }

    async reload() {}
  }

  const modelRegistry = {
    find(provider, modelId) {
      return models.find((model) => model.provider === provider && model.id === modelId)
    },
    getAll() {
      return models
    },
  }

  const session = {
    sessionId: 'sdk-session-1',
    sessionFile: '/tmp/sdk-session-1.jsonl',
    model: models[0],
    messages: [],
    _listener: null,
    _disposed: false,
    _aborts: 0,
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
      if (promptImpl) {
        await promptImpl(this, prompt)
        return
      }

      this.emit({ type: 'agent_start' })
      this.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'done' },
      })
      const message = {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'stop',
      }
      this.messages.push(message)
      this.emit({ type: 'message_end', message })
      this.emit({ type: 'agent_end' })
    },
    async steer() {},
    async abort() {
      this._aborts += 1
    },
    dispose() {
      this._disposed = true
    },
  }

  return {
    getAgentDir() {
      return '/tmp/pi-agent'
    },
    AuthStorage: {
      create(file) {
        return { file }
      },
    },
    ModelRegistry: {
      create() {
        return modelRegistry
      },
    },
    SettingsManager: {
      create() {
        return {
          applyOverrides(overrides) {
            appliedOverrides = overrides
          },
        }
      },
    },
    DefaultResourceLoader,
    SessionManager: {
      create(cwd, sessionDir) {
        return { kind: 'create', cwd, sessionDir }
      },
      open(sessionFile, sessionDir) {
        return { kind: 'open', sessionFile, sessionDir }
      },
      continueRecent(cwd, sessionDir) {
        return { kind: 'continueRecent', cwd, sessionDir }
      },
    },
    createReadTool(cwd) {
      toolCalls.push(['read', cwd])
      return { name: 'read', cwd }
    },
    createBashTool(cwd) {
      toolCalls.push(['bash', cwd])
      return { name: 'bash', cwd }
    },
    createEditTool(cwd) {
      toolCalls.push(['edit', cwd])
      return { name: 'edit', cwd }
    },
    createWriteTool(cwd) {
      toolCalls.push(['write', cwd])
      return { name: 'write', cwd }
    },
    createGrepTool(cwd) {
      toolCalls.push(['grep', cwd])
      return { name: 'grep', cwd }
    },
    createFindTool(cwd) {
      toolCalls.push(['find', cwd])
      return { name: 'find', cwd }
    },
    createLsTool(cwd) {
      toolCalls.push(['ls', cwd])
      return { name: 'ls', cwd }
    },
    async createAgentSession(options) {
      session.model = options.model ?? session.model
      return { session }
    },
    _session: session,
    _toolCalls: toolCalls,
    _getAppliedOverrides() {
      return appliedOverrides
    },
  }
}

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sdk-turn-'))
}

test('splitModelSpec extracts optional thinking suffix', () => {
  assert.deepEqual(splitModelSpec('openai/gpt-4o:high'), {
    modelName: 'openai/gpt-4o',
    thinkingLevel: 'high',
  })
  assert.deepEqual(splitModelSpec('local/model:weird'), {
    modelName: 'local/model:weird',
    thinkingLevel: '',
  })
})

test('normalizeToolNames trims and de-duplicates tool list', () => {
  assert.deepEqual(normalizeToolNames('read, bash,read, edit ,, bash'), ['read', 'bash', 'edit'])
})

test('createTools maps requested tool names to cwd-bound tool factories', () => {
  const pi = createFakePi()
  const tools = createTools(pi, '/repo', 'read,bash,edit')
  assert.deepEqual(tools, [
    { name: 'read', cwd: '/repo' },
    { name: 'bash', cwd: '/repo' },
    { name: 'edit', cwd: '/repo' },
  ])
  assert.deepEqual(pi._toolCalls, [
    ['read', '/repo'],
    ['bash', '/repo'],
    ['edit', '/repo'],
  ])
})

test('resolveModel finds provider-prefixed and ambiguous shorthand models', async () => {
  const registry = {
    find(provider, modelId) {
      return provider === 'local' && modelId === 'dev-model'
        ? { provider: 'local', id: 'dev-model', name: 'Local Dev Model' }
        : undefined
    },
    getAll() {
      return [
        { provider: 'local', id: 'dev-model', name: 'Local Dev Model' },
        { provider: 'other', id: 'dev-model', name: 'Other Dev Model' },
      ]
    },
  }

  const resolved = await resolveModel(registry, 'local/dev-model:medium')
  assert.equal(resolved.provider, 'local')
  await assert.rejects(() => resolveModel(registry, 'dev-model'), /ambiguous/)
})

test('createSdkSession auto-installs managed request telemetry extension by default', async () => {
  const pi = createFakePi()
  const cwd = await makeTempDir()

  await createSdkSession(pi, {
    cwd,
    runtimeDir: path.join(cwd, '.pi-runtime'),
    model: 'local/dev-model',
    tools: 'read',
    noThemes: true,
  })

  const shimFile = path.join(cwd, '.pi', 'extensions', 'pi-harness-request-telemetry', 'index.mjs')
  const manifestFile = path.join(cwd, '.pi', 'extensions', 'pi-harness-request-telemetry', 'package.json')
  const shim = await fs.readFile(shimFile, 'utf8')
  assert.match(shim, /request telemetry extension/i)
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'))
  assert.deepEqual(manifest.pi?.extensions, ['./index.mjs'])
})

test('createSdkSession removes managed request telemetry extension when disabled', async () => {
  const pi = createFakePi()
  const cwd = await makeTempDir()
  const shimDir = path.join(cwd, '.pi', 'extensions', 'pi-harness-request-telemetry')
  await fs.mkdir(shimDir, { recursive: true })
  await fs.writeFile(path.join(shimDir, 'index.mjs'), 'stale\n', 'utf8')

  await createSdkSession(pi, {
    cwd,
    runtimeDir: path.join(cwd, '.pi-runtime'),
    model: 'local/dev-model',
    tools: 'read',
    requestTelemetryEnabled: false,
    noThemes: true,
  })

  await assert.rejects(() => fs.access(shimDir))
})

test('runSdkTurnWithPi returns successful structured result', async () => {
  const pi = createFakePi({
    promptImpl: async (session) => {
      session.emit({ type: 'agent_start' })
      session.emit({
        type: 'tool_execution_start',
        toolName: 'read',
        args: { path: 'src/file.js' },
      })
      session.emit({
        type: 'tool_execution_end',
        toolName: 'read',
        isError: false,
      })
      session.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'done' },
      })
      session.emit({
        type: 'token_usage',
        inputTokens: 120,
        outputTokens: 45,
        totalTokens: 165,
        cacheReadTokens: 10,
        cacheWriteTokens: 0,
      })
      const message = {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'stop',
      }
      session.messages.push(message)
      session.emit({ type: 'message_end', message })
      session.emit({ type: 'agent_end' })
    },
  })

  const result = await runSdkTurnWithPi(pi, {
    cwd: '/repo',
    runtimeDir: '/repo/.pi-runtime/run-1',
    prompt: 'do work',
    model: 'local/dev-model:off',
    tools: 'read,bash',
    requestTelemetryEnabled: false,
    noThemes: true,
  })

  assert.equal(result.status, 'success')
  assert.equal(result.output, 'done')
  assert.equal(result.toolCalls, 1)
  assert.equal(result.toolErrors, 0)
  assert.equal(result.messageUpdates, 1)
  assert.equal(result.inputTokens, 120)
  assert.equal(result.outputTokens, 45)
  assert.equal(result.totalTokens, 165)
  assert.equal(result.cacheReadTokens, 10)
  assert.equal(result.cacheWriteTokens, 0)
  assert.equal(result.terminalReason, 'agent_completed')
  assert.match(result.notes, /tokens_total=165/)
  assert.match(result.notes, /PI session sdk-session-1/)
  assert.deepEqual(pi._getAppliedOverrides(), { retry: { enabled: false } })
  assert.equal(pi._session._disposed, true)
})

test('runSdkTurnWithPi marks repeated tool churn as stalled and aborts session', async () => {
  const pi = createFakePi({
    promptImpl: async (session) => {
      session.emit({ type: 'agent_start' })
      session.emit({
        type: 'tool_execution_start',
        toolName: 'read',
        args: { path: 'src/file.js' },
      })
      session.emit({
        type: 'tool_execution_start',
        toolName: 'read',
        args: { path: 'src/file.js' },
      })
      const message = {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial' }],
        stopReason: 'aborted',
      }
      session.messages.push(message)
      session.emit({ type: 'message_end', message })
      session.emit({ type: 'agent_end' })
    },
  })

  const result = await runSdkTurnWithPi(pi, {
    cwd: '/repo',
    runtimeDir: '/repo/.pi-runtime/run-1',
    prompt: 'do work',
    model: 'local/dev-model',
    tools: 'read',
    requestTelemetryEnabled: false,
    loopRepeatThreshold: 2,
    samePathRepeatThreshold: 2,
    noThemes: true,
  })

  assert.equal(result.status, 'stalled')
  assert.equal(result.terminalReason, 'loop_detected')
  assert.equal(result.loopDetected, true)
  assert.equal(result.loopSignature, 'read {"path":"src/file.js"}')
  assert.equal(pi._session._aborts, 1)
})

test('runSdkTurnWithPi falls back to assistant message usage when token_usage events are absent', async () => {
  const liveEvents = []
  const pi = createFakePi({
    promptImpl: async (session) => {
      session.emit({ type: 'agent_start' })
      session.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'done' },
      })
      const message = {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'stop',
        usage: {
          inputTokens: 77,
          outputTokens: 23,
          totalTokens: 100,
          cacheReadTokens: 5,
          cacheWriteTokens: 0,
        },
      }
      session.messages.push(message)
      session.emit({ type: 'message_end', message })
      session.emit({ type: 'agent_end' })
    },
  })

  const result = await runSdkTurnWithPi(pi, {
    cwd: '/repo',
    runtimeDir: '/repo/.pi-runtime/run-1',
    prompt: 'do work',
    model: 'local/dev-model',
    tools: 'read',
    requestTelemetryEnabled: false,
    noThemes: true,
    onLiveEvent(event) {
      liveEvents.push(event)
    },
  })

  assert.equal(result.inputTokens, 77)
  assert.equal(result.outputTokens, 23)
  assert.equal(result.totalTokens, 100)
  assert.equal(result.cacheReadTokens, 5)
  assert.equal(result.cacheWriteTokens, 0)
  assert.equal(liveEvents.filter((event) => event.type === 'token_usage').length, 1)
  assert.equal(liveEvents.find((event) => event.type === 'token_usage')?.totalTokens, 100)
  assert.equal(liveEvents.find((event) => event.type === 'token_usage')?.attributionKind, 'turn_fallback')
  assert.deepEqual(liveEvents.find((event) => event.type === 'token_usage')?.toolNames ?? [], [])
  assert.deepEqual(liveEvents.find((event) => event.type === 'token_usage')?.files ?? [], [])
})
