// Test harness: renders the real RedlineInspector, active, with props from the test.
// onDeactivate turns it off, as a host's toggle would, and records that it was called.
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RedlineInspector } from '../../component/redline-inspector'

const props = (window as any).__REDLINE_PROPS__ ?? {}

// Existing specs never see the introduction unless they ask for it with showIntro
if (!props.showIntro) {
  try {
    localStorage.setItem('redline:intro:v1', '1')
  } catch {
    // Storage can be blocked; the introduction then decides for itself
  }
}

function Harness() {
  const [active, setActive] = useState(true)
  // The host's own toggle, for tests that turn Redline off or on from outside
  useEffect(() => {
    (window as any).__redlineSetActive = setActive
  }, [])
  return (
    <RedlineInspector
      active={active}
      onDeactivate={() => {
        (window as any).__redlineClosed = true
        setActive(false)
      }}
      {...props}
    />
  )
}

createRoot(document.getElementById('redline-root')!).render(<Harness />)
