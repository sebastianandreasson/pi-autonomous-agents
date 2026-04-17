import { Fragment } from 'react'
import type { ActiveRun, GraphNode, TelemetryEvent } from '../types'

function eventStatus(status?: string) {
  if (status === 'success' || status === 'passed' || status === 'complete') return 'done'
  if (status === 'skipped' || status === 'not_run' || status === 'not_needed') return 'skipped'
  if (status === 'failed' || status === 'timed_out' || status === 'stalled' || status === 'blocked') return 'error'
  return ''
}

type DiagnosticsPanelProps = {
  activeRun: ActiveRun | null
  state: Record<string, unknown> | null
  transport?: string
  selectedRunId?: string
  summary: Record<string, unknown> | null
  output: string
  graph: GraphNode[]
  timeline: TelemetryEvent[]
  selectedEvent: unknown
  onSelectEvent: (eventId: string) => void
}

export function DiagnosticsPanel({
  activeRun,
  state,
  transport,
  selectedRunId,
  summary,
  output,
  graph,
  timeline,
  selectedEvent,
  onSelectEvent,
}: DiagnosticsPanelProps) {
  const runState = [
    ['runId', activeRun?.runId || String(state?.runId || '') || selectedRunId || '—'],
    ['status', activeRun?.status || String((state?.inProgress as { status?: string } | undefined)?.status || '') || '—'],
    ['activeKind', activeRun?.activeKind || '—'],
    ['activeRole', activeRun?.activeRole || '—'],
    ['reason', activeRun?.activeReason || '—'],
    ['transport', transport || '—'],
    ['lastStatus', activeRun?.lastStatus || String(state?.lastStatus || '') || '—'],
    ['lastCompleted', String(activeRun?.lastCompletedIteration || '—')],
  ]

  return (
    <details className="bottom card">
      <summary>Diagnostics</summary>
      <div className="grid diagnostics-grid">
        <div className="card card-tight">
          <div className="label">Run state</div>
          <div className="kv">
            {runState.map(([key, value]) => (
              <Fragment key={key}>
                <div>{key}</div>
                <div>{value}</div>
              </Fragment>
            ))}
          </div>
        </div>

        <div className="card card-tight">
          <div className="label">Iteration stage graph</div>
          <div className="graph">
            {graph.length > 0 ? graph.map((node) => {
              const retry = node.retryCount && node.retryCount > 0 ? `retry #${node.retryCount}` : ''
              const meta = [node.kind, retry, node.role, node.terminalReason].filter(Boolean).join('\n')
              return (
                <button key={node.id} type="button" className={`graph-node ${node.status}`} onClick={() => onSelectEvent(node.id)}>
                  <div className="step-name">{node.label}</div>
                  <div className="step-status">{node.status}</div>
                  <div className="step-meta">{[meta, node.notes].filter(Boolean).join('\n')}</div>
                </button>
              )
            }) : <div className="muted">No iteration graph yet.</div>}
          </div>
        </div>

        <div className="card card-tight">
          <div className="label">Recent telemetry timeline</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Iteration</th>
                  <th>Kind</th>
                  <th>Status</th>
                  <th>Tokens</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {timeline.length > 0 ? timeline.map((event) => (
                  <tr key={event._vizId} data-clickable="1" onClick={() => onSelectEvent(event._vizId)}>
                    <td>{event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : '—'}</td>
                    <td>{event.iteration ?? '—'}</td>
                    <td>{event.kind ?? '—'}</td>
                    <td><span className={`status-pill ${eventStatus(event.status)}`}>{event.status || '—'}</span></td>
                    <td>{Number.isFinite(event.totalTokens) ? event.totalTokens : '—'}</td>
                    <td className="muted">{event.notes || ''}</td>
                  </tr>
                )) : <tr><td colSpan={6} className="muted">No telemetry yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card card-tight">
          <div className="label">Selected event</div>
          <pre>{selectedEvent ? JSON.stringify(selectedEvent, null, 2) : 'Click graph node or timeline row.'}</pre>
        </div>

        <div className="card card-tight">
          <div className="label">Last iteration summary</div>
          <pre>{summary ? JSON.stringify(summary, null, 2) : 'No iteration summary yet.'}</pre>
        </div>

        <div className="card card-tight">
          <div className="label">Last agent output</div>
          <pre>{output || 'No agent output yet.'}</pre>
        </div>
      </div>
    </details>
  )
}
