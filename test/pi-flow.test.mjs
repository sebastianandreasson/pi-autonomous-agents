import test from 'node:test'
import assert from 'node:assert/strict'

import {
  deriveFinalStatusWithVisualReview,
  deriveWorkflowStatus,
  shouldPersistLatestTesterFeedback,
} from '../src/pi-flow.mjs'

test('commit-plan housekeeping does not replace latest substantive tester feedback', () => {
  assert.equal(shouldPersistLatestTesterFeedback('tester_review'), true)
  assert.equal(shouldPersistLatestTesterFeedback('tester_recheck'), true)
  assert.equal(shouldPersistLatestTesterFeedback('tester_commit_plan'), false)
})

test('visual review can veto an otherwise successful iteration', () => {
  const workflowStatus = deriveWorkflowStatus({
    developerStatus: 'success',
    testerStatus: 'success',
    verificationStatus: 'passed',
  })

  assert.equal(workflowStatus, 'success')
  assert.equal(deriveFinalStatusWithVisualReview({
    workflowStatus,
    visualStatus: 'failed',
  }), 'failed')
  assert.equal(deriveFinalStatusWithVisualReview({
    workflowStatus,
    visualStatus: 'blocked',
  }), 'blocked')
  assert.equal(deriveFinalStatusWithVisualReview({
    workflowStatus,
    visualStatus: 'timed_out',
  }), 'timed_out')
})

test('visual review does not change unsuccessful workflow states', () => {
  const workflowStatus = deriveWorkflowStatus({
    developerStatus: 'success',
    testerStatus: 'failed',
    verificationStatus: 'passed',
  })

  assert.equal(workflowStatus, 'failed')
  assert.equal(deriveFinalStatusWithVisualReview({
    workflowStatus,
    visualStatus: 'failed',
  }), 'failed')
})
