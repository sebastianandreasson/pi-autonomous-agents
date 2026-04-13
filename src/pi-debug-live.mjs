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

function shellQuote(value) {
  return JSON.stringify(String(value))
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

async function seedFiles(cwd) {
  await fs.mkdir(path.join(cwd, 'pi'), { recursive: true })
  await fs.writeFile(path.join(cwd, 'TODOS.md'), [
    '## Phase 1',
    '',
    '- [ ] Fake live task one',
    '- [ ] Fake live task two',
    '- [ ] Fake live task three',
    '',
    '## Phase 2',
    '',
    '- [ ] Fake live task four',
  ].join('\n') + '\n', 'utf8')
  await fs.writeFile(path.join(cwd, 'DEVELOPER.md'), 'Developer instructions for local visualizer debugging.\n', 'utf8')
  await fs.writeFile(path.join(cwd, 'TESTER.md'), 'Tester instructions for local visualizer debugging.\n', 'utf8')
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
    maxIterations: 20,
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
  if (reset) {
    await fs.rm(sandboxDir, { recursive: true, force: true })
  }

  await fs.mkdir(sandboxDir, { recursive: true })
  await ensureRepo(sandboxDir)
  await seedFiles(sandboxDir)
  await ensureInitialCommit(sandboxDir)

  process.stdout.write(`PI debug sandbox: ${sandboxDir}\n`)
  process.stdout.write(`Using fake live SDK fixture: ${fakeLiveSdkFile}\n`)

  const child = spawn(process.execPath, [cliFile, 'run'], {
    cwd: sandboxDir,
    env: {
      ...process.env,
      PI_CONFIG_FILE: 'pi.config.json',
      PI_SDK_MODULE: fakeLiveSdkFile,
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
