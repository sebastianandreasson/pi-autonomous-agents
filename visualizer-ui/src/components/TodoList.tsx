import { useEffect, useRef } from 'react'
import type { TodoItem } from '../types'

type TodoListProps = {
  todos: TodoItem[]
  selectedTodoId: string | null
  onSelect: (todoId: string) => void
}

function groupTodosByPhase(todos: TodoItem[]) {
  const groups = [] as Array<{ phase: string; items: TodoItem[] }>
  for (const todo of todos) {
    const phase = todo.phase || 'Unscoped'
    const current = groups.at(-1)
    if (current && current.phase === phase) {
      current.items.push(todo)
      continue
    }
    groups.push({ phase, items: [todo] })
  }
  return groups
}

export function TodoList({ todos, selectedTodoId, onSelect }: TodoListProps) {
  const listRef = useRef<HTMLDivElement | null>(null)
  const activeTodoRef = useRef<HTMLButtonElement | null>(null)
  const hasAutoScrolledRef = useRef(false)

  useEffect(() => {
    if (hasAutoScrolledRef.current) {
      return
    }
    const listNode = listRef.current
    const activeNode = activeTodoRef.current
    if (!listNode || !activeNode) {
      return
    }

    const top = activeNode.offsetTop - Math.max(24, Math.floor(listNode.clientHeight * 0.35))
    listNode.scrollTop = Math.max(0, top)
    hasAutoScrolledRef.current = true
  }, [todos])

  if (todos.length === 0) {
    return <div className="muted">No TODO items found.</div>
  }

  const groups = groupTodosByPhase(todos)

  return (
    <div ref={listRef} className="todo-list">
      {groups.map((group) => (
        <section key={group.phase} className="todo-group">
          <div className="todo-group-heading">{group.phase}</div>
          <div className="todo-group-items">
            {group.items.map((todo) => {
              const selected = todo.id === selectedTodoId
              const active = todo.active === true
              return (
                <button
                  key={todo.id}
                  ref={(node) => {
                    if (active) {
                      activeTodoRef.current = node
                    }
                  }}
                  type="button"
                  className={`todo-item ${selected ? 'selected' : ''} ${active ? 'active' : ''}`.trim()}
                  onClick={() => onSelect(todo.id)}
                >
                  <div className="todo-line">{todo.lineNumber}</div>
                  <div className="todo-content">
                    <div className={`todo-task ${todo.checked ? 'todo-checked' : ''}`}>
                      {todo.checked ? '✓' : '○'} {todo.text}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
