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
  if (todos.length === 0) {
    return <div className="muted">No TODO items found.</div>
  }

  const groups = groupTodosByPhase(todos)

  return (
    <div className="todo-list">
      {groups.map((group) => (
        <section key={group.phase} className="todo-group">
          <div className="todo-group-heading">{group.phase}</div>
          <div className="todo-group-items">
            {group.items.map((todo) => {
              const active = todo.id === selectedTodoId
              return (
                <button
                  key={todo.id}
                  type="button"
                  className={`todo-item ${active ? 'active' : ''}`}
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
