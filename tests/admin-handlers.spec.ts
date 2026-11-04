// Admin API handlers: access control, caching, filters, status updates. Node only.
import { test, expect } from '@playwright/test'
import type { RedlineConfig } from '../component/redline-config'
import type { InboxQuery, RedlineItem, RedlineStore } from '../component/redline-storage'
import { createAdminHandlers } from '../component/redline-admin-handlers'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const T1 = '33333333-3333-4333-8333-333333333333'
const ADMIN = { id: '44444444-4444-4444-8444-444444444444' }

const item = (id: string, over: Partial<RedlineItem> = {}): RedlineItem => ({
  id, page_url: '/x', element_selector: '#a', element_text: null, feedback: 'f',
  screenshot_path: null, status: 'open', created_at: '2026-01-01T00:00:00.000Z',
  ux_review_requested: false, tester_id: null, app_version: null, user_agent: null,
  expires_at: '2026-04-01T00:00:00.000Z', status_updated_at: 'stamp-0', status_updated_by: null, ...over,
})

function memoryStore(initial: RedlineItem[], kind: 'local' | 'supabase' = 'supabase') {
  const items = [...initial]
  const calls: string[] = []
  let n = 0
  const store: RedlineStore & { items: RedlineItem[]; calls: string[]; queries: InboxQuery[]; ttls: (number | undefined)[] } = {
    kind, items, calls, queries: [], ttls: [],
    saveAttachment: async (id) => id, saveItem: async () => {}, list: async () => items, purge: async () => ({ items: 0, attachments: 0 }),
    async query(q) {
      calls.push('query'); this.queries.push(q)
      if (q.cursor === 'bad') throw new Error('[redline] invalid cursor')
      return { items: items.filter((i) => !q.status || i.status === q.status), nextCursor: 'next' }
    },
    async summary() {
      calls.push('summary')
      return { counts: { open: 2, fixed: 0, dismissed: 0, deferred: 0 }, testers: [T1], versions: ['1.0'] }
    },
    async get(id) { calls.push('get'); return items.find((i) => i.id === id) ?? null },
    async setStatus(id, status, by, expected) {
      calls.push('setStatus')
      const cur = items.find((i) => i.id === id)
      if (!cur) return { missing: true }
      if (cur.status_updated_at !== expected) return { conflict: cur }
      Object.assign(cur, { status, status_updated_by: by, status_updated_at: `stamp-${++n}` })
      return { item: cur }
    },
    async screenshotUrl(path, ttl) { calls.push('shot'); this.ttls.push(ttl); return `https://signed/${path}` },
  }
  return store
}

function setup(opts: { admin?: boolean; storage?: 'local' | 'supabase'; kind?: 'local' | 'supabase'; items?: RedlineItem[]; describe?: boolean } = {}) {
  const store = memoryStore(opts.items ?? [item(A), item(B)], opts.kind ?? 'supabase')
  const config: RedlineConfig = { storage: opts.storage ?? 'supabase' }
  const describeCalls: string[][] = []
  const h = createAdminHandlers({
    config, store,
    isAdmin: async () => (opts.admin === false ? null : ADMIN),
    describeTesters: opts.describe ? async (ids) => { describeCalls.push(ids); return { [T1]: 'Dana' } } : undefined,
  })
  return { h, store, describeCalls }
}

const NS = 'no-store'
const patchReq = (body: unknown, type: string | null = 'application/json') =>
  new Request('http://x/api/admin/redlines/' + A, {
    method: 'PATCH', headers: type ? { 'content-type': type } : {}, body: typeof body === 'string' ? body : JSON.stringify(body),
  })
const getReq = (qs = '') => new Request('http://x/api/admin/redlines' + qs)

test('non-admin gets 404 on list, get and patch, and the store is never called', async () => {
  const { h, store } = setup({ admin: false })
  for (const res of [await h.list(getReq()), await h.get(getReq(), A), await h.patch(patchReq({ status: 'fixed', expected_status_updated_at: 'stamp-0' }), A)]) {
    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toBe(NS)
  }
  expect(store.calls).toEqual([])
})

test('local mode gets 404 even for an admin', async () => {
  for (const o of [{ storage: 'local' as const }, { kind: 'local' as const }]) {
    const { h, store } = setup(o)
    expect((await h.list(getReq())).status).toBe(404)
    expect((await h.get(getReq(), A)).status).toBe(404)
    expect((await h.patch(patchReq({ status: 'fixed', expected_status_updated_at: 'stamp-0' }), A)).status).toBe(404)
    expect(store.calls).toEqual([])
  }
})

test('every response sends Cache-Control: no-store', async () => {
  const { h } = setup()
  const good = { status: 'fixed', expected_status_updated_at: 'stamp-0' }
  const rs = [
    await h.list(getReq()), // 200
    await h.list(getReq('?status=bogus')), // 400
    await h.get(getReq(), '55555555-5555-4555-8555-555555555555'), // 404
    await h.patch(patchReq(good), A), // 200
    await h.patch(patchReq(good), A), // 409
    await h.patch(patchReq(good, 'text/plain'), A), // 415
  ]
  expect(rs.map((r) => r.status)).toEqual([200, 400, 404, 200, 409, 415])
  for (const r of rs) expect(r.headers.get('cache-control')).toBe(NS)
})

test('list passes filters through and merges the summary', async () => {
  const { h, store } = setup()
  const res = await h.list(getReq(`?status=open&tester=${T1}&version=1.0&cursor=abc&limit=10`))
  expect(res.status).toBe(200)
  expect(store.queries[0]).toEqual({ status: 'open', testerId: T1, appVersion: '1.0', cursor: 'abc', limit: 10 })
  const body = await res.json()
  expect(body.items).toHaveLength(2)
  expect(body.nextCursor).toBe('next')
  expect(body.counts.open).toBe(2)
  expect(body.versions).toEqual(['1.0'])
})

test('list rejects an unknown status, bad tester, bad limit and malformed cursor with 400', async () => {
  const { h } = setup()
  expect((await h.list(getReq('?status=bogus'))).status).toBe(400)
  expect((await h.list(getReq('?tester=' + 'x'.repeat(201)))).status).toBe(400)
  expect((await h.list(getReq('?limit=abc'))).status).toBe(400)
  expect((await h.list(getReq('?cursor=bad'))).status).toBe(400)
})

test('list passes a free-text tester id through', async () => {
  const { h, store } = setup()
  expect((await h.list(getReq('?tester=tester-1'))).status).toBe(200)
  expect(store.queries[0].testerId).toBe('tester-1')
})

test('a throwing isAdmin is a no-store 404 with no store calls', async () => {
  const store = memoryStore([item(A)])
  const h = createAdminHandlers({ config: { storage: 'supabase' }, store, isAdmin: async () => { throw new Error('auth down') } })
  const body = { status: 'fixed', expected_status_updated_at: 'stamp-0' }
  for (const res of [await h.list(getReq()), await h.get(getReq(), A), await h.patch(patchReq(body), A)]) {
    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toBe(NS)
  }
  expect(store.calls).toEqual([])
})

test('list labels testers via describeTesters, falling back to the raw id', async () => {
  const withIt = setup({ describe: true, items: [item(A, { tester_id: T1 }), item(B, { tester_id: T1 }), item('66666666-6666-4666-8666-666666666666')] })
  const body = await (await withIt.h.list(getReq())).json()
  expect(withIt.describeCalls).toEqual([[T1]])
  expect(body.items[0].tester_label).toBe('Dana')
  expect(body.items[2].tester_label).toBeNull()
  expect(body.testers).toEqual([{ id: T1, label: 'Dana' }])

  const without = setup({ items: [item(A, { tester_id: T1 })] })
  const b2 = await (await without.h.list(getReq())).json()
  expect(b2.items[0].tester_label).toBe(T1)
  expect(b2.testers).toEqual([{ id: T1, label: T1 }])
})

test('get includes a 300s screenshot_url, null without a screenshot, 404 for an unknown id', async () => {
  const { h, store } = setup({ items: [item(A, { screenshot_path: 'a.png' }), item(B)] })
  const withShot = await (await h.get(getReq(), A)).json()
  expect(withShot.screenshot_url).toBe('https://signed/a.png')
  expect(store.ttls).toEqual([300])
  const none = await (await h.get(getReq(), B)).json()
  expect(none.screenshot_url).toBeNull()
  expect((await h.get(getReq(), '55555555-5555-4555-8555-555555555555')).status).toBe(404)
})

test('patch: 415 without a JSON content type; 400 for bad input', async () => {
  const { h, store } = setup()
  const ok = { status: 'fixed', expected_status_updated_at: 'stamp-0' }
  expect((await h.patch(patchReq(ok, null), A)).status).toBe(415)
  expect((await h.patch(patchReq(ok, 'text/plain'), A)).status).toBe(415)
  expect((await h.patch(patchReq({ ...ok, status: 'nope' }), A)).status).toBe(400)
  expect((await h.patch(patchReq(ok), 'not-a-uuid')).status).toBe(400)
  expect((await h.patch(patchReq({ status: 'fixed' }), A)).status).toBe(400)
  expect((await h.patch(patchReq('{bad json'), A)).status).toBe(400)
  expect(store.calls).toEqual([])
})

test("patch: 200 sets status_updated_by to the admin's id; 409 returns { current }", async () => {
  const { h } = setup()
  const res = await h.patch(patchReq({ status: 'fixed', expected_status_updated_at: 'stamp-0' }), A)
  expect(res.status).toBe(200)
  const saved = await res.json()
  expect(saved.status).toBe('fixed')
  expect(saved.status_updated_by).toBe(ADMIN.id)
  expect(saved.status_updated_at).not.toBe('stamp-0')

  const stale = await h.patch(patchReq({ status: 'dismissed', expected_status_updated_at: 'stamp-0' }), A)
  expect(stale.status).toBe(409)
  const body = await stale.json()
  expect(body.current.status).toBe('fixed')
  expect(body.current.status_updated_at).toBe(saved.status_updated_at)
})

test('patch unknown id is 404', async () => {
  const { h } = setup()
  const res = await h.patch(patchReq({ status: 'fixed', expected_status_updated_at: 'stamp-0' }), '55555555-5555-4555-8555-555555555555')
  expect(res.status).toBe(404)
  expect(res.headers.get('cache-control')).toBe(NS)
})
