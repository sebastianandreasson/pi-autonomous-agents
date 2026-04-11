import fs from 'node:fs/promises'

const CSV_HEADER = 'timestamp,iteration,phase,kind,status,transport,session_id,timed_out,exit_code,duration_seconds,commit_before,commit_after,repo_changed,changed_files_count,verification_status,retry_count,role,model,tool_calls,tool_errors,message_updates,stop_reason,loop_detected,loop_signature,tester_verdict,commit_plan_found,terminal_reason,notes\n'

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

  await fs.appendFile(config.logFile, '', 'utf8')
  await fs.appendFile(config.telemetryJsonl, '', 'utf8')

  try {
    await fs.access(config.telemetryCsv)
  } catch {
    await fs.writeFile(config.telemetryCsv, CSV_HEADER, 'utf8')
  }
}

export async function appendTelemetry(config, event) {
  const jsonLine = `${JSON.stringify(event)}\n`
  await fs.appendFile(config.telemetryJsonl, jsonLine, 'utf8')

  const csvRow = [
    event.timestamp,
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
    event.notes,
  ].map(csvEscape).join(',')

  await fs.appendFile(config.telemetryCsv, `${csvRow}\n`, 'utf8')
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
