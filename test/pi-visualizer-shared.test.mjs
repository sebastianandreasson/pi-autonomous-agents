import test from 'node:test'
import assert from 'node:assert/strict'

import {
  deriveCurrentIteration,
  deriveFlowSnapshot,
  deriveStageGraph,
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
    options: {
      includeVisualReview: false,
    },
  })

  assert.equal(flow.iteration, 2)
  assert.equal(flow.activeStepKey, 'tester')
  assert.equal(flow.steps.find((step) => step.key === 'developer')?.status, 'done')
  assert.equal(flow.steps.find((step) => step.key === 'verification')?.status, 'done')
  assert.equal(flow.steps.find((step) => step.key === 'tester')?.status, 'active')
  assert.equal(flow.steps.find((step) => step.key === 'developer')?.durationSeconds, null)
})


test('keeps active step start time and completed duration in flow snapshot', () => {
  const flow = deriveFlowSnapshot({
    activeRun: {
      iteration: 2,
      activeKind: 'tester_agent',
      activeStartedAt: '2026-04-13T12:00:00.000Z',
    },
    summary: null,
    telemetry: [
      { iteration: 2, kind: 'main_agent', status: 'success', durationSeconds: 14 },
      { iteration: 2, kind: 'developer_verification', status: 'passed', durationSeconds: 3 },
    ],
    options: {
      includeVisualReview: false,
    },
  })

  assert.equal(flow.steps.find((step) => step.key === 'developer')?.durationSeconds, 14)
  assert.equal(flow.steps.find((step) => step.key === 'verification')?.durationSeconds, 3)
  assert.equal(flow.steps.find((step) => step.key === 'tester')?.activeStartedAt, '2026-04-13T12:00:00.000Z')
})

test('formats active label from flow state', () => {
  const flow = deriveFlowSnapshot({
    activeRun: { iteration: 1, activeKind: 'visual_capture' },
    summary: null,
    telemetry: [],
    options: {
      includeVisualReview: true,
    },
  })
  assert.equal(formatActiveLabel({ activeKind: 'visual_capture' }, flow, { includeVisualReview: true }), 'Visual Capture')
})


test('hides visual steps when visual review is disabled', () => {
  const flow = deriveFlowSnapshot({
    activeRun: { iteration: 1, activeKind: 'tester_agent' },
    summary: null,
    telemetry: [],
    options: {
      includeVisualReview: false,
    },
  })

  assert.equal(flow.steps.some((step) => step.key === 'visual_capture'), false)
  assert.equal(flow.steps.some((step) => step.key === 'visual_review'), false)
})

test('builds stage graph for current iteration timeline', () => {
  const graph = deriveStageGraph({
    activeRun: { iteration: 3, activeKind: 'fix_agent' },
    summary: null,
    telemetry: [
      { iteration: 3, kind: 'main_agent', status: 'success', retryCount: 0 },
      { iteration: 3, kind: 'developer_verification', status: 'failed', retryCount: 0 },
      { iteration: 3, kind: 'fix_agent', status: 'success', retryCount: 0 },
    ],
    options: {
      includeVisualReview: false,
    },
  })

  assert.equal(graph.iteration, 3)
  assert.equal(graph.nodes.length, 3)
  assert.equal(graph.nodes[0].label, 'Developer')
  assert.equal(graph.nodes[1].status, 'error')
  assert.equal(graph.nodes[2].status, 'active')
  assert.equal(graph.edges.length, 2)
})
