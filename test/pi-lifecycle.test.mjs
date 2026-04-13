import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { isProcessRunning, readJsonFile } from '../src/pi-repo.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(scriptDir, '..')
const cliFile = path.join(packageRoot, 'src', 'cli.mjs')
const fakePiFile = path.join(packageRoot, 'test', 'fixtures', 'fake-pi.mjs')

function shellQuote(value) {
  return JSON.stringify(String(value))
}

async function makeTempRepo() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-lifecycle-'))
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'PI Harness Test'], { cwd, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'pi-harness@example.com'], { cwd, stdio: 'ignore' })
  return cwd
}

async function waitFor(predicate, {
  timeoutMs = 10_000,
  intervalMs = 100,
  errorMessage = 'Timed out waiting for condition.',
} = {}) {
  const startedAt = Date.now()
  while ((Date.now() - startedAt) < timeoutMs) {
    if (await predicate()) {
      return
    }
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs)
    })
  }

  throw new Error(errorMessage)
}

async function writeTestRepo(cwd) {
  const readyFile = path.join(cwd, 'fake-pi.ready')
  const pidFile = path.join(cwd, 'fake-pi.pid')
  const adapterCommand = `${shellQuote(process.execPath)} ${shellQuote(cliFile)} adapter`

  await fs.writeFile(path.join(cwd, 'TODOS.md'), '- [ ] Lifecycle test\n', 'utf8')
  await fs.writeFile(path.join(cwd, 'DEVELOPER.md'), 'Developer instructions.\n', 'utf8')
  await fs.writeFile(path.join(cwd, 'TESTER.md'), 'Tester instructions.\n', 'utf8')
  await fs.writeFile(path.join(cwd, 'pi.config.json'), `${JSON.stringify({
    transport: 'adapter',
    adapterCommand,
    taskFile: 'TODOS.md',
    developerInstructionsFile: 'DEVELOPER.md',
    testerInstructionsFile: 'TESTER.md',
    piCli: fakePiFile,
    piModel: 'fake-model',
    testCommand: '',
    streamTerminal: false,
    continueAfterSeconds: 3600,
    noEventTimeoutSeconds: 3600,
    toolContinueAfterSeconds: 3600,
    toolNoEventTimeoutSeconds: 3600,
    sleepBetweenSeconds: 1,
    maxIterations: 200,
  }, null, 2)}\n`, 'utf8')
  execFileSync('git', ['add', '.'], { cwd, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'initial'], { cwd, stdio: 'ignore' })

  return {
    readyFile,
    pidFile,
  }
}

test('killing the top-level harness process tears down all descendants', async (t) => {
  const cwd = await makeTempRepo()
  const { readyFile, pidFile } = await writeTestRepo(cwd)
  const activeRunFile = path.join(cwd, '.pi-runtime', 'active-run.json')
  const child = spawn(process.execPath, [cliFile, 'run'], {
    cwd,
    env: {
      ...process.env,
      PI_CONFIG_FILE: 'pi.config.json',
      FAKE_PI_READY_FILE: readyFile,
      FAKE_PI_PID_FILE: pidFile,
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

  let supervisorPid = 0
  let adapterPid = 0
  let fakePiPid = 0

  t.after(async () => {
    try {
      process.kill(child.pid, 'SIGKILL')
    } catch {}

    for (const pid of [supervisorPid, adapterPid, fakePiPid]) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }

    await fs.rm(cwd, { recursive: true, force: true })
  })

  await waitFor(async () => {
    try {
      await fs.access(readyFile)
      return true
    } catch {
      return false
    }
  }, {
    errorMessage: `Fake PI process never reached ready state.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  })

  fakePiPid = Number.parseInt((await fs.readFile(pidFile, 'utf8')).trim(), 10)
  assert.ok(Number.isInteger(fakePiPid) && fakePiPid > 0, 'expected fake PI pid to be recorded')
  const readyState = JSON.parse(await fs.readFile(readyFile, 'utf8'))
  adapterPid = Number.parseInt(String(readyState.ppid ?? ''), 10)
  assert.ok(Number.isInteger(adapterPid) && adapterPid > 0, 'expected fake PI parent pid to identify the adapter')

  await waitFor(async () => {
    const activeRun = await readJsonFile(activeRunFile, null)
    supervisorPid = Number.parseInt(String(activeRun?.pid ?? ''), 10)
    return Number.isInteger(supervisorPid) && supervisorPid > 0
  }, {
    errorMessage: 'Supervisor never published its active-run lock.',
  })

  process.kill(child.pid, 'SIGKILL')

  await waitFor(() => [supervisorPid, adapterPid, fakePiPid].every((pid) => !isProcessRunning(pid)), {
    timeoutMs: 15_000,
    intervalMs: 200,
    errorMessage: `Descendants still running after parent death: ${[supervisorPid, adapterPid, fakePiPid].filter((pid) => isProcessRunning(pid)).join(', ')}`,
  })
})
