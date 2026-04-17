import fs from 'node:fs/promises'
import path from 'node:path'
import { ensureTokenUsageFiles } from './pi-token-analysis.mjs'

const CSV_HEADER = 'timestamp,run_id,iteration,phase,kind,status,transport,session_id,timed_out,exit_code,duration_seconds,commit_before,commit_after,repo_changed,changed_files_count,verification_status,retry_count,role,model,input_tokens,output_tokens,total_tokens,cache_read_tokens,cache_write_tokens,tool_calls,tool_errors,message_updates,stop_reason,loop_detected,loop_signature,tester_verdict,commit_plan_found,terminal_reason,risk_warnings,artifact_path,output_excerpt,notes\n'
const DEFAULT_JSONL_TAIL_BYTES = 512 * 1024
const JSONL_TAIL_CHUNK_BYTES = 64 * 1024

function csvEscape(value) {
  const text = String(value ?? '')
  return `"${text.replaceAll('"', '""')}"`
}

export async function ensureTelemetryFiles(config) {
  await fs.writeFile(config.lastAgentOutputFile, '', 'utf8')
  if (config.runLastAgentOutputFile && config.runLastAgentOutputFile !== config.lastAgentOutputFile) {
    await fs.mkdir(path.dirname(config.runLastAgentOutputFile), { recursive: true })
    await fs.writeFile(config.runLastAgentOutputFile, '', 'utf8')
  }
  if (config.runLiveFeedFile) {
    await fs.mkdir(path.dirname(config.runLiveFeedFile), { recursive: true })
    await fs.writeFile(config.runLiveFeedFile, '', 'utf8')
  }
  await fs.writeFile(config.lastVerificationOutputFile, '', 'utf8')
  await fs.writeFile(config.changedFilesFile, '', 'utf8')
  await fs.writeFile(config.lastPromptFile, '', 'utf8')
  await fs.writeFile(config.lastIterationSummaryFile, '', 'utf8')
  if (config.failureArtifactDir) {
    await fs.mkdir(config.failureArtifactDir, { recursive: true })
  }

  await fs.mkdir(path.dirname(config.logFile), { recursive: true })
  await fs.mkdir(path.dirname(config.telemetryJsonl), { recursive: true })
  await fs.mkdir(path.dirname(config.telemetryCsv), { recursive: true })
  await fs.appendFile(config.logFile, '', 'utf8')
  await fs.appendFile(config.telemetryJsonl, '', 'utf8')
  if (config.runTelemetryJsonl && config.runTelemetryJsonl !== config.telemetryJsonl) {
    await fs.mkdir(path.dirname(config.runTelemetryJsonl), { recursive: true })
    await fs.appendFile(config.runTelemetryJsonl, '', 'utf8')
  }

  try {
    await fs.access(config.telemetryCsv)
  } catch {
    await fs.writeFile(config.telemetryCsv, CSV_HEADER, 'utf8')
  }

  if (config.runTelemetryCsv && config.runTelemetryCsv !== config.telemetryCsv) {
    try {
      await fs.access(config.runTelemetryCsv)
    } catch {
      await fs.mkdir(path.dirname(config.runTelemetryCsv), { recursive: true })
      await fs.writeFile(config.runTelemetryCsv, CSV_HEADER, 'utf8')
    }
  }

  await ensureTokenUsageFiles(config)
}

export async function appendTelemetry(config, event) {
  const jsonLine = `${JSON.stringify(event)}\n`
  await fs.appendFile(config.telemetryJsonl, jsonLine, 'utf8')
  if (config.runTelemetryJsonl && config.runTelemetryJsonl !== config.telemetryJsonl) {
    await fs.appendFile(config.runTelemetryJsonl, jsonLine, 'utf8')
  }

  const csvRow = [
    event.timestamp,
    event.runId,
    event.iteration,
    event.phase,
    event.kind,
    event.status,
    event.transport,
    event.sessionId,
    event.timedOut,
    event.exitCode,
    event.durationSeconds,
    event.commitBefore,
    event.commitAfter,
    event.repoChanged,
    event.changedFilesCount,
    event.verificationStatus,
    event.retryCount,
    event.role,
    event.model,
    event.inputTokens,
    event.outputTokens,
    event.totalTokens,
    event.cacheReadTokens,
    event.cacheWriteTokens,
    event.toolCalls,
    event.toolErrors,
    event.messageUpdates,
    event.stopReason,
    event.loopDetected,
    event.loopSignature,
    event.testerVerdict,
    event.commitPlanFound,
    event.terminalReason,
    event.riskWarnings,
    event.artifactPath,
    event.outputExcerpt,
    event.notes,
  ].map(csvEscape).join(',')

  await fs.appendFile(config.telemetryCsv, `${csvRow}\n`, 'utf8')
  if (config.runTelemetryCsv && config.runTelemetryCsv !== config.telemetryCsv) {
    await fs.appendFile(config.runTelemetryCsv, `${csvRow}\n`, 'utf8')
  }
}

function parseJsonlLines(raw, { dropFirstLine = false, maxItems = Infinity } = {}) {
  const lines = raw.split('\n')
  if (dropFirstLine && lines.length > 0) {
    lines.shift()
  }

  const items = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') {
      continue
    }
    try {
      items.push(JSON.parse(trimmed))
    } catch {
      // Ignore partial/truncated JSONL records while file is actively being appended.
    }
  }

  return Number.isFinite(maxItems) ? items.slice(-maxItems) : items
}

export async function readJsonlTail(filePath, options = {}) {
  const maxItems = Number.isFinite(Number(options.maxItems)) ? Number(options.maxItems) : 200
  const maxBytes = Number.isFinite(Number(options.maxBytes)) ? Number(options.maxBytes) : DEFAULT_JSONL_TAIL_BYTES

  let handle
  try {
    handle = await fs.open(filePath, 'r')
    const stat = await handle.stat()
    if (!Number.isFinite(stat.size) || stat.size <= 0) {
      return []
    }

    let position = stat.size
    let text = ''
    let newlineCount = 0

    while (position > 0 && Buffer.byteLength(text, 'utf8') < maxBytes && newlineCount <= (maxItems + 1)) {
      const remainingBudget = maxBytes - Buffer.byteLength(text, 'utf8')
      const chunkSize = Math.min(JSONL_TAIL_CHUNK_BYTES, position, remainingBudget)
      if (chunkSize <= 0) {
        break
      }

      position -= chunkSize
      const buffer = Buffer.alloc(chunkSize)
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, position)
      text = buffer.subarray(0, bytesRead).toString('utf8') + text
      newlineCount = (text.match(/\n/g) ?? []).length
    }

    return parseJsonlLines(text, {
      dropFirstLine: position > 0,
      maxItems,
    })
  } catch {
    return []
  } finally {
    await handle?.close().catch(() => {})
  }
}

export async function readTelemetry(config) {
  try {
    const raw = await fs.readFile(config.telemetryJsonl, 'utf8')
    return parseJsonlLines(raw)
  } catch {
    return []
  }
}

export async function readTelemetryTail(config, maxItems = 200, maxBytes = DEFAULT_JSONL_TAIL_BYTES) {
  return await readJsonlTail(config.telemetryJsonl, { maxItems, maxBytes })
}
