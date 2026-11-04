// Supabase adapter, access lockdown, purge function and CLI pull against a real
// Supabase stack. Skipped unless these are set (e.g. from `supabase start` output):
//
//   REDLINE_SB_URL           API URL
//   REDLINE_SB_SECRET        secret key (sb_secret_…) or legacy service_role key
//   REDLINE_SB_PUBLIC        publishable or anon key (must be locked out)
//   REDLINE_SB_PURGE_SECRET  REDLINE_PURGE_SECRET the function was started with
//   REDLINE_SB_SYNC_SECRET   REDLINE_SYNC_SECRET the function was started with
//
// `pnpm test:stack` starts a local stack and writes these to .redline-stack/test.env.

import { test, expect } from '@playwright/test'
import { mkdtemp, readFile, access } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { supabaseStore, type RedlineItem } from '../component/redline-storage'

const URL_ = process.env.REDLINE_SB_URL ?? ''
const SECRET = process.env.REDLINE_SB_SECRET ?? ''
const PUBLIC = process.env.REDLINE_SB_PUBLIC ?? ''
const PURGE_SECRET = process.env.REDLINE_SB_PURGE_SECRET ?? ''
const SYNC_SECRET = process.env.REDLINE_SB_SYNC_SECRET ?? ''
const CLI = fileURLToPath(new URL('../scripts/redline.mjs', import.meta.url))
const DAY = 86_400_000
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

test.skip(!URL_ || !SECRET || !PUBLIC || !PURGE_SECRET || !SYNC_SECRET, 'REDLINE_SB_* env not set')
test.describe.configure({ mode: 'serial' })

const store = () => supabaseStore({ storage: 'supabase', supabase: { url: URL_, secretKey: SECRET } })

function item(overrides: Partial<RedlineItem> = {}): RedlineItem {
  const created = new Date()
  return {
    id: crypto.randomUUID(),
    page_url: '/jobs?q=…',
    element_selector: '#save',
    element_text: '[redacted]',
    feedback: 'Save button overlaps the footer',
    screenshot_path: null,
    status: 'open',
    created_at: created.toISOString(),
    ux_review_requested: true,
    tester_id: 'tester-1',
    app_version: '0.9.0-alpha',
    user_agent: 'Mozilla/5.0 (Macintosh) Test',
    expires_at: new Date(created.getTime() + 30 * DAY).toISOString(),
    ...overrides,
  }
}

async function saveWithScreenshot(r: RedlineItem) {
  const s = store()
  r.screenshot_path = await s.saveAttachment(r.id, new Blob([PNG], { type: 'image/png' }))
  await s.saveItem(r)
  return r
}

const objectStatus = (path: string, key: string) =>
  fetch(`${URL_}/storage/v1/object/authenticated/redline-screenshots/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  }).then((r) => r.status)

const restHeaders = (key: string) => ({
  apikey: key,
  Authorization: `Bearer ${key}`,
  'Accept-Profile': 'feedback',
  'Content-Profile': 'feedback',
})

async function readRow(id: string) {
  const res = await fetch(`${URL_}/rest/v1/items?id=eq.${id}&select=*`, { headers: restHeaders(SECRET) })
  expect(res.ok).toBe(true)
  return (await res.json())[0]
}

async function patchRow(id: string, patch: Record<string, unknown>) {
  const res = await fetch(`${URL_}/rest/v1/items?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...restHeaders(SECRET), 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  expect(res.ok).toBe(true)
}

const rpcRaw = (key: string) =>
  fetch(`${URL_}/rest/v1/rpc/inbox_summary`, {
    method: 'POST',
    headers: { ...restHeaders(key), 'Content-Type': 'application/json' },
    body: '{}',
  })

async function rpcSummary(key: string) {
  const res = await rpcRaw(key)
  expect(res.status).toBe(200)
  return (await res.json()) as {
    counts: { open: number; fixed: number; dismissed: number; deferred: number }
    testers: string[]
    versions: string[]
  }
}

let fresh: RedlineItem

test('saves the item with all metadata and a private screenshot', async () => {
  fresh = await saveWithScreenshot(item())
  const rows = await store().list()
  const row = rows.find((r) => r.id === fresh.id)
  expect(row).toMatchObject({
    tester_id: 'tester-1',
    app_version: '0.9.0-alpha',
    user_agent: 'Mozilla/5.0 (Macintosh) Test',
    ux_review_requested: true,
    page_url: '/jobs?q=…',
    screenshot_path: `${fresh.id}.png`,
  })
  expect(await objectStatus(fresh.screenshot_path!, SECRET)).toBe(200)
})

test('testers with the public key can neither read nor write', async () => {
  const headers = { apikey: PUBLIC, Authorization: `Bearer ${PUBLIC}` }
  const read = await fetch(`${URL_}/rest/v1/items?select=*`, { headers: { ...headers, 'Accept-Profile': 'feedback' } })
  expect(read.ok).toBe(false)
  const write = await fetch(`${URL_}/rest/v1/items`, {
    method: 'POST',
    headers: { ...headers, 'Content-Profile': 'feedback', 'Content-Type': 'application/json' },
    body: JSON.stringify(item()),
  })
  expect(write.ok).toBe(false)
  expect(await objectStatus(fresh.screenshot_path!, PUBLIC)).not.toBe(200)
})

test('purge function deletes expired rows and their screenshots, keeps fresh ones', async () => {
  const expired = await saveWithScreenshot(item({ expires_at: new Date(Date.now() - DAY).toISOString() }))

  const unauthorized = await fetch(`${URL_}/functions/v1/redline-purge`, { method: 'POST' })
  expect(unauthorized.status).toBe(401)

  const res = await fetch(`${URL_}/functions/v1/redline-purge`, {
    method: 'POST',
    headers: { 'x-redline-purge-secret': PURGE_SECRET },
  })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ items: 1, attachments: 1 })

  const ids = (await store().list()).map((r) => r.id)
  expect(ids).not.toContain(expired.id)
  expect(ids).toContain(fresh.id)
  expect(await objectStatus(expired.screenshot_path!, SECRET)).not.toBe(200)
  expect(await objectStatus(fresh.screenshot_path!, SECRET)).toBe(200)
})

test('adapter purge does the same', async () => {
  const expired = await saveWithScreenshot(item({ expires_at: new Date(Date.now() - DAY).toISOString() }))
  expect(await store().purge()).toEqual({ items: 1, attachments: 1 })
  expect(await objectStatus(expired.screenshot_path!, SECRET)).not.toBe(200)
})

test('CLI pull copies remote redlines and screenshots into feedback.json, once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'redline-'))
  const env = { ...process.env, REDLINE_ROOT: root, SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: SECRET }
  const pull = () => execFileSync('node', [CLI, 'pull'], { env, encoding: 'utf-8' }).trim()

  expect(pull()).toMatch(/^Pulled [1-9]\d* new redlines? \(0 already local\)\.$/)
  const local: RedlineItem[] = JSON.parse(await readFile(join(root, 'redline', 'feedback.json'), 'utf-8'))
  const pulled = local.find((r) => r.id === fresh.id)!
  expect(pulled.screenshot_path).toBe(`redline/screenshots/${fresh.id}.png`)
  await access(join(root, pulled.screenshot_path!))

  expect(pull()).toMatch(/^Pulled 0 new redlines \(\d+ already local\)\.$/)
})

test('status change stamps status_updated_at; other updates leave it', async () => {
  const r = await saveWithScreenshot(item())
  const t0 = (await readRow(r.id)).status_updated_at
  await patchRow(r.id, { feedback: 'edited' })
  expect((await readRow(r.id)).status_updated_at).toBe(t0)
  await patchRow(r.id, { status: 'fixed' })
  expect((await readRow(r.id)).status_updated_at).not.toBe(t0)
})

test('inbox_summary returns zero-filled counts, testers and versions; the public key cannot call it', async () => {
  const before = await rpcSummary(SECRET)
  await saveWithScreenshot(item({ tester_id: 'tester-sum', app_version: '9.9.9' }))
  const after = await rpcSummary(SECRET)
  expect(Object.keys(after.counts).sort()).toEqual(['deferred', 'dismissed', 'fixed', 'open'])
  expect(after.counts.open).toBe(before.counts.open + 1)
  expect(after.testers).toContain('tester-sum')
  expect(after.versions).toContain('9.9.9')
  expect((await rpcRaw(PUBLIC)).status).not.toBe(200)
})

test('query pages newest first with a stable cursor', async () => {
  const s = store()
  const tester = `pg-${crypto.randomUUID()}`
  const created_at = new Date().toISOString()
  const made = [item({ tester_id: tester, created_at }), item({ tester_id: tester, created_at }), item({ tester_id: tester, created_at })]
  for (const r of made) await s.saveItem(r)

  const one = await s.query({ testerId: tester, limit: 2 })
  expect(one.items).toHaveLength(2)
  expect(one.nextCursor).not.toBeNull()
  const two = await s.query({ testerId: tester, limit: 2, cursor: one.nextCursor! })
  expect(two.items).toHaveLength(1)
  expect(two.nextCursor).toBeNull()

  const all = [...one.items, ...two.items]
  expect(new Set(all.map((r) => r.id)).size).toBe(3)
  expect(all.map((r) => r.id)).toEqual(made.map((r) => r.id).sort().reverse())
})

test('query filters by status, tester and version', async () => {
  const s = store()
  const tag = crypto.randomUUID()
  const a = item({ tester_id: `t-a-${tag}`, app_version: `v-a-${tag}` })
  const b = item({ tester_id: `t-b-${tag}`, app_version: `v-b-${tag}`, status: 'deferred' })
  await s.saveItem(a)
  await s.saveItem(b)

  const byTester = await s.query({ testerId: `t-a-${tag}` })
  expect(byTester.items.map((r) => r.id)).toEqual([a.id])
  const byVersion = await s.query({ appVersion: `v-b-${tag}` })
  expect(byVersion.items.map((r) => r.id)).toEqual([b.id])
  const byStatus = await s.query({ status: 'deferred', testerId: `t-b-${tag}` })
  expect(byStatus.items.map((r) => r.id)).toEqual([b.id])
  const none = await s.query({ status: 'fixed', testerId: `t-a-${tag}` })
  expect(none.items).toEqual([])
})

test('get returns the item or null', async () => {
  const s = store()
  const r = item()
  await s.saveItem(r)
  expect((await s.get(r.id))?.id).toBe(r.id)
  expect(await s.get(crypto.randomUUID())).toBeNull()
})

test('setStatus: success, conflict, missing', async () => {
  const s = store()
  const r = item()
  await s.saveItem(r)
  const before = (await s.get(r.id))!

  const ok = await s.setStatus(r.id, 'fixed', 'admin-1', before.status_updated_at!)
  expect('item' in ok).toBe(true)
  if (!('item' in ok)) return
  expect(ok.item.status).toBe('fixed')
  expect(ok.item.status_updated_by).toBe('admin-1')
  expect(ok.item.status_updated_at).not.toBe(before.status_updated_at)

  const stale = await s.setStatus(r.id, 'dismissed', 'admin-2', before.status_updated_at!)
  expect('conflict' in stale).toBe(true)
  if ('conflict' in stale) expect(stale.conflict.status).toBe('fixed')

  expect(await s.setStatus(crypto.randomUUID(), 'fixed', 'admin-1', before.status_updated_at!)).toEqual({ missing: true })
})

test('status_updated_at is returned exactly as stored', async () => {
  const s = store()
  const r = item()
  await s.saveItem(r)
  const got = await s.get(r.id)
  expect(got!.status_updated_at).toBe((await readRow(r.id)).status_updated_at)
})

test('screenshotUrl signs for 300s and is null for a missing object', async () => {
  const s = store()
  const r = await saveWithScreenshot(item())
  const signed = await s.screenshotUrl(r.screenshot_path!)
  expect(signed).toBeTruthy()
  const res = await fetch(signed!)
  expect(res.status).toBe(200)
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG)

  const short = await s.screenshotUrl(r.screenshot_path!, 1)
  await new Promise((resolve) => setTimeout(resolve, 2500))
  expect((await fetch(short!)).status).not.toBe(200)

  expect(await s.screenshotUrl(`${crypto.randomUUID()}.png`)).toBeNull()
})
