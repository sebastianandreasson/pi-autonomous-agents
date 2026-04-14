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

  const iterationSummaries = recent.filter((event) => event.kind === 'iteration_summary')
  const warningsByIteration = iterationSummaries
    .filter((event) => String(event.riskWarnings ?? '').trim() !== '')

  if (warningsByIteration.length > 0) {
    console.log('\nLarge file warnings:')
    for (const event of warningsByIteration.slice(-5)) {
      console.log(`- iteration ${event.iteration}: ${event.riskWarnings}`)
    }
  }

  const failureArtifacts = recent
    .filter((event) => String(event.artifactPath ?? '').trim() !== '')
    .slice(-5)

  if (failureArtifacts.length > 0) {
    console.log('\nFailure artifacts:')
    for (const event of failureArtifacts) {
      const excerpt = String(event.outputExcerpt ?? '').trim()
      console.log(`- iteration ${event.iteration} ${event.kind}: ${event.artifactPath}`)
      if (excerpt !== '') {
        console.log(`  excerpt: ${excerpt.split('\n')[0]}`)
      }
    }
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
