import test from 'node:test'
import assert from 'node:assert/strict'

import {
  extractModelIdsFromProviderResponse,
  parsePiListModelsOutput,
} from '../src/pi-preflight.mjs'

test('parses plain pi --list-models output', () => {
  const output = [
    'Available models:',
    'gemma-4-26B-A4B-it-UD-Q6_K.gguf',
    'local/tester-model',
  ].join('\n')

  assert.deepEqual(parsePiListModelsOutput(output), [
    'gemma-4-26B-A4B-it-UD-Q6_K.gguf',
    'local/tester-model',
  ])
})

test('parses tabular pi --list-models output', () => {
  const output = [
    'ID PROVIDER',
    'gemma-4-26B-A4B-it-UD-Q6_K.gguf local',
    'local/tester-model local',
  ].join('\n')

  assert.deepEqual(parsePiListModelsOutput(output), [
    'gemma-4-26B-A4B-it-UD-Q6_K.gguf',
    'local/tester-model',
  ])
})

test('extracts model ids from openai-compatible provider responses', () => {
  const payload = {
    data: [
      { id: 'gemma-4-26B-A4B-it-UD-Q6_K.gguf' },
      { id: 'local/tester-model' },
    ],
  }

  assert.deepEqual(extractModelIdsFromProviderResponse(payload), [
    'gemma-4-26B-A4B-it-UD-Q6_K.gguf',
    'local/tester-model',
  ])
})
