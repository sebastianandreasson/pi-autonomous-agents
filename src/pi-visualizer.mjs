#!/usr/bin/env node

import process from 'node:process'
import { loadConfig } from './pi-config.mjs'
import { startVisualizerServer } from './pi-visualizer-server.mjs'

async function main() {
  const config = loadConfig('once')
  const visualizer = await startVisualizerServer(config)
  process.stdout.write(`PI Harness visualizer listening on ${visualizer.url}\n`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
