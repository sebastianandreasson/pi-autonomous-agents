import { useEffect, useState } from 'react'
import type { FlowSnapshot } from '../types'

function formatDuration(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return `${minutes}:${String(remainder).padStart(2, '0')}`
}

function stepMeta(step: FlowSnapshot['steps'][number], nowMs: number) {
  const latest = step.latestEvent
  const lines = []

  if (step.status === 'active' && step.activeStartedAt) {
    const startedAtMs = Date.parse(step.activeStartedAt)
    if (Number.isFinite(startedAtMs)) {
      lines.push(`Running ${formatDuration((nowMs - startedAtMs) / 1000)}`)
    }
  } else if (Number.isFinite(Number(step.durationSeconds))) {
    lines.push(`Took ${formatDuration(Number(step.durationSeconds))}`)
  }

  if (latest) {
    lines.push(...[latest.kind, latest.status, latest.terminalReason].filter(Boolean))
  }

  return lines.join('\n')
}

type FlowStripProps = {
  flow: FlowSnapshot
  selectedEventId?: string | null
  onSelectStep?: (eventId: string) => void
}

export function FlowStrip({ flow, selectedEventId, onSelectStep }: FlowStripProps) {
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    if (!flow.steps.some((step) => step.status === 'active' && step.activeStartedAt)) {
      return
    }
    const interval = window.setInterval(() => {
      setNowMs(Date.now())
    }, 1000)
    return () => {
      window.clearInterval(interval)
    }
  }, [flow.steps])

  return (
    <div className="flow">
      {flow.steps.map((step) => {
        const clickable = !!step.latestEventId && typeof onSelectStep === 'function'
        const selected = step.latestEventId && step.latestEventId === selectedEventId
        const className = `step ${step.status}${selected ? ' selected' : ''}${clickable ? ' clickable' : ''}`
        return (
          <button
            key={step.key}
            type="button"
            className={className}
            onClick={() => {
              if (clickable && step.latestEventId) {
                onSelectStep(step.latestEventId)
              }
            }}
          >
            <div className="step-name">{step.label}</div>
            <div className="step-status">{step.status}</div>
            <div className="step-meta">{stepMeta(step, nowMs)}</div>
          </button>
        )
      })}
    </div>
  )
}
