import type { TokenBreakdown, TokenBucket } from '../types'

type TokenHeatmapProps = {
  breakdown: TokenBreakdown
}

function formatTokenCount(value: number | undefined) {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    return '0'
  }
  const rounded = Math.round(number * 10) / 10
  return rounded % 1 === 0 ? String(Math.round(rounded)) : rounded.toFixed(1)
}

function formatPercent(value: number | undefined) {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    return '0%'
  }
  return `${Math.round(number * 100)}%`
}

function HeatList({
  title,
  items,
  emptyLabel,
  maxItems = 8,
}: {
  title: string
  items: TokenBucket[]
  emptyLabel: string
  maxItems?: number
}) {
  const visibleItems = items.slice(0, maxItems)
  const maxTokens = visibleItems[0]?.totalTokens || 0

  return (
    <div className="card card-tight token-section">
      <div className="label">{title}</div>
      <div className="token-list">
        {visibleItems.length > 0 ? visibleItems.map((item) => {
          const width = maxTokens > 0 ? Math.max(6, (item.totalTokens / maxTokens) * 100) : 0
          return (
            <div key={`${title}-${item.key}`} className="token-row">
              <div className="token-row-head">
                <div className="token-row-label" title={item.label}>{item.label}</div>
                <div className="token-row-value">{formatTokenCount(item.totalTokens)}</div>
              </div>
              <div className="token-bar-track">
                <div className="token-bar-fill" style={{ width: `${width}%` }}></div>
              </div>
              <div className="token-row-meta">
                input {formatTokenCount(item.inputTokens)} · output {formatTokenCount(item.outputTokens)} · hits {formatTokenCount(item.eventCount)}
              </div>
            </div>
          )
        }) : <div className="muted">{emptyLabel}</div>}
      </div>
    </div>
  )
}

export function TokenHeatmap({ breakdown }: TokenHeatmapProps) {
  const totals = breakdown?.totals
  const coverage = breakdown?.coverage
  const buckets = breakdown?.breakdowns
  const mode = String(breakdown?.source?.mode || 'token_usage')
  const usingRequestTelemetry = mode === 'request_telemetry'
  const eventCountLabel = usingRequestTelemetry ? 'Requests' : 'Token events'
  const eventCountValue = usingRequestTelemetry
    ? breakdown?.source?.requestCount
    : breakdown?.source?.eventCount
  const coverageLabel = usingRequestTelemetry ? 'Input coverage' : 'File coverage'
  const attributionTitle = usingRequestTelemetry ? 'By span source' : 'By attribution'
  const roleTitle = usingRequestTelemetry ? 'By role' : 'By supervisor phase'
  const phaseTitle = usingRequestTelemetry ? 'By phase' : 'By model'
  const roleItems = usingRequestTelemetry ? (buckets?.byRole || []) : (buckets?.byKind || [])
  const phaseItems = usingRequestTelemetry ? (buckets?.byPhase || []) : (buckets?.byModel || [])
  const coverageText = usingRequestTelemetry
    ? `Exact request totals from Pi message usage. File/tool buckets estimated from exact prompt spans using proportional input-context share. Input-linked file coverage: ${formatTokenCount(coverage?.fileAttributedTokens)} attributed vs ${formatTokenCount(coverage?.unattributedTokens)} unattributed.`
    : `Attributed from live token events near tool/file context. File-attributed tokens: ${formatTokenCount(coverage?.fileAttributedTokens)}. Unattributed tokens: ${formatTokenCount(coverage?.unattributedTokens)}.`

  return (
    <div className="card">
      <div className="label">Token Heatmap</div>
      <div className="state-bar token-summary">
        <div className="state-chip">Total: {formatTokenCount(totals?.totalTokens)}</div>
        <div className="state-chip">Input: {formatTokenCount(totals?.inputTokens)}</div>
        <div className="state-chip">Output: {formatTokenCount(totals?.outputTokens)}</div>
        <div className="state-chip">{eventCountLabel}: {formatTokenCount(eventCountValue)}</div>
        <div className="state-chip">{coverageLabel}: {formatPercent(coverage?.fileAttributionRatio)}</div>
      </div>
      <div className="token-coverage">{coverageText}</div>
      <div className="token-grid">
        <HeatList title={attributionTitle} items={buckets?.byAttribution || []} emptyLabel="No token attribution yet." maxItems={6} />
        <HeatList title={roleTitle} items={roleItems} emptyLabel="No role token data yet." maxItems={8} />
        <HeatList title={phaseTitle} items={phaseItems} emptyLabel="No phase token data yet." maxItems={8} />
        <HeatList title="By tool" items={buckets?.byTool || []} emptyLabel="No tool-linked token data yet." maxItems={8} />
        <HeatList title="By model" items={buckets?.byModel || []} emptyLabel="No model token data yet." maxItems={8} />
        <HeatList title="Top files" items={buckets?.byFile || []} emptyLabel="No file-linked token data yet." maxItems={10} />
        <HeatList title="Top directories" items={buckets?.byDirectory || []} emptyLabel="No directory-linked token data yet." maxItems={10} />
      </div>
    </div>
  )
}
