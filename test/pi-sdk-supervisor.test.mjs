import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(scriptDir, '..')
const cliFile = path.join(packageRoot, 'src', 'cli.mjs')
const fakePiFile = path.join(packageRoot, 'test', 'fixtures', 'fake-pi.mjs')
const fakeSdkFile = path.join(packageRoot, 'test', 'fixtures', 'fake-pi-sdk.mjs')

async function makeTempRepo() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sdk-supervisor-'))
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'PI Harness Test'], { cwd, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'pi-harness@example.com'], { cwd, stdio: 'ignore' })
  return cwd
}

function shellQuote(value) {
  return JSON.stringify(String(value))
}

async function writeTestRepo(cwd, overrides = {}) {
  await fs.writeFile(path.join(cwd, 'TODOS.md'), '## Phase 1\n\n- [ ] SDK supervisor test\n', 'utf8')
  await fs.writeFile(path.join(cwd, 'DEVELOPER.md'), 'Developer instructions.\n', 'utf8')
  await fs.writeFile(path.join(cwd, 'TESTER.md'), 'Tester instructions.\n', 'utf8')
  const config = {
    transport: 'sdk',
    taskFile: 'TODOS.md',
    developerInstructionsFile: 'DEVELOPER.md',
    testerInstructionsFile: 'TESTER.md',
    piCli: fakePiFile,
    piModel: 'fake-model',
    roleModels: {
      developer: 'fake-model',
      developerFix: 'fake-model',
      developerRetry: 'fake-model',
      tester: 'fake-model',
      testerCommit: 'fake-model',
    },
    testCommand: 'node -e "process.exit(0)"',
    visualReviewEnabled: false,
    streamTerminal: false,
    continueAfterSeconds: 3600,
    noEventTimeoutSeconds: 3600,
    toolContinueAfterSeconds: 3600,
    toolNoEventTimeoutSeconds: 3600,
    sleepBetweenSeconds: 1,
    maxIterations: 1,
    ...overrides,
  }
  await fs.writeFile(path.join(cwd, 'pi.config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  execFileSync('git', ['add', '.'], { cwd, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'initial'], { cwd, stdio: 'ignore' })
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      resolve({ code, signal })
    })
  })
}

test('sdk transport completes one supervisor iteration end-to-end', async (t) => {
  const cwd = await makeTempRepo()
  await writeTestRepo(cwd)

  t.after(async () => {
    await fs.rm(cwd, { recursive: true, force: true })
  })

  const child = spawn(process.execPath, [cliFile, 'once'], {
    cwd,
    env: {
      ...process.env,
      PI_CONFIG_FILE: 'pi.config.json',
      PI_SDK_MODULE: fakeSdkFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })

  const { code, signal } = await waitForExit(child)
  assert.equal(signal, null)
  assert.equal(code, 0, `stdout:\n${stdout}\n\nstderr:\n${stderr}`)

  const summary = JSON.parse(await fs.readFile(path.join(cwd, '.pi-last-iteration.json'), 'utf8'))
  assert.equal(summary.developerStatus, 'success')
  assert.equal(summary.testerStatus, 'success')
  assert.equal(summary.testerVerdict, 'PASS')
  assert.equal(summary.verificationStatus, 'passed')
  assert.equal(summary.terminalReason, 'completed_phase_step')
  assert.equal(summary.developerModel, 'fake-model')
  assert.equal(summary.testerModel, 'fake-model')

  const todoText = await fs.readFile(path.join(cwd, 'TODOS.md'), 'utf8')
  assert.match(todoText, /- \[x\] SDK supervisor test/)

  const implementedText = await fs.readFile(path.join(cwd, 'sdk-implemented.txt'), 'utf8')
  assert.match(implementedText, /implemented by fake sdk/)

  const headMessage = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd, encoding: 'utf8' }).trim()
  assert.equal(headMessage, 'test(harness): complete sdk flow')

  const commitCount = Number.parseInt(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd, encoding: 'utf8' }).trim(), 10)
  assert.equal(commitCount, 2)
})

test('sdk transport falls back to harness commit finalization when tester leaves a dirty PASS', async (t) => {
  const cwd = await makeTempRepo()
  await writeTestRepo(cwd)

  t.after(async () => {
    await fs.rm(cwd, { recursive: true, force: true })
  })

  const child = spawn(process.execPath, [cliFile, 'once'], {
    cwd,
    env: {
      ...process.env,
      PI_CONFIG_FILE: 'pi.config.json',
      PI_SDK_MODULE: fakeSdkFile,
      FAKE_PI_SDK_SCENARIO: 'pass_dirty_no_commit',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })

  const { code, signal } = await waitForExit(child)
  assert.equal(signal, null)
  assert.equal(code, 0, `stdout:\n${stdout}\n\nstderr:\n${stderr}`)

  const summary = JSON.parse(await fs.readFile(path.join(cwd, '.pi-last-iteration.json'), 'utf8'))
  assert.equal(summary.testerStatus, 'success')
  assert.equal(summary.gitFinalizeStatus, 'success')
  assert.equal(summary.terminalReason, 'completed_phase_step')

  const headMessage = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd, encoding: 'utf8' }).trim()
  assert.equal(headMessage, 'test(harness): complete sdk flow')
})

test('sdk transport re-runs smoke after tester edits before commit fallback', async (t) => {
  const cwd = await makeTempRepo()
  const verificationCode = [
    `const fs=require('node:fs')`,
    `const p='verification-count.txt'`,
    `let n=0`,
    `try{n=Number(fs.readFileSync(p,'utf8'))}catch{}`,
    `fs.writeFileSync(p,String(n+1))`,
  ].join(';')
  await writeTestRepo(cwd, {
    testCommand: `${shellQuote(process.execPath)} -e ${shellQuote(verificationCode)}`,
  })

  t.after(async () => {
    await fs.rm(cwd, { recursive: true, force: true })
  })

  const child = spawn(process.execPath, [cliFile, 'once'], {
    cwd,
    env: {
      ...process.env,
      PI_CONFIG_FILE: 'pi.config.json',
      PI_SDK_MODULE: fakeSdkFile,
      FAKE_PI_SDK_SCENARIO: 'edit_pass_no_commit',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })

  const { code, signal } = await waitForExit(child)
  assert.equal(signal, null)
  assert.equal(code, 0, `stdout:\n${stdout}\n\nstderr:\n${stderr}`)

  const verificationCount = await fs.readFile(path.join(cwd, 'verification-count.txt'), 'utf8')
  assert.equal(verificationCount.trim(), '2')

  const summary = JSON.parse(await fs.readFile(path.join(cwd, '.pi-last-iteration.json'), 'utf8'))
  assert.equal(summary.verificationStatus, 'passed')
  assert.equal(summary.testerStatus, 'success')
})
