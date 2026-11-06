// Test harness: renders the introduction with props from the page and counts each close on window
import { createRoot } from 'react-dom/client'
import { RedlineIntro, introDismissed } from '../../component/redline-intro'

const w = window as any
w.__introDismissed = introDismissed

createRoot(document.getElementById('root')!).render(
  <RedlineIntro {...w.__INTRO_PROPS__} onClose={() => (w.__introClosed = (w.__introClosed ?? 0) + 1)} />,
)
