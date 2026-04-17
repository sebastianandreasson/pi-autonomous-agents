import { useEffect, useMemo, useState } from 'react'
import { CurrentEdits } from './components/CurrentEdits'
import { DiagnosticsPanel } from './components/DiagnosticsPanel'
import { FlowStrip } from './components/FlowStrip'
import { LiveFeed } from './components/LiveFeed'
import { StepDetails } from './components/StepDetails'
import { TokenAnalyticsView } from './components/TokenAnalyticsView'
import { TodoList } from './components/TodoList'
import { getSelectedTodo, useVisualizerStore } from './store'
import type { TelemetryEvent } from './types'

function findSelectedEvent(snapshot: ReturnType<typeof useVisualizerStore.getState>['snapshot'], eventId: string | null) {
  if (!snapshot || !eventId) {
    return null
  }

  return snapshot.graph.nodes.find((node) => node.id === eventId)?.event as Record<string, unknown> | undefined
    ?? snapshot.recentTelemetry.find((event) => event._vizId === eventId) as Record<string, unknown> | undefined
    ?? null
}

export default function App() {
  const [tab, setTab] = useState<'overview' | 'diagnostics' | 'tokens'>('overview')
  const snapshot = useVisualizerStore((state) => state.snapshot)
  const selectedRunId = useVisualizerStore((state) => state.selectedRunId)
  const selectedTodoId = useVisualizerStore((state) => state.selectedTodoId)
  const selectedEventId = useVisualizerStore((state) => state.selectedEventId)
  const showThinking = useVisualizerStore((state) => state.showThinking)
  const collapseDeltas = useVisualizerStore((state) => state.collapseDeltas)
  const status = useVisualizerStore((state) => state.status)
  const error = useVisualizerStore((state) => state.error)
  const bootstrap = useVisualizerStore((state) => state.bootstrap)
  const setSelectedRunId = useVisualizerStore((state) => state.setSelectedRunId)
  const setSelectedTodoId = useVisualizerStore((state) => state.setSelectedTodoId)
  const setSelectedEventId = useVisualizerStore((state) => state.setSelectedEventId)
  const setShowThinking = useVisualizerStore((state) => state.setShowThinking)
  const setCollapseDeltas = useVisualizerStore((state) => state.setCollapseDeltas)
  const disconnect = useVisualizerStore((state) => state.disconnect)

  useEffect(() => {
    bootstrap().catch(() => {})
    return () => {
      disconnect()
    }
  }, [bootstrap, disconnect])

  const selectedTodo = useMemo(() => getSelectedTodo(snapshot, selectedTodoId), [selectedTodoId, snapshot])
  const selectedEvent = useMemo(() => findSelectedEvent(snapshot, selectedEventId), [selectedEventId, snapshot])
  const timeline = useMemo(() => {
    return [...(snapshot?.recentTelemetry || [])].reverse() as TelemetryEvent[]
  }, [snapshot])

  if (!snapshot) {
    return (
      <div className="wrap">
        <div className="header">
          <div>
            <div className="title">PI Harness Visualizer</div>
            <div className="subtitle">{status === 'error' ? error : 'Loading snapshot…'}</div>
          </div>
        </div>
      </div>
    )
  }

  const totalTodos = snapshot.todos.length
  const completedTodos = snapshot.todos.filter((todo) => todo.checked).length
  const stateChips = [
    ['Current activity', snapshot.flow.activeLabel || 'Idle'],
    ['Iteration', String(snapshot.flow.iteration || '—')],
    ['Phase', selectedTodo?.phase || String(snapshot.summary?.phase || '—')],
    ['Task status', selectedTodo ? (selectedTodo.checked ? 'Done' : (selectedTodo.active ? 'Active' : 'Pending')) : 'Info'],
  ]

  return (
    <div className={`wrap ${tab === 'tokens' ? 'wide' : ''}`}>
      <div className="header">
        <div>
          <div className="title">PI Harness Visualizer</div>
          <div className="subtitle">{snapshot.config.cwd}</div>
          <div className="tab-strip">
            {[
              ['overview', 'Overview'],
              ['diagnostics', 'Diagnostics'],
              ['tokens', 'Tokens'],
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`tab-chip ${tab === key ? 'active' : ''}`}
                onClick={() => {
                  setTab(key as 'overview' | 'diagnostics' | 'tokens')
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="toolbar">
          <select
            value={selectedRunId || ''}
            onChange={(event) => {
              void setSelectedRunId(event.target.value || null)
            }}
          >
            {snapshot.runs.map((run) => {
              const suffix = [run.status, run.phase].filter(Boolean).join(' · ')
              return (
                <option key={run.runId} value={run.runId}>
                  {run.runId.slice(0, 8)}{suffix ? ` — ${suffix}` : ''}
                </option>
              )
            })}
          </select>
          <div className="badge">
            <span className={`dot ${status === 'ready' ? 'active' : ''}`}></span>
            <span>{error || `Updated ${new Date(snapshot.now).toLocaleTimeString()}`}</span>
          </div>
        </div>
      </div>

      {tab === 'overview' ? (
        <div className="grid main-grid">
          <div className="card">
            <div className="label">TODOS · {completedTodos}/{totalTodos} done</div>
            <TodoList
              todos={snapshot.todos}
              selectedTodoId={selectedTodo?.id || null}
              onSelect={setSelectedTodoId}
            />
          </div>

          <div className="card">
            <div className="label">Focused todo</div>
            <div className="value small">{selectedTodo?.text || 'No todo selected.'}</div>
            <div className="state-bar">
              {stateChips.map(([label, value]) => (
                <div key={label} className="state-chip">{label}: {value}</div>
              ))}
            </div>
            <FlowStrip
              flow={snapshot.flow}
              selectedEventId={selectedEventId}
              onSelectStep={setSelectedEventId}
            />
            <StepDetails event={selectedEvent} />
            <div className="detail-split">
              <div className="card card-tight no-margin">
                <div className="label">Live worker feed</div>
                <LiveFeed
                  feed={snapshot.liveFeed}
                  showThinking={showThinking}
                  collapseDeltas={collapseDeltas}
                  onShowThinkingChange={setShowThinking}
                  onCollapseDeltasChange={setCollapseDeltas}
                />
              </div>
              <div className="card card-tight no-margin">
                <div className="label">Current edits for focused todo</div>
                <CurrentEdits edits={snapshot.currentEdits} />
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {tab === 'diagnostics' ? (
        <DiagnosticsPanel
          activeRun={snapshot.activeRun}
          state={snapshot.state}
          transport={snapshot.config.transport}
          selectedRunId={snapshot.config.selectedRunId}
          summary={snapshot.summary}
          output={snapshot.lastOutput}
          graph={snapshot.graph.nodes}
          timeline={timeline}
          selectedEvent={selectedEvent}
          onSelectEvent={setSelectedEventId}
        />
      ) : null}

      {tab === 'tokens' ? (
        <TokenAnalyticsView
          breakdown={snapshot.tokenBreakdown}
          analytics={snapshot.tokenAnalytics}
        />
      ) : null}
    </div>
  )
}
