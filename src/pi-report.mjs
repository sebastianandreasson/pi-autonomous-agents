#!/usr/bin/env node

import { loadConfig } from './pi-config.mjs'
import { readTelemetry } from './pi-telemetry.mjs'

function summarizeBy(items, key) {
  const counts = new Map()
  for (const item of items) {
    const label = String(item[key] ?? 'unknown')
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])
}

async function main() {
  const config = loadConfig('once')
  const events = await readTelemetry(config)
  const recent = events.slice(-config.reportLimit)

  console.log(`Telemetry file: ${config.telemetryJsonl}`)
  console.log(`Total events: ${events.length}`)
  console.log(`Recent events shown: ${recent.length}`)

  if (recent.length === 0) {
    return
  }

  console.log('\nStatus counts:')
  for (const [status, count] of summarizeBy(recent, 'status')) {
    console.log(`- ${status}: ${count}`)
  }

  console.log('\nKinds:')
  for (const [kind, count] of summarizeBy(recent, 'kind')) {
    console.log(`- ${kind}: ${count}`)
  }

  const last = recent.at(-1)
  if (!last) {
    return
  }

  console.log('\nLast event:')
  console.log(`- timestamp: ${last.timestamp}`)
  console.log(`- iteration: ${last.iteration}`)
  console.log(`- phase: ${last.phase}`)
  console.log(`- kind: ${last.kind}`)
  console.log(`- status: ${last.status}`)
  console.log(`- notes: ${last.notes}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
