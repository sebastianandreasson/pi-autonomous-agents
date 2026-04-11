import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveRoleModel, resolveRoleModelName } from '../src/pi-config.mjs'

test('role model override wins for text roles', () => {
  const config = {
    piModel: 'local/dev',
    visualReviewModel: 'cloud/vision',
    roleModels: {
      tester: 'local/test',
    },
    modelProfiles: {
      'local/test': { baseUrl: 'http://localhost:8000/v1', apiKey: 'x', vision: false },
    },
  }

  assert.equal(resolveRoleModelName(config, 'tester'), 'local/test')
  assert.equal(resolveRoleModel(config, 'tester').model, 'local/test')
  assert.equal(resolveRoleModel(config, 'tester').modelProfile?.baseUrl, 'http://localhost:8000/v1')
})

test('text roles fall back to piModel when not overridden', () => {
  const config = {
    piModel: 'local/dev',
    visualReviewModel: 'cloud/vision',
    roleModels: {},
    modelProfiles: {},
  }

  assert.equal(resolveRoleModelName(config, 'developer'), 'local/dev')
  assert.equal(resolveRoleModelName(config, 'developerFix'), 'local/dev')
  assert.equal(resolveRoleModelName(config, 'testerCommit'), 'local/dev')
})

test('visual review falls back to visualReviewModel when not overridden', () => {
  const config = {
    piModel: 'local/dev',
    visualReviewModel: 'cloud/vision',
    roleModels: {},
    modelProfiles: {
      'cloud/vision': { baseUrl: 'https://api.openai.com/v1', apiKey: 'x', vision: true },
    },
  }

  assert.equal(resolveRoleModelName(config, 'visualReview'), 'cloud/vision')
  assert.equal(resolveRoleModel(config, 'visualReview').modelProfile?.vision, true)
})
