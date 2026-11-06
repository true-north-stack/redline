// Test harness: calls the shortcut hook and records each activation on window
import { createRoot } from 'react-dom/client'
import { useRedlineShortcuts } from '../../component/redline-shortcuts'

const w = window as any
w.__activations = []
const options = w.__SHORTCUT_OPTIONS__ ?? {}

function Harness() {
  useRedlineShortcuts((mode) => { w.__activations.push(mode) }, options)
  return (
    <div>
      <input data-testid="field" />
      <div data-testid="editable" contentEditable suppressContentEditableWarning />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Harness />)
