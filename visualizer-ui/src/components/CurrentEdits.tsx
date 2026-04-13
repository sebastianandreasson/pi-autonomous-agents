import type { CurrentEdit } from '../types'

type CurrentEditsProps = {
  edits: CurrentEdit[]
}

export function CurrentEdits({ edits }: CurrentEditsProps) {
  if (edits.length === 0) {
    return <div className="muted">No repo edits yet.</div>
  }

  return (
    <div className="edit-list">
      {edits.map((entry) => (
        <details key={entry.file} className="edit-item" open>
          <summary className="edit-head">{entry.file}</summary>
          <pre>{entry.diff || 'No diff available.'}</pre>
        </details>
      ))}
    </div>
  )
}
