#!/usr/bin/env node

import { loadConfig } from './pi-config.mjs'
import { ensureRepo } from './pi-repo.mjs'
import { clearHarnessHistory } from './pi-history.mjs'

async function main() {
  const config = loadConfig('once')
  ensureRepo(config.cwd)

  const result = await clearHarnessHistory(config)

  console.log(`Cleared harness history for ${result.clearedTargets.length} existing paths.`)
  if (result.clearedTargets.length > 0) {
    console.log('Cleared:')
    for (const targetPath of result.clearedTargets) {
      console.log(`- ${targetPath}`)
    }
  }
  console.log('Verification passed: no configured harness history paths remain.')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
