// Shared harness for admin inbox UI specs: bundles the fixture (esbuild + compiled
// Tailwind v4), serves it on a fake origin, and fakes the Task 4 admin API statefully.
import type { Page } from '@playwright/test'
import { build } from 'esbuild'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { fileURLToPath } from 'url'
import type { AdminItem, AdminDetail } from '../component/redline-admin-types'

const run = promisify(execFile)
export const ORIGIN = 'http://redline.test'
export const API = `${ORIGIN}/api/redline-admin`
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
)

let bundle = ''
let css = ''

/** Call from test.beforeAll. */
export async function buildFixture() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./fixture/admin.tsx', import.meta.url))],
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  })
  bundle = result.outputFiles[0].text
  const bin = fileURLToPath(new URL('../node_modules/.bin/tailwindcss', import.meta.url))
  const input = fileURLToPath(new URL('./fixture/admin.css', import.meta.url))
  const { stdout } = await run(bin, ['-i', input], { maxBuffer: 16 * 1024 * 1024 })
  css = stdout
}

export interface AdminCall { method: string; url: string; body: any }
export interface OpenAdminOpts {
  view: 'detail' | 'inbox'
  id?: string
  items: AdminItem[]
  /** The next list request fails with a 500 (later ones succeed), so Retry can recover. */
  failList?: boolean
  /** Delay on every API response. */
  delayMs?: number
  /**
   * Query string for the page URL, e.g. '?status=fixed'. The inbox view defaults to '?status=open'
   * (To Fix) because most specs exercise that tab; pass '' to get the real default (To Review).
   * With the default, `id` is added as &id=.
   */
  search?: string
  /** Extra delay on PATCH responses only. */
  patchDelayMs?: number
  /** Per-PATCH delays in call order (0 or missing = none), applied on top of patchDelayMs. */
  patchDelays?: number[]
  /** Extra delay on list requests that carry a cursor (Load more); the page is snapshotted before the wait. */
  cursorDelayMs?: number
  /** Screenshot requests fail (simulates an expired signed URL). */
  failImages?: boolean
  /** Next PATCH 409s after applying these fields as the "elsewhere" change. */
  conflictWith?: Partial<AdminItem>
  /** Next PATCH 404s and the item disappears. */
  purgeOnPatch?: boolean
}

const wait = (ms?: number) => (ms ? new Promise((r) => setTimeout(r, ms)) : undefined)

export async function openAdmin(page: Page, opts: OpenAdminOpts) {
  const calls: AdminCall[] = []
  const store = new Map(opts.items.map((i) => [i.id, { ...i }]))
  let conflictWith = opts.conflictWith
  let purgeOnPatch = opts.purgeOnPatch
  let failList = opts.failList
  let signed = 0
  let patchN = 0
  const json = (status: number, body: unknown) => ({
    status, contentType: 'application/json', body: JSON.stringify(body),
  })

  await page.route(`${ORIGIN}/**`, async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const path = url.pathname
    if (path === '/admin') {
      const props = { view: opts.view, id: opts.id, apiUrl: API }
      return route.fulfill({
        status: 200, contentType: 'text/html',
        body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head>
<body><div id="root"></div><script>window.__ADMIN_PROPS__=${JSON.stringify(props)}</script><script>${bundle}</script></body></html>`,
      })
    }
    if (path.startsWith('/shot/')) {
      calls.push({ method: 'GET', url: req.url(), body: null })
      if (opts.failImages) return route.fulfill({ status: 403, body: 'expired' })
      return route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
    }
    if (path.startsWith('/api/redline-admin')) {
      const id = path.slice('/api/redline-admin'.length).replace(/^\//, '')
      let body: any = null
      if (req.postData()) { try { body = JSON.parse(req.postData()!) } catch { body = req.postData() } }
      calls.push({ method: req.method(), url: req.url(), body })
      await wait(opts.delayMs)
      if (!id) {
        if (failList) { failList = false; return route.fulfill(json(500, { error: 'boom' })) }
        // Newest first, ties by id, like the real store
        const all = [...store.values()].sort((a, b) =>
          a.created_at === b.created_at ? (a.id < b.id ? 1 : -1) : a.created_at < b.created_at ? 1 : -1)
        // Counts, testers and versions ignore the filters, like the real API
        const counts = { review: 0, open: 0, fixed: 0, dismissed: 0, deferred: 0 }
        for (const i of all) counts[i.status]++
        const testers = new Map<string, string>()
        for (const i of all) if (i.tester_id) testers.set(i.tester_id, i.tester_label ?? i.tester_id)
        const versions = [...new Set(all.map((i) => i.app_version).filter((v): v is string => !!v))].sort()
        const q = url.searchParams
        const matching = all.filter((i) =>
          (!q.get('status') || i.status === q.get('status')) &&
          (!q.get('tester') || i.tester_id === q.get('tester')) &&
          (!q.get('version') || i.app_version === q.get('version')))
        const start = Number(q.get('cursor') || 0)
        const limit = Number(q.get('limit') || 50)
        const items = matching.slice(start, start + limit)
        const nextCursor = start + limit < matching.length ? String(start + limit) : null
        const payload = {
          items, nextCursor, counts,
          testers: [...testers].map(([id, label]) => ({ id, label })),
          versions,
        }
        if (q.get('cursor')) await wait(opts.cursorDelayMs)
        return route.fulfill(json(200, payload))
      }
      const item = store.get(id)
      if (!item) return route.fulfill(json(404, { error: 'not found' }))
      if (req.method() === 'GET') {
        const detail: AdminDetail = {
          ...item,
          screenshot_url: item.screenshot_path ? `${ORIGIN}/shot/${id}.png?sig=${++signed}` : null,
        }
        return route.fulfill(json(200, detail))
      }
      if (req.method() === 'PATCH') {
        await wait(opts.patchDelayMs)
        await wait(opts.patchDelays?.[patchN++])
        if (purgeOnPatch) { purgeOnPatch = false; store.delete(id); return route.fulfill(json(404, { error: 'not found' })) }
        if (conflictWith) {
          Object.assign(item, conflictWith, { status_updated_at: `elsewhere-${Date.now()}` })
          conflictWith = undefined
          return route.fulfill(json(409, { current: item }))
        }
        if (body.expected_status_updated_at !== item.status_updated_at) return route.fulfill(json(409, { current: item }))
        item.status = body.status
        item.status_updated_at = `opaque-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        return route.fulfill(json(200, item))
      }
    }
    return route.fulfill({ status: 404, body: '' })
  })
  const search = opts.search ?? (opts.view === 'inbox' ? `?status=open${opts.id ? `&id=${opts.id}` : ''}` : '')
  await page.goto(`${ORIGIN}/admin${search}`)
  return { calls, store }
}

export async function events(page: Page): Promise<{ type: string; payload: any }[]> {
  return page.evaluate(() => (window as any).__events)
}

export function makeItem(over: Partial<AdminItem> = {}): AdminItem {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    page_url: '/clients?q=…',
    element_selector: 'main > form#search > button.primary',
    element_text: 'Search clients',
    feedback: 'The search button is too small to tap.',
    screenshot_path: 'shots/one.png',
    status: 'open',
    created_at: '2026-11-01T12:00:00.000Z',
    ux_review_requested: false,
    tester_id: 'tester-1',
    tester_label: 'Dana Tester',
    app_version: '1.4.2',
    user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) TestAgent',
    expires_at: new Date(Date.UTC(2026, 10, 3, 12) + 11.5 * 86_400_000).toISOString(),
    status_updated_at: 'opaque-ts-1',
    status_updated_by: null,
    ...over,
  }
}
