// Test harness: renders the real RedlineInspector, active, with props from the test
import { createRoot } from 'react-dom/client'
import { RedlineInspector } from '../../component/redline-inspector'

const props = (window as any).__REDLINE_PROPS__ ?? {}

createRoot(document.getElementById('redline-root')!).render(
  <RedlineInspector active onDeactivate={() => { (window as any).__redlineClosed = true }} {...props} />,
)
