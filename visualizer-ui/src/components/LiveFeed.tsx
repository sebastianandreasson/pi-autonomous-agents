import { useEffect, useMemo, useState, useRef } from 'react'

const STICKY_BOTTOM_THRESHOLD_PX = 40
import type { LiveFeedEntry } from '../types'

type NormalizedFeedEntry = LiveFeedEntry & {
  type: string
  text: string
  count: number
}

function compareFeedEntries(left: LiveFeedEntry, right: LiveFeedEntry) {
  const leftSeq = Number(left.seq ?? Number.NaN)
  const rightSeq = Number(right.seq ?? Number.NaN)
  const leftHasSeq = Number.isFinite(leftSeq)
  const rightHasSeq = Number.isFinite(rightSeq)
  if (leftHasSeq && rightHasSeq && leftSeq !== rightSeq) {
    return leftSeq - rightSeq
  }
  return String(left.timestamp || '').localeCompare(String(right.timestamp || ''))
}

function normalizeFeedEntry(entry: LiveFeedEntry): NormalizedFeedEntry {
  return {
    ...entry,
    type: String(entry.type || 'event'),
    text: String(entry.text || ''),
    count: 1,
  }
}

function collapseFeedEntries(entries: LiveFeedEntry[]): NormalizedFeedEntry[] {
  const collapsed: NormalizedFeedEntry[] = []
  for (const raw of entries) {
    const entry = normalizeFeedEntry(raw)
    const prev = collapsed.at(-1)
    const canMerge = prev
      && (entry.type === 'text_delta' || entry.type === 'thinking_delta')
      && prev.type === entry.type
      && prev.role === entry.role
      && prev.kind === entry.kind

    if (canMerge) {
      prev.text += entry.text
      prev.count += 1
      prev.timestamp = entry.timestamp
      continue
    }

    collapsed.push(entry)
  }
  return collapsed
}

function entryKey(entry: NormalizedFeedEntry, index: number) {
  return String(entry.seq ?? `${entry.timestamp || 'na'}:${entry.type}:${entry.toolName || ''}:${index}`)
}

function PinnedTool({ feed }: { feed: LiveFeedEntry[] }) {
  const latest = [...feed].sort(compareFeedEntries).reverse().find((entry) => {
    return entry.type === 'tool_start' || entry.type === 'tool_update' || entry.type === 'tool_end'
  })

  if (!latest) {
    return <div className="muted">No tool activity yet.</div>
  }

  return (
    <div className="pinned-tool">
      <div className="pinned-tool-name">{latest.toolName || 'tool'}</div>
      <div className="pinned-tool-meta">
        {latest.type || 'event'} · {latest.timestamp ? new Date(latest.timestamp).toLocaleTimeString() : '—'}
      </div>
      <div className="pinned-tool-text">{latest.text || ''}</div>
    </div>
  )
}

type LiveFeedProps = {
  feed: LiveFeedEntry[]
  showThinking: boolean
  collapseDeltas: boolean
  onShowThinkingChange: (value: boolean) => void
  onCollapseDeltasChange: (value: boolean) => void
}

export function LiveFeed({
  feed,
  showThinking,
  collapseDeltas,
  onShowThinkingChange,
  onCollapseDeltasChange,
}: LiveFeedProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)

  const visibleFeed = useMemo(() => {
    const sorted = [...feed].sort(compareFeedEntries)
    const filtered = sorted.filter((entry) => showThinking || entry.type !== 'thinking_delta')
    return collapseDeltas ? collapseFeedEntries(filtered) : filtered.map(normalizeFeedEntry)
  }, [collapseDeltas, feed, showThinking])

  useEffect(() => {
    const node = containerRef.current
    if (!node) {
      return
    }
    if (stickToBottomRef.current) {
      node.scrollTop = node.scrollHeight
    }
  }, [visibleFeed])

  useEffect(() => {
    const node = containerRef.current
    if (!node) {
      return
    }

    const updateStickyState = () => {
      const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight
      const stickToBottom = distanceFromBottom < STICKY_BOTTOM_THRESHOLD_PX
      stickToBottomRef.current = stickToBottom
      setShowJumpToLatest(!stickToBottom)
    }

    updateStickyState()
    node.addEventListener('scroll', updateStickyState, { passive: true })
    return () => {
      node.removeEventListener('scroll', updateStickyState)
    }
  }, [])

  return (
    <>
      <div className="feed-toolbar">
        <label className="feed-toggle">
          <input
            type="checkbox"
            checked={showThinking}
            onChange={(event) => onShowThinkingChange(event.target.checked)}
          />
          <span>Show thinking</span>
        </label>
        <label className="feed-toggle">
          <input
            type="checkbox"
            checked={collapseDeltas}
            onChange={(event) => onCollapseDeltasChange(event.target.checked)}
          />
          <span>Collapse deltas</span>
        </label>
      </div>

      {showJumpToLatest ? (
        <div className="feed-jump-row">
          <button
            type="button"
            className="feed-jump-button"
            onClick={() => {
              const node = containerRef.current
              if (!node) {
                return
              }
              node.scrollTop = node.scrollHeight
              stickToBottomRef.current = true
              setShowJumpToLatest(false)
            }}
          >
            Jump to latest
          </button>
        </div>
      ) : null}

      <div ref={containerRef} className="feed">
        {visibleFeed.length > 0 ? visibleFeed.map((entry, index) => {
          const meta = [entry.role, entry.kind, entry.toolName].filter(Boolean).join(' · ')
          return (
            <div key={entryKey(entry, index)} className="feed-item">
              <div className="feed-head">
                <div className={`feed-type ${entry.type}`}>{entry.type}</div>
                {entry.count > 1 ? <div className="feed-count">x{entry.count}</div> : null}
              </div>
              <div className="feed-meta">
                {entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : '—'}
                {meta ? ` · ${meta}` : ''}
              </div>
              <div className="feed-text">{entry.text}</div>
            </div>
          )
        }) : <div className="muted">No live feed yet.</div>}
      </div>

      <div className="card card-tight">
        <div className="label">Latest tool output</div>
        <PinnedTool feed={feed} />
      </div>
    </>
  )
}
