import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import {
  buildMainPrompt,
  buildTesterPrompt,
} from '../src/pi-prompts.mjs'

const cwd = '/tmp/example-repo'
const baseConfig = {
  cwd,
  taskFile: path.join(cwd, 'TODOS.md'),
  developerInstructionsFile: path.join(cwd, 'pi', 'DEVELOPER.md'),
  testerInstructionsFile: path.join(cwd, 'pi', 'TESTER.md'),
  testCommand: 'pnpm test:e2e:smoke',
  visualReviewEnabled: false,
  visualCaptureCommand: '',
}

test('developer prompt uses repo-relative instruction paths', () => {
  const prompt = buildMainPrompt(baseConfig)
  assert.match(prompt, /Read TODOS\.md and pi\/DEVELOPER\.md\./)
})

test('tester prompt uses repo-relative instruction paths', () => {
  const prompt = buildTesterPrompt(baseConfig, {
    phase: 'Phase 1',
    task: 'Task',
    changedFiles: [],
    developerNotes: '',
  })
  assert.match(prompt, /Read TODOS\.md and pi\/TESTER\.md\./)
})
