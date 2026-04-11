#!/usr/bin/env node

import path from 'node:path'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))

const COMMANDS = new Map([
  ['once', 'pi-supervisor.mjs'],
  ['run', 'pi-supervisor.mjs'],
  ['report', 'pi-report.mjs'],
  ['clear-history', 'pi-clear-history.mjs'],
  ['visual-once', 'pi-visual-once.mjs'],
  ['adapter', 'pi-rpc-adapter.mjs'],
  ['visual-review-worker', 'pi-visual-review.mjs'],
])

function main() {
  const subcommand = process.argv[2] || 'once'
  const scriptName = COMMANDS.get(subcommand)
  if (!scriptName) {
    console.error(`Unknown pi-harness command "${subcommand}". Expected one of: ${[...COMMANDS.keys()].join(', ')}`)
    process.exitCode = 1
    return
  }

  const childArgs = [path.join(scriptDir, scriptName)]
  if (subcommand === 'once' || subcommand === 'run') {
    childArgs.push(subcommand)
  }

  const child = spawn(process.execPath, childArgs, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  })

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exitCode = code ?? 1
  })
}

main()
