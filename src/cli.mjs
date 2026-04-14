#!/usr/bin/env node

import path from 'node:path'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  registerOwnedChildProcess,
  signalChildProcess,
  watchParentProcess,
} from './pi-repo.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))

const COMMANDS = new Map([
  ['once', 'pi-supervisor.mjs'],
  ['run', 'pi-supervisor.mjs'],
  ['report', 'pi-report.mjs'],
  ['clear-history', 'pi-clear-history.mjs'],
  ['visual-once', 'pi-visual-once.mjs'],
  ['visualize', 'pi-visualizer.mjs'],
  ['debug-live', 'pi-debug-live.mjs'],
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
  const childStdio = subcommand === 'once' || subcommand === 'run'
    ? ['pipe', 'inherit', 'inherit']
    : 'inherit'

  const child = spawn(process.execPath, childArgs, {
    cwd: process.cwd(),
    env: process.env,
    stdio: childStdio,
  })
  registerOwnedChildProcess(child)

  let shuttingDown = false
  let forceKillTimer = null
  const stopWatchingParent = watchParentProcess(() => {
    shutdown({
      signal: 'SIGTERM',
      exitCode: 1,
    })
  })

  function shutdown({
    signal,
    exitCode,
  }) {
    if (shuttingDown) {
      return
    }

    shuttingDown = true
    stopWatchingParent()
    signalChildProcess(child.pid, signal)
    forceKillTimer = setTimeout(() => {
      signalChildProcess(child.pid, 'SIGKILL')
    }, 1000)
    if (typeof forceKillTimer.unref === 'function') {
      forceKillTimer.unref()
    }
    process.exitCode = exitCode
  }

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      shutdown({
        signal,
        exitCode: 128,
      })
    })
  }

  child.on('exit', (code, signal) => {
    stopWatchingParent()
    if (forceKillTimer) {
      clearTimeout(forceKillTimer)
    }
    if (signal) {
      process.exitCode = 128
      return
    }
    process.exitCode = code ?? 1
  })
}

main()
