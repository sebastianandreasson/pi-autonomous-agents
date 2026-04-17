import { TokenHeatmap } from './TokenHeatmap'
import type { TokenAnalytics, TokenBreakdown } from '../types'

type TokenAnalyticsViewProps = {
  breakdown: TokenBreakdown
  analytics: TokenAnalytics
}

function formatTokenCount(value: number | undefined) {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    return '0'
  }
  const rounded = Math.round(number * 10) / 10
  return rounded % 1 === 0 ? String(Math.round(rounded)) : rounded.toFixed(1)
}

function formatTime(value: string | undefined) {
  const date = new Date(String(value ?? ''))
  if (!Number.isFinite(date.getTime())) {
    return '—'
  }
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function TokenAnalyticsView({ breakdown, analytics }: TokenAnalyticsViewProps) {
  const timeline = analytics?.timeline || []
  const todos = analytics?.todos || []
  const maxTimelineTokens = Math.max(1, ...timeline.map((point) => point.totalTokens || 0))
  const maxTodoTokens = Math.max(1, ...todos.map((todo) => todo.totalTokens || 0))

  return (
    <div className="token-page">
      <div className="token-hero">
        <div className="token-hero-copy">
          <div className="label">Token Analytics</div>
          <div className="token-hero-title">Run-scoped token spend</div>
          <div className="token-hero-subtitle">
            Exact request totals from Pi usage, with time-series and per-finished-todo rollups.
          </div>
        </div>
        <div className="token-hero-stats">
          <div className="token-stat-card">
            <div className="label">Total</div>
            <div className="value">{formatTokenCount(breakdown?.totals?.totalTokens)}</div>
          </div>
          <div className="token-stat-card">
            <div className="label">Requests</div>
            <div className="value">{formatTokenCount(analytics?.source?.requestCount)}</div>
          </div>
          <div className="token-stat-card">
            <div className="label">Finished todos</div>
            <div className="value">{todos.length}</div>
          </div>
        </div>
      </div>

      <div className="token-page-grid">
        <div className="card token-timeline-card">
          <div className="label">Token usage over time</div>
          <div className="token-timeline">
            {timeline.length > 0 ? timeline.map((point) => {
              const height = Math.max(8, (point.totalTokens / maxTimelineTokens) * 100)
              return (
                <div key={point.key} className="token-timeline-point" title={`${point.label} · ${formatTokenCount(point.totalTokens)} total`}>
                  <div className="token-timeline-bar">
                    <div className="token-timeline-fill" style={{ height: `${height}%` }}></div>
                  </div>
                  <div className="token-timeline-label">{point.label}</div>
                  <div className="token-timeline-value">{formatTokenCount(point.totalTokens)}</div>
                </div>
              )
            }) : <div className="muted">No request-timestamp data yet.</div>}
          </div>
        </div>

        <div className="card token-todos-card">
          <div className="label">Finished todos</div>
          <div className="token-todo-list">
            {todos.length > 0 ? todos.map((todo) => {
              const width = Math.max(6, (todo.totalTokens / maxTodoTokens) * 100)
              return (
                <div key={todo.key} className="token-todo-row">
                  <div className="token-todo-head">
                    <div className="token-todo-text">
                      <div className="token-todo-title">{todo.task}</div>
                      <div className="token-todo-meta">
                        Iteration {todo.iteration} · {todo.phase || 'No phase'} · {todo.requestCount} requests · {formatTime(todo.firstTimestamp)}–{formatTime(todo.lastTimestamp)}
                      </div>
                    </div>
                    <div className="token-todo-total">{formatTokenCount(todo.totalTokens)}</div>
                  </div>
                  <div className="token-bar-track">
                    <div className="token-bar-fill" style={{ width: `${width}%` }}></div>
                  </div>
                  <div className="token-todo-meta token-todo-meta-foot">
                    input {formatTokenCount(todo.inputTokens)} · output {formatTokenCount(todo.outputTokens)} · roles {todo.roles.join(', ') || '—'}
                  </div>
                </div>
              )
            }) : <div className="muted">No successful iteration summaries with matched request telemetry yet.</div>}
          </div>
        </div>
      </div>

      <TokenHeatmap breakdown={breakdown} />
    </div>
  )
}
