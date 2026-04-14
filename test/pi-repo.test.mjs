import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import {
  acquireRunLock,
  collectLargeFileWarnings,
  listChangedFiles,
  readJsonFile,
  releaseRunLock,
  watchParentProcess,
} from '../src/pi-repo.mjs'

async function makeTempRepo() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-repo-'))
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'PI Harness Test'], { cwd, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'pi-harness@example.com'], { cwd, stdio: 'ignore' })
  return cwd
}

test('listChangedFiles keeps full paths from git status --short output', async () => {
  const cwd = await makeTempRepo()

  await fs.writeFile(path.join(cwd, 'TODOS.md'), 'initial\n', 'utf8')
  await fs.mkdir(path.join(cwd, 'src', 'game'), { recursive: true })
  await fs.writeFile(path.join(cwd, 'src', 'game', 'testing.ts'), 'export const value = 1\n', 'utf8')
  await fs.mkdir(path.join(cwd, 'e2e'), { recursive: true })
  await fs.writeFile(path.join(cwd, 'e2e', 'game.spec.ts'), 'test\n', 'utf8')

  execFileSync('git', ['add', '.'], { cwd, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'initial'], { cwd, stdio: 'ignore' })

  await fs.writeFile(path.join(cwd, 'TODOS.md'), 'updated\n', 'utf8')
  await fs.writeFile(path.join(cwd, 'src', 'game', 'testing.ts'), 'export const value = 2\n', 'utf8')
  await fs.writeFile(path.join(cwd, 'e2e', 'game.spec.ts'), 'updated test\n', 'utf8')

  const changedFiles = listChangedFiles(cwd)

  assert.deepEqual(changedFiles.sort(), [
    'TODOS.md',
    'e2e/game.spec.ts',
    'src/game/testing.ts',
  ])
})

test('collectLargeFileWarnings flags oversized source and spec files', async () => {
  const cwd = await makeTempRepo()
  await fs.mkdir(path.join(cwd, 'src'), { recursive: true })
  await fs.mkdir(path.join(cwd, 'e2e'), { recursive: true })
  await fs.writeFile(path.join(cwd, 'src', 'huge.ts'), `${'x\n'.repeat(520)}`, 'utf8')
  await fs.writeFile(path.join(cwd, 'e2e', 'huge.spec.ts'), `${'y\n'.repeat(320)}`, 'utf8')

  const warnings = collectLargeFileWarnings(cwd, ['src/huge.ts', 'e2e/huge.spec.ts'], {
    largeFileWarningLines: 500,
    largeSpecWarningLines: 300,
  })

  assert.deepEqual(warnings, [
    { file: 'src/huge.ts', lineCount: 521, kind: 'large_file' },
    { file: 'e2e/huge.spec.ts', lineCount: 321, kind: 'large_spec' },
  ])
})

test('acquireRunLock creates and releases an active-run lock', async () => {
  const cwd = await makeTempRepo()
  const lockFile = path.join(cwd, '.pi-runtime', 'active-run.json')

  const result = await acquireRunLock(lockFile, {
    runId: 'run-1',
    pid: process.pid,
    startedAt: '2026-04-13T00:00:00.000Z',
    heartbeatAt: '2026-04-13T00:00:00.000Z',
    status: 'starting',
    cwd,
  })

  assert.equal(result.acquired, true)
  assert.equal(result.staleLock, null)
  assert.deepEqual(await readJsonFile(lockFile, null), {
    runId: 'run-1',
    pid: process.pid,
    startedAt: '2026-04-13T00:00:00.000Z',
    heartbeatAt: '2026-04-13T00:00:00.000Z',
    status: 'starting',
    iteration: 0,
    phase: '',
    task: '',
    mode: '',
    configFile: '',
    cwd,
  })

  assert.equal(await releaseRunLock(lockFile, 'run-1'), true)
  assert.equal(await readJsonFile(lockFile, null), null)
})

test('acquireRunLock recovers a stale lock owned by a dead pid', async () => {
  const cwd = await makeTempRepo()
  const lockFile = path.join(cwd, '.pi-runtime', 'active-run.json')
  await fs.mkdir(path.dirname(lockFile), { recursive: true })
  await fs.writeFile(lockFile, `${JSON.stringify({
    runId: 'stale-run',
    pid: 999999,
    startedAt: '2026-04-13T00:00:00.000Z',
    heartbeatAt: '2026-04-13T00:10:00.000Z',
    status: 'iteration_in_progress',
    iteration: 23,
    phase: 'Phase 10',
    task: 'Stale task',
    cwd,
  }, null, 2)}\n`, 'utf8')

  const result = await acquireRunLock(lockFile, {
    runId: 'fresh-run',
    pid: process.pid,
    startedAt: '2026-04-13T01:00:00.000Z',
    heartbeatAt: '2026-04-13T01:00:00.000Z',
    status: 'starting',
    cwd,
  })

  assert.equal(result.acquired, true)
  assert.equal(result.staleLock.runId, 'stale-run')
  assert.equal((await readJsonFile(lockFile, null)).runId, 'fresh-run')
})

test('watchParentProcess exits when the expected parent pid is already dead', async () => {
  const exitInfo = await new Promise((resolve) => {
    const stopWatching = watchParentProcess(resolve, {
      parentPid: 999999,
      intervalMs: 100,
    })

    setTimeout(() => {
      stopWatching()
      resolve(null)
    }, 1000)
  })

  assert.deepEqual(exitInfo, {
    expectedParentPid: 999999,
    currentParentPid: process.ppid,
  })
})
