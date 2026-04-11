import fs from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

import { resolveRoleModelName } from './pi-config.mjs'

function uniqueNonEmpty(values) {
  return [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))]
}

function formatAvailableModels(models) {
  const uniqueModels = uniqueNonEmpty(models)
  if (uniqueModels.length === 0) {
    return '(none)'
  }
  if (uniqueModels.length <= 20) {
    return uniqueModels.join(', ')
  }
  return `${uniqueModels.slice(0, 20).join(', ')}, ...`
}

export function parsePiListModelsOutput(output) {
  const text = String(output ?? '').trim()
  if (text === '') {
    return []
  }

  try {
    const parsed = JSON.parse(text)
    return extractModelIdsFromProviderResponse(parsed)
  } catch {
    // fall through
  }

  const ids = []
  let modelColumnIndex = -1
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    const stripped = line.replace(/^[-*]\s+/, '').trim()
    const columns = stripped.split(/\s+/).filter(Boolean)
    const normalizedColumns = columns.map((value) => value.toLowerCase())

    if (
      modelColumnIndex === -1
      && normalizedColumns.includes('model')
      && normalizedColumns.some((value) => value === 'provider' || value === 'id' || value === 'name')
    ) {
      modelColumnIndex = normalizedColumns.indexOf('model')
      continue
    }

    if (
      line === ''
      || /^available models:?$/i.test(line)
      || /^models:?$/i.test(line)
      || /^id\s+/i.test(line)
      || /^name\s+/i.test(line)
      || /^[-=\s]+$/.test(line)
    ) {
      continue
    }

    if (modelColumnIndex >= 0) {
      const modelToken = columns[modelColumnIndex]?.trim() ?? ''
      if (modelToken !== '') {
        ids.push(modelToken)
      }
      continue
    }

    const firstToken = columns[0]?.trim() ?? ''
    if (firstToken !== '') {
      ids.push(firstToken)
    }
  }

  return uniqueNonEmpty(ids)
}

export function extractModelIdsFromProviderResponse(payload) {
  if (Array.isArray(payload)) {
    return uniqueNonEmpty(payload.map((entry) => {
      if (typeof entry === 'string') {
        return entry
      }
      if (entry && typeof entry === 'object') {
        return entry.id ?? entry.name ?? entry.model ?? ''
      }
      return ''
    }))
  }

  if (!payload || typeof payload !== 'object') {
    return []
  }

  if (Array.isArray(payload.data)) {
    return extractModelIdsFromProviderResponse(payload.data)
  }

  if (Array.isArray(payload.models)) {
    return extractModelIdsFromProviderResponse(payload.models)
  }

  return uniqueNonEmpty([
    payload.id ?? '',
    payload.name ?? '',
    payload.model ?? '',
  ])
}

async function ensurePiHomeModelsConfig() {
  const piHome = process.env.PI_CODING_AGENT_DIR
  if (!piHome) {
    return
  }

  const resolvedPiHome = path.resolve(piHome)
  const modelsFile = path.join(resolvedPiHome, 'models.json')
  try {
    await fs.access(modelsFile)
  } catch {
    throw new Error(
      `PI_CODING_AGENT_DIR points at "${resolvedPiHome}", but "${modelsFile}" is missing. Either remove PI_CODING_AGENT_DIR or bootstrap that PI home before running the harness.`
    )
  }
}

function listPiModels(config) {
  const result = spawnSync(config.piCli, ['--list-models'], {
    cwd: config.cwd,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout = String(result.stdout ?? '').trim()
  const stderr = String(result.stderr ?? '').trim()
  const combinedOutput = [stdout, stderr].filter(Boolean).join('\n').trim()

  if (result.error) {
    throw new Error(
      combinedOutput === ''
        ? `Failed to list PI models via "${config.piCli} --list-models".`
        : `Failed to list PI models via "${config.piCli} --list-models".\n${combinedOutput}`
    )
  }

  if (result.status !== 0) {
    throw new Error(
      combinedOutput === ''
        ? `Failed to list PI models via "${config.piCli} --list-models".`
        : `Failed to list PI models via "${config.piCli} --list-models".\n${combinedOutput}`
    )
  }

  return parsePiListModelsOutput(combinedOutput)
}

function getConfiguredTextModels(config) {
  return uniqueNonEmpty([
    resolveRoleModelName(config, 'developer'),
    resolveRoleModelName(config, 'developerRetry'),
    resolveRoleModelName(config, 'developerFix'),
    resolveRoleModelName(config, 'tester'),
    resolveRoleModelName(config, 'testerCommit'),
  ])
}

async function listProviderModels(modelName, modelProfile) {
  const baseUrl = String(modelProfile?.baseUrl ?? '').replace(/\/$/, '')
  if (baseUrl === '') {
    return []
  }

  let response
  try {
    response = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: {
        ...(modelProfile?.apiKey ? { authorization: `Bearer ${modelProfile.apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error) {
    throw new Error(
      `Configured provider for model "${modelName}" is unreachable at ${baseUrl}/models: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  if (!response.ok) {
    const errorText = (await response.text()).trim()
    throw new Error(
      `Configured provider for model "${modelName}" returned ${response.status} from ${baseUrl}/models.${errorText !== '' ? ` ${errorText}` : ''}`
    )
  }

  const payload = await response.json()
  return extractModelIdsFromProviderResponse(payload)
}

async function validateProviderModels(config) {
  const configuredModels = uniqueNonEmpty([
    ...getConfiguredTextModels(config),
    config.visualReviewEnabled ? resolveRoleModelName(config, 'visualReview') : '',
  ])

  for (const modelName of configuredModels) {
    const modelProfile = config.modelProfiles?.[modelName] ?? null
    if (!modelProfile?.baseUrl) {
      continue
    }

    const availableModels = await listProviderModels(modelName, modelProfile)
    if (availableModels.length === 0) {
      throw new Error(
        `Configured provider for model "${modelName}" at ${String(modelProfile.baseUrl).replace(/\/$/, '')}/models returned no models.`
      )
    }

    if (!availableModels.includes(modelName)) {
      throw new Error(
        `Configured model "${modelName}" not found at provider ${String(modelProfile.baseUrl).replace(/\/$/, '')}/models. Available models: ${formatAvailableModels(availableModels)}`
      )
    }
  }
}

export async function runStartupPreflight(config) {
  if (config.transport === 'mock') {
    return
  }

  await ensurePiHomeModelsConfig()

  const availablePiModels = listPiModels(config)
  if (availablePiModels.length === 0) {
    throw new Error(
      `PI reported no models via "${config.piCli} --list-models". Ensure your PI home and model registry are configured before running the harness.`
    )
  }

  const configuredTextModels = getConfiguredTextModels(config)
  for (const modelName of configuredTextModels) {
    if (!availablePiModels.includes(modelName)) {
      throw new Error(
        `Configured PI model "${modelName}" is not available from "${config.piCli} --list-models". Available models: ${formatAvailableModels(availablePiModels)}`
      )
    }
  }

  await validateProviderModels(config)
}
