type StepDetailsProps = {
  event: Record<string, unknown> | null
}

function readField(event: Record<string, unknown> | null, key: string) {
  return String(event?.[key] ?? '').trim()
}

export function StepDetails({ event }: StepDetailsProps) {
  if (!event) {
    return null
  }

  const kind = readField(event, 'kind') || 'event'
  const status = readField(event, 'status') || 'unknown'
  const notes = readField(event, 'notes')
  const outputExcerpt = readField(event, 'outputExcerpt')
  const terminalReason = readField(event, 'terminalReason')

  return (
    <div className="card card-tight step-details-card">
      <div className="label">Selected step details</div>
      <div className="step-details-summary">{kind} · {status}</div>
      {terminalReason ? <div className="step-details-meta">terminalReason: {terminalReason}</div> : null}
      {notes ? (
        <>
          <div className="step-details-section">Notes</div>
          <pre>{notes}</pre>
        </>
      ) : null}
      {outputExcerpt ? (
        <>
          <div className="step-details-section">Output excerpt</div>
          <pre>{outputExcerpt}</pre>
        </>
      ) : null}
    </div>
  )
}
