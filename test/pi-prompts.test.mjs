import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import {
  buildMainPrompt,
  buildTesterPrompt,
  classifyTaskType,
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
  assert.match(prompt, /Use read for source inspection/i)
})

test('developer prompt includes loop recovery hints when present', () => {
  const prompt = buildMainPrompt(baseConfig, {
    loopRecoveryHints: [
      'src/game/components/MapScreen.tsx: skip exact oldText patching and replace the surrounding function or block instead.',
    ],
  })

  assert.match(prompt, /Recent loop-recovery constraints:/)
  assert.match(prompt, /MapScreen\.tsx/)
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
  assert.match(prompt, /Use read for source inspection/i)
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

test('tester prompt includes large-file risk hint when relevant', () => {
  const prompt = buildTesterPrompt(baseConfig, {
    phase: 'Phase 1',
    task: 'Task',
    changedFiles: ['src/huge.ts'],
    developerNotes: '',
    largeFileWarnings: [
      { file: 'src/huge.ts', lineCount: 612, kind: 'large_file' },
    ],
  })

  assert.match(prompt, /Large file risk in touched files:/)
  assert.match(prompt, /src\/huge\.ts \(612 lines\)/)
})

test('classifyTaskType marks test-focused TODOs', () => {
  assert.equal(classifyTaskType('Write regression test for login redirect'), 'test')
  assert.equal(classifyTaskType('Add coverage for flood warning banner'), 'test')
  assert.equal(classifyTaskType('Implement flood map legend'), 'general')
})

test('tester prompt adds guidance for test-focused tasks', () => {
  const prompt = buildTesterPrompt(baseConfig, {
    phase: 'Phase 1',
    task: 'Write regression test for login redirect',
    changedFiles: ['test/login.test.ts'],
    developerNotes: 'Added failing test first.',
  })

  assert.match(prompt, /Current task type: test-focused/)
  assert.match(prompt, /Do not fail solely because changes are mostly or entirely tests\./)
  assert.match(prompt, /PASS if the new or updated test adds meaningful behavioral or regression coverage and verification passes\./)
})
