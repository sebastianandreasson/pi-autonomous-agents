import fs from 'node:fs/promises'
import path from 'node:path'

const CSV_HEADER = 'timestamp,run_id,iteration,phase,kind,status,transport,session_id,timed_out,exit_code,duration_seconds,commit_before,commit_after,repo_changed,changed_files_count,verification_status,retry_count,role,model,tool_calls,tool_errors,message_updates,stop_reason,loop_detected,loop_signature,tester_verdict,commit_plan_found,terminal_reason,risk_warnings,notes\n'

function csvEscape(value) {
  const text = String(value ?? '')
  return `"${text.replaceAll('"', '""')}"`
}

export async function ensureTelemetryFiles(config) {
  await fs.writeFile(config.lastAgentOutputFile, '', 'utf8')
  await fs.writeFile(config.lastVerificationOutputFile, '', 'utf8')
  await fs.writeFile(config.changedFilesFile, '', 'utf8')
  await fs.writeFile(config.lastPromptFile, '', 'utf8')
  await fs.writeFile(config.lastIterationSummaryFile, '', 'utf8')

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
    event.notes,
  ].map(csvEscape).join(',')

  await fs.appendFile(config.telemetryCsv, `${csvRow}\n`, 'utf8')
  if (config.runTelemetryCsv && config.runTelemetryCsv !== config.telemetryCsv) {
    await fs.appendFile(config.runTelemetryCsv, `${csvRow}\n`, 'utf8')
  }
}

export async function readTelemetry(config) {
  try {
    const raw = await fs.readFile(config.telemetryJsonl, 'utf8')
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}
