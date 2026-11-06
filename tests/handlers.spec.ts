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

test('limits: a note over 5000 characters is 413 naming the field, and nothing is saved', async () => {
  const store = memoryStore()
  const h = createFeedbackHandlers({ config: { storage: 'supabase' }, store, getTesterId: async () => 't1' })
  const res = await h.POST(post({ ...payload, feedback: 'x'.repeat(5001) }))
  expect(res.status).toBe(413)
  expect(await res.json()).toEqual({ error: 'too_large', field: 'feedback' })
  expect(store.items.length).toBe(0)
})

test('limits: fields Redline collects (page URL, selector, element text) are cut to size, not refused', async () => {
  const store = memoryStore()
  const h = createFeedbackHandlers({ config: { storage: 'supabase' }, store, getTesterId: async () => 't1' })
  const res = await h.POST(post({
    ...payload,
    page_url: '/' + 'x'.repeat(3000),
    element_selector: 's'.repeat(1500),
    element_text: 't'.repeat(2500),
  }))
  expect(res.status).toBe(201)
  const [saved] = store.items
  expect(saved.page_url.length).toBe(2000)
  expect(saved.element_selector).toBe('s'.repeat(1000))
  expect(saved.element_text).toBe('t'.repeat(2000))
})

test('limits: a page URL that grows when sanitized is still cut to 2000', async () => {
  const store = memoryStore()
  const h = createFeedbackHandlers({ config: { storage: 'supabase' }, store, getTesterId: async () => 't1' })
  // Bare keys gain "=…" when sanitized, so a URL under the cap comes out over it
  const res = await h.POST(post({ ...payload, page_url: '/p?' + Array(700).fill('a').join('&') }))
  expect(res.status).toBe(201)
  expect(store.items[0].page_url.length).toBeLessThanOrEqual(2000)
})

test('limits: a text field that is not a string is 400, so it cannot slip past the caps', async () => {
  for (const [field, value] of [
    ['element_text', { x: 'y'.repeat(100_000) }],
    ['feedback', ['a']],
    ['page_url', 42],
  ] as const) {
    const store = memoryStore()
    const h = createFeedbackHandlers({ config: { storage: 'supabase' }, store, getTesterId: async () => 't1' })
    const res = await h.POST(post({ ...payload, [field]: value }))
    expect(res.status, field).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid field', field })
    expect(store.items.length).toBe(0)
  }
})

test('limits: a file sent as a text field in multipart is 400', async () => {
  const store = memoryStore()
  const h = createFeedbackHandlers({ config: { storage: 'supabase' }, store, getTesterId: async () => 't1' })
  const form = new FormData()
  form.set('page_url', '/x')
  form.set('feedback', 'hello')
  form.set('element_text', new File(['z'.repeat(10_000)], 'a.txt'))
  const res = await h.POST(new Request('http://x/api/redlines', { method: 'POST', body: form }))
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: 'invalid field', field: 'element_text' })
})

test('limits: a body with no content-length is counted as it streams and refused past 10 MB', async () => {
  const store = memoryStore()
  const h = createFeedbackHandlers({ config: { storage: 'supabase' }, store, getTesterId: async () => 't1' })
  const chunk = new Uint8Array(1024 * 1024).fill(32)
  let sent = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent++ < 20) c.enqueue(chunk)
      else c.close()
    },
  })
  const req = new Request('http://x/api/redlines', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: stream,
    // @ts-expect-error Node needs duplex for a streamed request body
    duplex: 'half',
  })
  expect(req.headers.get('content-length')).toBeNull()
  const res = await h.POST(req)
  expect(res.status).toBe(413)
  expect(await res.json()).toEqual({ error: 'too_large', field: 'request' })
  expect(sent).toBeLessThan(20)
})

test('a body that is not valid JSON is 400', async () => {
  const h = await localHandlers()
  const res = await h.POST(new Request('http://x/api/redlines', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' }))
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: 'invalid body' })
})

test('limits: values exactly at the caps are saved', async () => {
  const store = memoryStore()
  const h = createFeedbackHandlers({ config: { storage: 'supabase' }, store, getTesterId: async () => 't1' })
  const res = await h.POST(post({
    page_url: '/' + 'x'.repeat(1999),
    element_selector: 'x'.repeat(1000),
    element_text: 'x'.repeat(2000),
    feedback: 'x'.repeat(5000),
  }))
  expect(res.status).toBe(201)
  expect(store.items.length).toBe(1)
})

test('limits: a screenshot over 8 MB is 413 and nothing is stored', async () => {
  const store = memoryStore()
  let uploads = 0
  store.saveAttachment = async (id) => { uploads++; return `${id}.png` }
  const h = createFeedbackHandlers({ config: { storage: 'supabase' }, store, getTesterId: async () => 't1' })
  const form = new FormData()
  form.set('page_url', '/x')
  form.set('element_selector', '#a')
  form.set('feedback', 'too big')
  form.set('screenshot', new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'shot.png', { type: 'image/png' }))
  const res = await h.POST(new Request('http://x/api/redlines', { method: 'POST', body: form }))
  expect(res.status).toBe(413)
  expect(await res.json()).toEqual({ error: 'too_large', field: 'screenshot' })
  expect(uploads).toBe(0)
  expect(store.items.length).toBe(0)
})

test('limits: a request declaring more than 10 MB is 413 before the body is read', async () => {
  const store = memoryStore()
  const h = createFeedbackHandlers({ config: { storage: 'supabase' }, store, getTesterId: async () => 't1' })
  const req = new Request('http://x/api/redlines', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(10 * 1024 * 1024 + 1) },
    body: JSON.stringify(payload),
  })
  const res = await h.POST(req)
  expect(res.status).toBe(413)
  expect(await res.json()).toEqual({ error: 'too_large', field: 'request' })
})

test('limits: a long user agent is cut to 512 characters, not rejected', async () => {
  const store = memoryStore()
  const h = createFeedbackHandlers({ config: { storage: 'supabase' }, store, getTesterId: async () => 't1' })
  const req = new Request('http://x/api/redlines', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'U'.repeat(900) },
    body: JSON.stringify(payload),
  })
  expect((await h.POST(req)).status).toBe(201)
  expect(store.items[0].user_agent).toBe('U'.repeat(512))
})

test('limits: cutting collected text never leaves half an emoji', async () => {
  const store = memoryStore()
  const h = createFeedbackHandlers({ config: { storage: 'supabase' }, store, getTesterId: async () => 't1' })
  // 1999 ASCII units then an emoji (two units) straddling the 2000 cap
  const res = await h.POST(post({ ...payload, element_text: 'a'.repeat(1999) + '😀😀' }))
  expect(res.status).toBe(201)
  const text = store.items[0].element_text!
  expect(text).toBe('a'.repeat(1999))
  expect(() => encodeURIComponent(text)).not.toThrow()
})
