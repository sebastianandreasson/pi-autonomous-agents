import type { FlowSnapshot } from '../types'

function stepMeta(step: FlowSnapshot['steps'][number]) {
  const latest = step.latestEvent
  if (!latest) {
    return 'waiting'
  }
  return [latest.kind, latest.status, latest.terminalReason].filter(Boolean).join('\n')
}

type FlowStripProps = {
  flow: FlowSnapshot
}

export function FlowStrip({ flow }: FlowStripProps) {
  return (
    <div className="flow">
      {flow.steps.map((step) => (
        <div key={step.key} className={`step ${step.status}`}>
          <div className="step-name">{step.label}</div>
          <div className="step-status">{step.status}</div>
          <div className="step-meta">{stepMeta(step)}</div>
        </div>
      ))}
    </div>
  )
}
