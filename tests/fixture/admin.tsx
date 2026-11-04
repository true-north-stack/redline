// Test harness for the admin inbox UI. Props come from window.__ADMIN_PROPS__ and every
// callback is recorded on window.__events so specs can assert on them.
// Task 8 extends this with the inbox shell for view === 'inbox'.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RedlineAdminDetail } from '../../component/redline-admin-detail'

const w = window as any
const props = w.__ADMIN_PROPS__ as { view: 'detail' | 'inbox'; apiUrl: string; id?: string }
w.__events = []
const log = (type: string, payload: unknown) => w.__events.push({ type, payload })

function Host() {
  const [id, setId] = useState(props.id!)
  w.__setId = setId // lets specs switch the selected item
  return (
    <div className="h-screen bg-background text-foreground">
      <RedlineAdminDetail
        apiUrl={props.apiUrl}
        id={id}
        onBack={() => log('back', null)}
        onStatusChanged={(item, previous) => log('statusChanged', { item, previous })}
        onGone={(gone) => log('gone', gone)}
      />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Host />)
