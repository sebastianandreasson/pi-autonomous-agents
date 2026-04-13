import test from 'node:test'
import assert from 'node:assert/strict'

import {
  deriveCurrentIteration,
  deriveFlowSnapshot,
  formatActiveLabel,
  getStepKeyForActiveRun,
  getStepKeyForKind,
} from '../src/pi-visualizer-shared.mjs'

test('maps telemetry kinds to flow step keys', () => {
  assert.equal(getStepKeyForKind('main_agent'), 'developer')
  assert.equal(getStepKeyForKind('developer_verification'), 'verification')
  assert.equal(getStepKeyForKind('tester_agent'), 'tester')
  assert.equal(getStepKeyForKind('fix_agent'), 'fix')
  assert.equal(getStepKeyForKind('visual_review'), 'visual_review')
})

test('derives active step from active run fields', () => {
  assert.equal(getStepKeyForActiveRun({ activeKind: 'fix_agent' }), 'fix')
  assert.equal(getStepKeyForActiveRun({ status: 'verification_running' }), 'verification')
})

test('derives current iteration from active run first', () => {
  const iteration = deriveCurrentIteration({
    activeRun: { iteration: 4 },
    summary: { iteration: 3 },
    telemetry: [{ iteration: 2 }],
  })
  assert.equal(iteration, 4)
})

test('builds flow snapshot with active and completed steps', () => {
  const flow = deriveFlowSnapshot({
    activeRun: {
      iteration: 2,
      activeKind: 'tester_agent',
    },
    summary: null,
    telemetry: [
      { iteration: 2, kind: 'main_agent', status: 'success' },
      { iteration: 2, kind: 'developer_verification', status: 'passed' },
      { iteration: 2, kind: 'tester_agent', status: 'success' },
    ],
  })

  assert.equal(flow.iteration, 2)
  assert.equal(flow.activeStepKey, 'tester')
  assert.equal(flow.steps.find((step) => step.key === 'developer')?.status, 'done')
  assert.equal(flow.steps.find((step) => step.key === 'verification')?.status, 'done')
  assert.equal(flow.steps.find((step) => step.key === 'tester')?.status, 'active')
})

test('formats active label from flow state', () => {
  const flow = deriveFlowSnapshot({
    activeRun: { iteration: 1, activeKind: 'visual_capture' },
    summary: null,
    telemetry: [],
  })
  assert.equal(formatActiveLabel({ activeKind: 'visual_capture' }, flow), 'Visual Capture')
})
