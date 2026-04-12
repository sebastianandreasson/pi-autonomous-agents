import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { collectLargeFileWarnings, listChangedFiles } from '../src/pi-repo.mjs'

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
