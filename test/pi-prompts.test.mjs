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
  usingBundledDeveloperInstructions: false,
  usingBundledTesterInstructions: false,
  commitMode: 'agent',
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

test('custom tester instructions stay authoritative over package defaults', () => {
  const prompt = buildTesterPrompt(baseConfig, {
    phase: 'Phase 1',
    task: 'Task',
    changedFiles: [],
    developerNotes: '',
  })

  assert.match(prompt, /Repo-local instructions in pi\/TESTER\.md are the primary role contract\./)
  assert.doesNotMatch(prompt, /Run the repo verification command yourself:/)
  assert.match(prompt, /create the git commit yourself/i)
  assert.doesNotMatch(prompt, /COMMIT_FILES:/)
})

test('plan commit mode keeps commit-plan block for tester', () => {
  const prompt = buildTesterPrompt({
    ...baseConfig,
    commitMode: 'plan',
  }, {
    phase: 'Phase 1',
    task: 'Task',
    changedFiles: [],
    developerNotes: '',
  })

  assert.match(prompt, /COMMIT_FILES:/)
  assert.match(prompt, /Provide a commit plan/)
})

test('tester prompt caps changed files and long notes', () => {
  const prompt = buildTesterPrompt({
    ...baseConfig,
    maxPromptChangedFiles: 2,
    maxPromptNotesLines: 2,
  }, {
    phase: 'Phase 1',
    task: 'Task',
    changedFiles: ['a.ts', 'b.ts', 'c.ts'],
    developerNotes: 'line 1\nline 2\nline 3',
  })

  assert.match(prompt, /- a\.ts/)
  assert.match(prompt, /- b\.ts/)
  assert.match(prompt, /\.\.\. and 1 more files/)
  assert.match(prompt, /\.\.\. \(1 more lines omitted\)/)
})
