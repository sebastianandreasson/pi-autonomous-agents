#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(scriptDir, '..')
const cliFile = path.join(scriptDir, 'cli.mjs')
const fakePiFile = path.join(packageRoot, 'test', 'fixtures', 'fake-pi.mjs')
const fakeLiveSdkFile = path.join(packageRoot, 'test', 'fixtures', 'fake-live-pi-sdk.mjs')
const sandboxDir = path.join(packageRoot, '.pi-debug', 'live-ui')
const DEFAULT_TASK_COUNT = 12

function shellQuote(value) {
  return JSON.stringify(String(value))
}

function readFlagValue(flag) {
  const index = process.argv.indexOf(flag)
  if (index === -1) {
    return ''
  }
  return String(process.argv[index + 1] ?? '').trim()
}

function readScenario() {
  const value = readFlagValue('--scenario') || process.env.PI_FAKE_LIVE_SCENARIO || 'default'
  return String(value).trim() || 'default'
}

function readTaskCount() {
  const raw = Number.parseInt(readFlagValue('--task-count') || process.env.PI_DEBUG_TASK_COUNT || `${DEFAULT_TASK_COUNT}`, 10)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TASK_COUNT
}

function buildTodoLines(taskCount) {
  const lines = []
  for (let index = 1; index <= taskCount; index += 1) {
    const phase = index <= Math.ceil(taskCount / 3)
      ? 'Phase 1'
      : index <= Math.ceil((taskCount * 2) / 3)
        ? 'Phase 2'
        : 'Phase 3'
    const label = `Fake live task ${index}`
    if (lines.length === 0 || lines[lines.length - 1] !== `## ${phase}`) {
      if (lines.length > 0) {
        lines.push('')
      }
      lines.push(`## ${phase}`)
      lines.push('')
    }
    lines.push(`- [ ] ${label}`)
  }
  return `${lines.join('\n')}\n`
}

async function ensureRepo(cwd) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, stdio: 'ignore' })
  } catch {
    execFileSync('git', ['init'], { cwd, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', 'PI Harness Debug'], { cwd, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'pi-harness-debug@example.com'], { cwd, stdio: 'ignore' })
  }
}

async function seedFiles(cwd, { taskCount, scenario }) {
  await fs.mkdir(path.join(cwd, 'pi'), { recursive: true })
  await fs.writeFile(path.join(cwd, 'TODOS.md'), buildTodoLines(taskCount), 'utf8')
  await fs.writeFile(path.join(cwd, 'DEVELOPER.md'), `Developer instructions for local visualizer debugging.\nScenario: ${scenario}\n`, 'utf8')
  await fs.writeFile(path.join(cwd, 'TESTER.md'), `Tester instructions for local visualizer debugging.\nScenario: ${scenario}\n`, 'utf8')
  await fs.writeFile(path.join(cwd, 'pi.config.json'), `${JSON.stringify({
    transport: 'sdk',
    taskFile: 'TODOS.md',
    developerInstructionsFile: 'DEVELOPER.md',
    testerInstructionsFile: 'TESTER.md',
    piCli: fakePiFile,
    piModel: 'fake-model',
    roleModels: {
      developer: 'fake-model',
      developerRetry: 'fake-model',
      developerFix: 'fake-model',
      tester: 'fake-model',
      testerCommit: 'fake-model',
    },
    testCommand: `${shellQuote(process.execPath)} -e ${shellQuote('setTimeout(()=>process.exit(0), 250)')}`,
    streamTerminal: true,
    continueAfterSeconds: 3600,
    noEventTimeoutSeconds: 3600,
    toolContinueAfterSeconds: 3600,
    toolNoEventTimeoutSeconds: 3600,
    sleepBetweenSeconds: 1,
    maxIterations: Math.max(taskCount * 3, 20),
  }, null, 2)}\n`, 'utf8')
}

async function ensureInitialCommit(cwd) {
  try {
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd, stdio: 'ignore' })
  } catch {
    execFileSync('git', ['add', '.'], { cwd, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'chore(debug): seed fake live sandbox'], { cwd, stdio: 'ignore' })
  }
}

async function main() {
  const reset = process.argv.includes('--reset')
  const scenario = readScenario()
  const taskCount = readTaskCount()

  if (reset) {
    await fs.rm(sandboxDir, { recursive: true, force: true })
  }

  await fs.mkdir(sandboxDir, { recursive: true })
  await ensureRepo(sandboxDir)
  await seedFiles(sandboxDir, { taskCount, scenario })
  await ensureInitialCommit(sandboxDir)

  process.stdout.write(`PI debug sandbox: ${sandboxDir}\n`)
  process.stdout.write(`Using fake live SDK fixture: ${fakeLiveSdkFile}\n`)
  process.stdout.write(`Scenario: ${scenario}\n`)
  process.stdout.write(`Task count: ${taskCount}\n`)

  const child = spawn(process.execPath, [cliFile, 'run'], {
    cwd: sandboxDir,
    env: {
      ...process.env,
      PI_CONFIG_FILE: 'pi.config.json',
      PI_SDK_MODULE: fakeLiveSdkFile,
      PI_FAKE_LIVE_SCENARIO: scenario,
      PI_VISUALIZER_HOST: process.env.PI_VISUALIZER_HOST || '127.0.0.1',
      PI_VISUALIZER_PORT: process.env.PI_VISUALIZER_PORT || '4317',
    },
    stdio: 'inherit',
  })

  child.on('exit', (code, signal) => {
    if (signal) {
      process.exitCode = 128
      return
    }
    process.exitCode = code ?? 1
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
