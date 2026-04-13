#!/usr/bin/env node

import fs from 'node:fs/promises'
import process from 'node:process'

const readyFile = String(process.env.FAKE_PI_READY_FILE ?? '').trim()
const pidFile = String(process.env.FAKE_PI_PID_FILE ?? '').trim()
const sessionId = 'fake-session'
const sessionFile = String(process.env.FAKE_PI_SESSION_FILE ?? '').trim()
let promptStarted = false

if (process.argv.includes('--list-models')) {
  process.stdout.write('fake-model\n')
  process.exit(0)
}

async function writeMarker(filePath, contents) {
  if (filePath === '') {
    return
  }
  await fs.writeFile(filePath, contents, 'utf8')
}

function writeEvent(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

function writeResponse(id, data = {}, extra = {}) {
  writeEvent({
    type: 'response',
    id,
    success: true,
    data,
    ...extra,
  })
}

await writeMarker(pidFile, `${process.pid}\n`)

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk

  while (buffer.includes('\n')) {
    const newlineIndex = buffer.indexOf('\n')
    const line = buffer.slice(0, newlineIndex).trim()
    buffer = buffer.slice(newlineIndex + 1)

    if (line === '') {
      continue
    }

    const command = JSON.parse(line)
    switch (command.type) {
      case 'get_state':
        writeResponse(command.id, {
          sessionId,
          sessionFile,
          model: 'fake-model',
        })
        break
      case 'set_auto_retry':
        writeResponse(command.id, {})
        break
      case 'prompt':
        writeResponse(command.id, {})
        if (!promptStarted) {
          promptStarted = true
          writeEvent({ type: 'agent_start' })
          void writeMarker(readyFile, `${JSON.stringify({
            pid: process.pid,
            ppid: process.ppid,
          })}\n`)
        }
        break
      case 'abort':
        writeResponse(command.id, {})
        break
      case 'get_last_assistant_text':
        writeResponse(command.id, { text: '' })
        break
      default:
        writeResponse(command.id, {})
        break
    }
  }
})

setInterval(() => {
  if (promptStarted) {
    writeEvent({
      type: 'message_update',
      message: {
        role: 'assistant',
        content: [],
      },
    })
  }
}, 1000)
