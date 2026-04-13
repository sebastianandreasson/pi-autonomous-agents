import type { TodoItem } from '../types'

type TodoListProps = {
  todos: TodoItem[]
  selectedTodoId: string | null
  onSelect: (todoId: string) => void
}

export function TodoList({ todos, selectedTodoId, onSelect }: TodoListProps) {
  if (todos.length === 0) {
    return <div className="muted">No TODO items found.</div>
  }

  return (
    <div className="todo-list">
      {todos.map((todo) => {
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
              <div className="todo-phase">{todo.phase || 'Unscoped'}</div>
            </div>
          </button>
        )
      })}
    </div>
  )
}
