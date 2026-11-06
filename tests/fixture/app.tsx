// Test harness: renders the real RedlineInspector, active, with props from the test.
// onDeactivate turns it off, as a host's toggle would, and records that it was called.
// withShortcuts wires the shipped shortcut hook the way the README shows.
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RedlineInspector } from '../../component/redline-inspector'
import { useRedlineShortcuts, type RedlineShortcutMode } from '../../component/redline-shortcuts'

const props = (window as any).__REDLINE_PROPS__ ?? {}
const { withShortcuts, initialMode: startMode, ...inspectorProps } = props

// Existing specs never see the introduction unless they ask for it with showIntro
if (!props.showIntro) {
  try {
    localStorage.setItem('redline:intro:v1', '1')
  } catch {
    // Storage can be blocked; the introduction then decides for itself
  }
}

function Harness() {
  // startActive false loads the page with Redline off, as a host does before its toggle
  const [active, setActive] = useState(props.startActive ?? true)
  const [mode, setMode] = useState<RedlineShortcutMode>(startMode ?? 'element')
  // The host's own toggle and mode, for tests that change them from outside
  useEffect(() => {
    (window as any).__redlineSetActive = setActive
    ;(window as any).__redlineSetMode = setMode
  }, [])
  useRedlineShortcuts((m) => { setMode(m); setActive(true) }, { enabled: !!withShortcuts })
  return (
    <RedlineInspector
      active={active}
      initialMode={mode}
      onDeactivate={() => {
        (window as any).__redlineClosed = true
        setActive(false)
      }}
      {...inspectorProps}
    />
  )
}

createRoot(document.getElementById('redline-root')!).render(<Harness />)
