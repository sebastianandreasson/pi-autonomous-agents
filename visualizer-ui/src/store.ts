import { create } from 'zustand'
import { fetchSnapshot, openSnapshotStream } from './api'
import type { TodoItem, VisualizerSnapshot } from './types'

type Status = 'idle' | 'loading' | 'ready' | 'error'

type VisualizerStore = {
  snapshot: VisualizerSnapshot | null
  selectedRunId: string | null
  selectedTodoId: string | null
  selectedEventId: string | null
  showThinking: boolean
  collapseDeltas: boolean
  status: Status
  error: string | null
  eventSource: EventSource | null
  bootstrap: () => Promise<void>
  setSelectedRunId: (runId: string | null) => Promise<void>
  setSelectedTodoId: (todoId: string | null) => void
  setSelectedEventId: (eventId: string | null) => void
  setShowThinking: (value: boolean) => void
  setCollapseDeltas: (value: boolean) => void
  applySnapshot: (snapshot: VisualizerSnapshot) => void
  disconnect: () => void
}

function selectTodo(snapshot: VisualizerSnapshot, currentTodoId: string | null): string | null {
  const todos = Array.isArray(snapshot.todos) ? snapshot.todos : []
  if (currentTodoId && todos.some((todo) => todo.id === currentTodoId)) {
    return currentTodoId
  }
  return todos.find((todo) => todo.active)?.id ?? todos[0]?.id ?? null
}

function updateRunQuery(runId: string | null) {
  const url = new URL(window.location.href)
  if (runId) {
    url.searchParams.set('runId', runId)
  } else {
    url.searchParams.delete('runId')
  }
  window.history.replaceState(null, '', url)
}

function readInitialRunId(): string | null {
  const runId = new URLSearchParams(window.location.search).get('runId')
  return runId && runId.trim() !== '' ? runId : null
}

export const useVisualizerStore = create<VisualizerStore>((set, get) => ({
  snapshot: null,
  selectedRunId: readInitialRunId(),
  selectedTodoId: null,
  selectedEventId: null,
  showThinking: true,
  collapseDeltas: true,
  status: 'idle',
  error: null,
  eventSource: null,

  async bootstrap() {
    const runId = get().selectedRunId
    set({ status: 'loading', error: null })
    try {
      const snapshot = await fetchSnapshot(runId)
      get().applySnapshot(snapshot)
      get().disconnect()
      const eventSource = openSnapshotStream(runId, {
        onSnapshot(next) {
          get().applySnapshot(next)
        },
        onError() {
          set({ error: 'Stream reconnecting…' })
        },
      })
      set({ eventSource, status: 'ready', error: null })
    } catch (error) {
      set({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  },

  async setSelectedRunId(runId) {
    updateRunQuery(runId)
    set({ selectedRunId: runId, selectedEventId: null })
    await get().bootstrap()
  },

  setSelectedTodoId(todoId) {
    set({ selectedTodoId: todoId })
  },

  setSelectedEventId(eventId) {
    set({ selectedEventId: eventId })
  },

  setShowThinking(value) {
    set({ showThinking: value })
  },

  setCollapseDeltas(value) {
    set({ collapseDeltas: value })
  },

  applySnapshot(snapshot) {
    const currentTodoId = get().selectedTodoId
    set({
      snapshot,
      selectedRunId: snapshot.config.selectedRunId || null,
      selectedTodoId: selectTodo(snapshot, currentTodoId),
      status: 'ready',
      error: null,
    })
  },

  disconnect() {
    const eventSource = get().eventSource
    eventSource?.close()
    set({ eventSource: null })
  },
}))

export function getSelectedTodo(snapshot: VisualizerSnapshot | null, selectedTodoId: string | null): TodoItem | null {
  if (!snapshot) {
    return null
  }

  const todos = Array.isArray(snapshot.todos) ? snapshot.todos : []
  if (selectedTodoId) {
    const selected = todos.find((todo) => todo.id === selectedTodoId)
    if (selected) {
      return selected
    }
  }

  return todos.find((todo) => todo.active) ?? todos[0] ?? null
}
