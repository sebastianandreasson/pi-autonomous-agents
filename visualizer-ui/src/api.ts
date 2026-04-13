import type { VisualizerSnapshot } from './types'

export async function fetchSnapshot(runId: string | null): Promise<VisualizerSnapshot> {
  const url = new URL('/api/state', window.location.origin)
  if (runId) {
    url.searchParams.set('runId', runId)
  }

  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
    },
    cache: 'no-store',
  })

  if (!response.ok) {
    throw new Error(`Snapshot request failed: ${response.status}`)
  }

  return await response.json() as VisualizerSnapshot
}

export function openSnapshotStream(
  runId: string | null,
  handlers: {
    onSnapshot: (snapshot: VisualizerSnapshot) => void
    onError?: () => void
  }
): EventSource {
  const url = new URL('/api/stream', window.location.origin)
  if (runId) {
    url.searchParams.set('runId', runId)
  }

  const source = new EventSource(url)
  source.onmessage = (event) => {
    handlers.onSnapshot(JSON.parse(event.data) as VisualizerSnapshot)
  }
  source.onerror = () => {
    handlers.onError?.()
  }
  return source
}
