import test from 'node:test'
import assert from 'node:assert/strict'

import {
  formatHeartbeatReason,
  formatHeartbeatTimeoutMessage,
  getHeartbeatDecision,
  resolveHeartbeatConfig,
} from '../src/pi-heartbeat.mjs'

test('uses tool-specific thresholds while a tool is active', () => {
  const decision = getHeartbeatDecision({
    now: 1_000_000,
    agentStarted: true,
    agentEnded: false,
    heartbeatTimedOut: false,
    childExited: false,
    lastEventAt: 1_000_000 - 901_000,
    continueAttempted: false,
    activeToolName: 'bash',
    activeToolStartedAt: 1_000_000 - 901_000,
    continueAfterSeconds: 300,
    noEventTimeoutSeconds: 900,
    toolContinueAfterSeconds: 900,
    toolNoEventTimeoutSeconds: 1800,
  })

  assert.equal(decision.action, 'soft_continue')
  assert.equal(decision.timeoutClass, 'tool_idle')
  assert.equal(decision.activeToolName, 'bash')
  assert.equal(decision.continueAfterSeconds, 900)
})

test('does not abort a long-running tool until the tool timeout is exceeded', () => {
  const decision = getHeartbeatDecision({
    now: 2_000_000,
    agentStarted: true,
    agentEnded: false,
    heartbeatTimedOut: false,
    childExited: false,
    lastEventAt: 2_000_000 - 1_200_000,
    continueAttempted: true,
    activeToolName: 'bash',
    activeToolStartedAt: 2_000_000 - 1_200_000,
    continueAfterSeconds: 300,
    noEventTimeoutSeconds: 900,
    toolContinueAfterSeconds: 900,
    toolNoEventTimeoutSeconds: 1800,
  })

  assert.equal(decision.action, 'none')
  assert.equal(decision.timeoutClass, 'tool_idle')
})

test('falls back to normal idle timeout when no tool is active', () => {
  const decision = getHeartbeatDecision({
    now: 3_000_000,
    agentStarted: true,
    agentEnded: false,
    heartbeatTimedOut: false,
    childExited: false,
    lastEventAt: 3_000_000 - 901_000,
    continueAttempted: true,
    activeToolName: '',
    activeToolStartedAt: 0,
    continueAfterSeconds: 300,
    noEventTimeoutSeconds: 900,
    toolContinueAfterSeconds: 900,
    toolNoEventTimeoutSeconds: 1800,
  })

  assert.equal(decision.action, 'abort')
  assert.equal(decision.timeoutClass, 'agent_idle')
})

test('formats timeout details with active tool context', () => {
  const reason = formatHeartbeatReason({
    timeoutClass: 'tool_idle',
    noEventTimeoutSeconds: 1800,
    activeToolName: 'bash',
    toolRuntimeSeconds: 1337,
  })
  const message = formatHeartbeatTimeoutMessage({
    noEventTimeoutSeconds: 1800,
    activeToolName: 'bash',
    toolRuntimeSeconds: 1337,
  })

  assert.match(reason, /timeout_class=tool_idle/)
  assert.match(reason, /active_tool=bash/)
  assert.match(message, /while tool "bash" was running/)
})

test('heartbeat config applies the bumped defaults', () => {
  const config = resolveHeartbeatConfig({})

  assert.deepEqual(config, {
    continueAfterSeconds: 300,
    noEventTimeoutSeconds: 900,
    toolContinueAfterSeconds: 900,
    toolNoEventTimeoutSeconds: 1800,
  })
})
