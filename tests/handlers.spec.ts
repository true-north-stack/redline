// Feedback handler factory: route behavior and the owner notification hook. Node only.

import { test, expect } from '@playwright/test'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { localStore, type RedlineItem, type RedlineStore } from '../component/redline-storage'
import type { RedlineConfig } from '../component/redline-config'
import { createFeedbackHandlers, toNotificationSummary } from '../component/redline-handlers'

const SECRET = 'Patient Jane Doe in room 4 cannot save'

function memoryStore(): RedlineStore & { items: RedlineItem[] } {
  const items: RedlineItem[] = []
  const nope = () => { throw new Error('not used in this test') }
  return {
    kind: 'supabase',
    items,
    saveAttachment: async (id) => `${id}.png`,
    saveItem: async (i) => { items.push(i) },
    list: async () => items,
    purge: nope, query: nope, summary: nope, get: nope, setStatus: nope, screenshotUrl: nope,
  }
}

async function localHandlers(extra: Partial<Parameters<typeof createFeedbackHandlers>[0]> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'redline-handlers-'))
  const config: RedlineConfig = { storage: 'local', appVersion: '1.2.3' }
  return createFeedbackHandlers({ config, store: localStore(root), getTesterId: async () => null, ...extra })
}

const post = (body: unknown) =>
  new Request('http://x/api/redlines', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const payload = { page_url: '/bookings?q=secret', element_selector: '#save', feedback: SECRET }

test('local mode: POST saves and returns 201 with status open (To Fix); GET lists items', async () => {
  const h = await localHandlers()
  const res = await h.POST(post(payload))
  expect(res.status).toBe(201)
  const saved = await res.json()
  expect(saved.feedback).toBe(SECRET)
  expect(saved.page_url).toBe('/bookings?q=…')
  expect(saved.status).toBe('open')
  expect(saved.app_version).toBe('1.2.3')

  const list = await (await h.GET()).json()
  expect(list.count).toBe(1)
  expect(list.data[0].id).toBe(saved.id)
})

test('missing feedback is 400', async () => {
  const h = await localHandlers()
  const res = await h.POST(post({ page_url: '/x', feedback: '   ' }))
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: 'feedback is required' })
})

test('supabase mode: POST without a tester is 401, GET is 404', async () => {
  const store = memoryStore()
  const h = createFeedbackHandlers({ config: { storage: 'supabase' }, store, getTesterId: async () => null })
  expect((await h.POST(post(payload))).status).toBe(401)
  expect((await h.GET()).status).toBe(404)
  expect(store.items).toHaveLength(0)

  const ok = createFeedbackHandlers({ config: { storage: 'supabase' }, store, getTesterId: async () => 'user-1' })
  const res = await ok.POST(post(payload))
  expect(res.status).toBe(201)
  expect((await res.json()).tester_id).toBe('user-1')
  // Tester feedback waits in To Review until the owner triages it
  expect(store.items).toHaveLength(1)
  expect(store.items[0].status).toBe('review')
})

test('onRedlineCreated gets only the summary, deferred', async () => {
  const calls: unknown[] = []
  let task: (() => Promise<void>) | undefined
  const h = await localHandlers({
    getTesterId: async () => 'user-1',
    onRedlineCreated: (s) => { calls.push(s) },
    defer: (t) => { task = t },
  })
  const res = await h.POST(post(payload))
  expect(res.status).toBe(201)
  expect(calls).toHaveLength(0)
  expect(task).toBeDefined()

  await task!()
  expect(calls).toHaveLength(1)
  const summary = calls[0] as Record<string, unknown>
  expect(Object.keys(summary).sort()).toEqual([
    'app_version', 'created_at', 'has_screenshot', 'id', 'page_url', 'tester_id', 'ux_review_requested',
  ])
  expect(JSON.stringify(summary)).not.toContain(SECRET)
  expect(summary.tester_id).toBe('user-1')
  expect(summary.has_screenshot).toBe(false)
})

test('toNotificationSummary drops content fields and flags screenshots', () => {
  const s = toNotificationSummary({
    id: 'a', page_url: '/p', element_selector: '#e', element_text: 'secret text', feedback: SECRET,
    screenshot_path: 'a.png', status: 'open', created_at: 't', ux_review_requested: true,
    tester_id: null, app_version: 'v', user_agent: 'ua', expires_at: 'e',
  })
  expect(s.has_screenshot).toBe(true)
  expect(s.ux_review_requested).toBe(true)
  expect(JSON.stringify(s)).not.toContain('secret')
})

test('a throwing onRedlineCreated still returns 201 and logs', async () => {
  const errors: unknown[][] = []
  const orig = console.error
  console.error = (...a: unknown[]) => { errors.push(a) }
  try {
    let task: (() => Promise<void>) | undefined
    const h = await localHandlers({
      onRedlineCreated: () => { throw new Error('smtp down') },
      defer: (t) => { task = t },
    })
    const res = await h.POST(post(payload))
    expect(res.status).toBe(201)
    await task!()
    expect(errors.some((a) => String(a[0]).includes('[redline] onRedlineCreated failed'))).toBe(true)
  } finally {
    console.error = orig
  }
})

test('no defer given: the hook runs without blocking the response', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  let finished = false
  const h = await localHandlers({
    onRedlineCreated: async () => { await gate; finished = true },
  })
  const res = await h.POST(post(payload))
  expect(res.status).toBe(201)
  expect(finished).toBe(false)
  release()
  await expect.poll(() => finished).toBe(true)
})

test('a defer that throws synchronously still yields 201 and the item is saved', async () => {
  const errors: unknown[][] = []
  const orig = console.error
  console.error = (...a: unknown[]) => { errors.push(a) }
  try {
    const store = memoryStore()
    const h = createFeedbackHandlers({
      config: { storage: 'supabase' },
      store,
      getTesterId: async () => 'user-1',
      onRedlineCreated: () => {},
      defer: () => { throw new Error('outside request scope') },
    })
    const res = await h.POST(post(payload))
    expect(res.status).toBe(201)
    expect(store.items).toHaveLength(1)
    expect(errors.some((a) => String(a[0]).includes('[redline] defer failed'))).toBe(true)
  } finally {
    console.error = orig
  }
})
