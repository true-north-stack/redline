// Test harness: renders the real RedlineInspector, active, with props from the test
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

createRoot(document.getElementById('redline-root')!).render(
  <RedlineInspector active onDeactivate={() => { (window as any).__redlineClosed = true }} {...props} />,
)
