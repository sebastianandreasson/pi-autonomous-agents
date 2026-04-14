import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { readJsonFile } from '../src/pi-repo.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(scriptDir, '..')
const cliFile = path.join(packageRoot, 'src', 'cli.mjs')
const fakePiFile = path.join(packageRoot, 'test', 'fixtures', 'fake-pi.mjs')
const fakeSdkFile = path.join(packageRoot, 'test', 'fixtures', 'fake-pi-sdk.mjs')

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

function shellQuote(value) {
  return JSON.stringify(String(value))
}

async function writeTestRepo(cwd) {
  const verifierPidFile = path.join(cwd, 'verifier.pid')
  const verifierReadyFile = path.join(cwd, 'verifier.ready')
  const verifierHeartbeatFile = path.join(cwd, 'verifier.heartbeat')
  const verificationCode = [
    `const fs=require('node:fs')`,
    `fs.writeFileSync(process.env.VERIFIER_PID_FILE,String(process.pid))`,
    `fs.writeFileSync(process.env.VERIFIER_READY_FILE,'ready')`,
    `let beats=0`,
    `fs.writeFileSync(process.env.VERIFIER_HEARTBEAT_FILE,String(beats))`,
    `setInterval(()=>{beats+=1;fs.writeFileSync(process.env.VERIFIER_HEARTBEAT_FILE,String(beats))},100)`,
  ].join(';')
  const verificationCommand = `${shellQuote(process.execPath)} -e ${shellQuote(verificationCode)}`

  await fs.writeFile(path.join(cwd, 'TODOS.md'), '## Phase 1\n\n- [ ] Lifecycle test\n', 'utf8')
  await fs.writeFile(path.join(cwd, 'DEVELOPER.md'), 'Developer instructions.\n', 'utf8')
  await fs.writeFile(path.join(cwd, 'TESTER.md'), 'Tester instructions.\n', 'utf8')
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
    testCommand: verificationCommand,
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
    verifierPidFile,
    verifierReadyFile,
    verifierHeartbeatFile,
  }
}

async function readHeartbeat(filePath) {
  try {
    return Number.parseInt((await fs.readFile(filePath, 'utf8')).trim(), 10)
  } catch {
    return -1
  }
}

test('killing the top-level harness process tears down sdk supervisor and owned verification child', async (t) => {
  const cwd = await makeTempRepo()
  const {
    verifierPidFile,
    verifierReadyFile,
    verifierHeartbeatFile,
  } = await writeTestRepo(cwd)
  const activeRunFile = path.join(cwd, '.pi-runtime', 'active-run.json')
  const child = spawn(process.execPath, [cliFile, 'run'], {
    cwd,
    env: {
      ...process.env,
      PI_CONFIG_FILE: 'pi.config.json',
      PI_SDK_MODULE: fakeSdkFile,
      VERIFIER_PID_FILE: verifierPidFile,
      VERIFIER_READY_FILE: verifierReadyFile,
      VERIFIER_HEARTBEAT_FILE: verifierHeartbeatFile,
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
  let verifierPid = 0

  t.after(async () => {
    try {
      process.kill(child.pid, 'SIGKILL')
    } catch {}

    for (const pid of [supervisorPid, verifierPid]) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }

    await fs.rm(cwd, { recursive: true, force: true })
  })

  await waitFor(async () => {
    try {
      await fs.access(verifierReadyFile)
      return true
    } catch {
      return false
    }
  }, {
    errorMessage: `Verification child never reached ready state.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  })

  verifierPid = Number.parseInt((await fs.readFile(verifierPidFile, 'utf8')).trim(), 10)
  assert.ok(Number.isInteger(verifierPid) && verifierPid > 0, 'expected verification pid to be recorded')

  await waitFor(async () => {
    const activeRun = await readJsonFile(activeRunFile, null)
    supervisorPid = Number.parseInt(String(activeRun?.pid ?? ''), 10)
    return Number.isInteger(supervisorPid) && supervisorPid > 0
  }, {
    errorMessage: 'Supervisor never published its active-run lock.',
  })

  process.kill(child.pid, 'SIGKILL')

  await waitFor(async () => {
    const activeRun = await readJsonFile(activeRunFile, null)
    return activeRun === null
  }, {
    timeoutMs: 25_000,
    intervalMs: 200,
    errorMessage: `Active run lock still present after parent death.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  })

  const heartbeatBefore = await readHeartbeat(verifierHeartbeatFile)
  await new Promise((resolve) => {
    setTimeout(resolve, 1000)
  })
  const heartbeatAfter = await readHeartbeat(verifierHeartbeatFile)
  assert.equal(heartbeatAfter, heartbeatBefore, `Verifier heartbeat kept advancing after parent death (${heartbeatBefore} -> ${heartbeatAfter}).`)
})
