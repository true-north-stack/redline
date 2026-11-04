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
import { mkdtemp, readFile, writeFile, mkdir, access } from 'fs/promises'
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

// ---- CLI mode / pull / push through redline-sync ----

type CliResult = { out: string; err: string; code: number }

function cli(root: string, args: string[], extra: Record<string, string | undefined> = {}): CliResult {
  const env: Record<string, string | undefined> = { ...process.env, REDLINE_ROOT: root, ...extra }
  delete env.REDLINE_REMOTE_URL
  delete env.REDLINE_SYNC_SECRET
  Object.assign(env, extra)
  try {
    const out = execFileSync('node', [CLI, ...args], { env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { out: out.trim(), err: '', code: 0 }
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; status?: number }
    return { out: (x.stdout ?? '').trim(), err: (x.stderr ?? '').trim(), code: x.status ?? 1 }
  }
}

const remoteEnv = { REDLINE_REMOTE_URL: URL_, REDLINE_SYNC_SECRET: SYNC_SECRET }
const newRoot = () => mkdtemp(join(tmpdir(), 'redline-'))
const feedbackFile = (root: string) => join(root, 'redline', 'feedback.json')
const readLocal = async (root: string): Promise<(RedlineItem & Record<string, unknown>)[]> =>
  JSON.parse(await readFile(feedbackFile(root), 'utf-8'))
async function editLocal(root: string, id: string, patch: Record<string, unknown>) {
  const items = await readLocal(root)
  Object.assign(items.find((r) => r.id === id)!, patch)
  await writeFile(feedbackFile(root), JSON.stringify(items, null, 2))
}
const host = URL_ ? new URL(URL_).host : ''

test('mode prints remote with the host from .env.redline', async () => {
  const root = await newRoot()
  await writeFile(join(root, '.env.redline'), `# project\nREDLINE_REMOTE_URL=${URL_}\nREDLINE_SYNC_SECRET="${SYNC_SECRET}"\n`)
  const r = cli(root, ['mode'])
  expect(r.code).toBe(0)
  expect(r.out).toBe(`remote ${host}`)
})

test('pull without remote config fails and names .env.redline, even with SUPABASE_URL set', async () => {
  const root = await newRoot()
  const r = cli(root, ['pull'], { SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: SECRET })
  expect(r.code).toBe(1)
  expect(r.err).toContain('.env.redline')
  expect(r.out).toBe('')
})

test('pull stores source, remote_status and the exact remote_status_updated_at string', async () => {
  const root = await newRoot()
  const r0 = await saveWithScreenshot(item())
  const r = cli(root, ['pull'], remoteEnv)
  expect(r.code).toBe(0)
  const pulled = (await readLocal(root)).find((x) => x.id === r0.id)!
  const remote = (await store().get(r0.id))!
  expect(pulled.source).toBe('remote')
  expect(pulled.status).toBe('open')
  expect(pulled.remote_status).toBe('open')
  expect(pulled.remote_status_updated_at === remote.status_updated_at).toBe(true)
  expect(pulled.screenshot_path).toBe(`redline/screenshots/${r0.id}.png`)
  await access(join(root, pulled.screenshot_path!))
  expect(cli(root, ['pull'], remoteEnv).out).toMatch(/Pulled 0 new/)
})

test('pull and push print the project host first', async () => {
  const root = await newRoot()
  expect(cli(root, ['pull'], remoteEnv).out.split('\n')[0]).toBe(`Supabase: ${host}`)
  expect(cli(root, ['push'], remoteEnv).out.split('\n')[0]).toBe(`Supabase: ${host}`)
})

test('push after pull succeeds and records redline-cli', async () => {
  const root = await newRoot()
  const r0 = await saveWithScreenshot(item())
  cli(root, ['pull'], remoteEnv)
  await editLocal(root, r0.id, { status: 'fixed' })
  const r = cli(root, ['push'], remoteEnv)
  expect(r.code).toBe(0)
  const remote = (await store().get(r0.id))!
  expect(remote.status).toBe('fixed')
  expect(remote.status_updated_by).toBe('redline-cli')
  const local = (await readLocal(root)).find((x) => x.id === r0.id)!
  expect(local.remote_status).toBe('fixed')
  expect(local.remote_status_updated_at === remote.status_updated_at).toBe(true)
  // a second push has nothing left to send
  expect(cli(root, ['push'], remoteEnv).out).not.toContain(r0.id)
})

test('push conflict changes nothing remotely and says to pull', async () => {
  const root = await newRoot()
  const r0 = await saveWithScreenshot(item())
  cli(root, ['pull'], remoteEnv)
  const seen = (await store().get(r0.id))!
  expect(await store().setStatus(r0.id, 'dismissed', 'admin-1', seen.status_updated_at!)).toHaveProperty('item')
  await editLocal(root, r0.id, { status: 'fixed' })
  const r = cli(root, ['push'], remoteEnv)
  expect(r.out).toContain(`Conflict on ${r0.id}: changed in the inbox. Run pull.`)
  const remote = (await store().get(r0.id))!
  expect(remote.status).toBe('dismissed')
  expect(remote.status_updated_by).toBe('admin-1')
})

test('pull after a conflict takes the remote status and reports the discarded change', async () => {
  const root = await newRoot()
  const r0 = await saveWithScreenshot(item())
  cli(root, ['pull'], remoteEnv)
  const seen = (await store().get(r0.id))!
  await store().setStatus(r0.id, 'dismissed', 'admin-1', seen.status_updated_at!)
  await editLocal(root, r0.id, { status: 'fixed' })
  const r = cli(root, ['pull'], remoteEnv)
  expect(r.out).toContain(`Discarded local change on ${r0.id} (${r0.page_url}): fixed → kept dismissed`)
  const local = (await readLocal(root)).find((x) => x.id === r0.id)!
  const remote = (await store().get(r0.id))!
  expect(local.status).toBe('dismissed')
  expect(local.remote_status).toBe('dismissed')
  expect(local.remote_status_updated_at === remote.status_updated_at).toBe(true)
  // settled: nothing more to push
  expect(cli(root, ['push'], remoteEnv).out).not.toContain(r0.id)
})

test('pull takes an inbox change when the local copy was untouched', async () => {
  const root = await newRoot()
  const r0 = await saveWithScreenshot(item())
  cli(root, ['pull'], remoteEnv)
  const seen = (await store().get(r0.id))!
  await store().setStatus(r0.id, 'deferred', 'admin-1', seen.status_updated_at!)
  const r = cli(root, ['pull'], remoteEnv)
  expect(r.out).not.toContain('Discarded')
  expect((await readLocal(root)).find((x) => x.id === r0.id)!.status).toBe('deferred')
})

test('pull keeps an unpushed local change when the remote has not moved', async () => {
  const root = await newRoot()
  const r0 = await saveWithScreenshot(item())
  cli(root, ['pull'], remoteEnv)
  await editLocal(root, r0.id, { status: 'fixed' })
  const r = cli(root, ['pull'], remoteEnv)
  expect(r.out).not.toContain('Discarded')
  const local = (await readLocal(root)).find((x) => x.id === r0.id)!
  expect(local.status).toBe('fixed')
  expect(local.remote_status).toBe('open')
  expect(cli(root, ['push'], remoteEnv).code).toBe(0)
  expect((await store().get(r0.id))!.status).toBe('fixed')
})

test('local-only items are never pushed', async () => {
  const root = await newRoot()
  const local = item({ status: 'fixed' })
  await mkdir(join(root, 'redline'), { recursive: true })
  await writeFile(feedbackFile(root), JSON.stringify([local]))
  const r = cli(root, ['push'], remoteEnv)
  expect(r.code).toBe(0)
  expect(await store().get(local.id)).toBeNull()
  expect(r.out).not.toContain(local.id)
  expect((await readLocal(root))[0]).toEqual(local)
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

// ---- redline-sync function ----

const syncUrl = `${URL_}/functions/v1/redline-sync`
const sync = (body: unknown, secret: string | null = SYNC_SECRET) =>
  fetch(syncUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(secret === null ? {} : { 'x-redline-sync-secret': secret }) },
    body: JSON.stringify(body),
  })

test('sync rejects a wrong or missing secret with 401 and non-POST with 405', async () => {
  expect((await sync({ action: 'list' }, 'wrong')).status).toBe(401)
  expect((await sync({ action: 'list' }, null)).status).toBe(401)
  const get = await fetch(syncUrl, { method: 'GET', headers: { 'x-redline-sync-secret': SYNC_SECRET } })
  expect(get.status).toBe(405)
})

test('sync rejects unknown actions, bad ids and bad statuses with 400', async () => {
  const id = crypto.randomUUID()
  const t = new Date().toISOString()
  expect((await sync({ action: 'nope' })).status).toBe(400)
  expect((await sync({})).status).toBe(400)
  expect((await sync({ action: 'set_status', id: 'not-a-uuid', status: 'fixed', expected_status_updated_at: t })).status).toBe(400)
  expect((await sync({ action: 'set_status', id: `${id},${id}`, status: 'fixed', expected_status_updated_at: t })).status).toBe(400)
  expect((await sync({ action: 'set_status', id, status: 'bogus', expected_status_updated_at: t })).status).toBe(400)
  expect((await sync({ action: 'set_status', id, status: 'fixed' })).status).toBe(400)
})

test('sync list returns every status with signed screenshot URLs that download', async () => {
  const a = await saveWithScreenshot(item())
  const b = item({ status: 'dismissed' })
  await store().saveItem(b)
  const res = await sync({ action: 'list' })
  expect(res.status).toBe(200)
  const { items } = await res.json()
  const ra = items.find((r: RedlineItem) => r.id === a.id)
  const rb = items.find((r: RedlineItem) => r.id === b.id)
  expect(rb.status).toBe('dismissed')
  expect(rb.screenshot_url).toBeNull()
  expect(ra.screenshot_url).toBeTruthy()
  const dl = await fetch(ra.screenshot_url)
  expect(dl.status).toBe(200)
  expect(new Uint8Array(await dl.arrayBuffer())).toEqual(PNG)
  const times = items.map((r: RedlineItem) => r.created_at)
  expect(times).toEqual([...times].sort())
})

test('sync set_status succeeds, conflicts with 409 and misses with 404', async () => {
  const r = item()
  await store().saveItem(r)
  const t0 = (await readRow(r.id)).status_updated_at

  const ok = await sync({ action: 'set_status', id: r.id, status: 'fixed', expected_status_updated_at: t0 })
  expect(ok.status).toBe(200)
  const { item: updated } = await ok.json()
  expect(updated).toMatchObject({ id: r.id, status: 'fixed', status_updated_by: 'redline-cli' })
  expect(updated.status_updated_at).not.toBe(t0)

  const stale = await sync({ action: 'set_status', id: r.id, status: 'deferred', expected_status_updated_at: t0 })
  expect(stale.status).toBe(409)
  expect((await stale.json()).conflict.status).toBe('fixed')
  expect((await readRow(r.id)).status).toBe('fixed')

  const missing = await sync({ action: 'set_status', id: crypto.randomUUID(), status: 'fixed', expected_status_updated_at: t0 })
  expect(missing.status).toBe(404)
  expect(await missing.json()).toEqual({ missing: true })
})

test('sync cannot delete', async () => {
  const r = item()
  await store().saveItem(r)
  expect((await sync({ action: 'delete', id: r.id })).status).toBe(400)
  expect(await readRow(r.id)).toBeTruthy()
})

// ---- Final review fixes ----

/** Insert n rows in one request; the test stack caps PostgREST responses at 100 rows. */
async function bulkInsert(n: number, over: Partial<RedlineItem> = {}): Promise<RedlineItem[]> {
  const rows = Array.from({ length: n }, () => item(over))
  const res = await fetch(`${URL_}/rest/v1/items`, {
    method: 'POST',
    headers: { ...restHeaders(SECRET), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(rows),
  })
  expect(res.ok).toBe(true)
  return rows
}

test('sync list pages past the PostgREST row cap and returns every item', async () => {
  const made = await bulkInsert(250)
  const res = await sync({ action: 'list' })
  expect(res.status).toBe(200)
  const { items } = await res.json()
  const ids = new Set(items.map((r: RedlineItem) => r.id))
  expect(items.length).toBe(ids.size)
  for (const r of made) expect(ids.has(r.id), r.id).toBe(true)
  const times = items.map((r: RedlineItem) => r.created_at)
  expect(times).toEqual([...times].sort())
})

test('adapter list pages past the PostgREST row cap', async () => {
  const made = await bulkInsert(150)
  const ids = new Set((await store().list()).map((r) => r.id))
  for (const r of made) expect(ids.has(r.id), r.id).toBe(true)
})

test('sync list signs screenshots in a batch; a missing object is null, not a failed list', async () => {
  const kept = await saveWithScreenshot(item())
  const lost = await saveWithScreenshot(item())
  const del = await fetch(`${URL_}/storage/v1/object/redline-screenshots`, {
    method: 'DELETE',
    headers: { apikey: SECRET, Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: [lost.screenshot_path] }),
  })
  expect(del.ok).toBe(true)
  const res = await sync({ action: 'list' })
  expect(res.status).toBe(200)
  const { items } = await res.json()
  expect(items.find((r: RedlineItem) => r.id === lost.id).screenshot_url).toBeNull()
  const url = items.find((r: RedlineItem) => r.id === kept.id).screenshot_url
  expect((await fetch(url)).status).toBe(200)
})

const exists = (p: string) => access(p).then(() => true, () => false)

async function deleteRemote(r: RedlineItem) {
  const res = await fetch(`${URL_}/rest/v1/items?id=eq.${r.id}`, { method: 'DELETE', headers: restHeaders(SECRET) })
  expect(res.ok).toBe(true)
  if (r.screenshot_path) {
    await fetch(`${URL_}/storage/v1/object/redline-screenshots`, {
      method: 'DELETE',
      headers: { apikey: SECRET, Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [r.screenshot_path] }),
    })
  }
}

test('pull removes a pulled item the remote has purged, with its screenshot', async () => {
  const root = await newRoot()
  const r0 = await saveWithScreenshot(item())
  expect(cli(root, ['pull'], remoteEnv).code).toBe(0)
  const shot = join(root, 'redline', 'screenshots', `${r0.id}.png`)
  expect(await exists(shot)).toBe(true)
  await deleteRemote(r0)
  const r = cli(root, ['pull'], remoteEnv)
  expect(r.code).toBe(0)
  expect(r.out).toContain('Removed 1 expired or purged redline.')
  expect((await readLocal(root)).some((x) => x.id === r0.id)).toBe(false)
  expect(await exists(shot)).toBe(false)
})

test('pull removes local items past expires_at and keeps unexpired local-only ones', async () => {
  const root = await newRoot()
  await mkdir(join(root, 'redline', 'screenshots'), { recursive: true })
  const expired = item({ expires_at: new Date(Date.now() - DAY).toISOString(), screenshot_path: 'redline/screenshots/old.png' })
  const fresh = item()
  await writeFile(join(root, 'redline', 'screenshots', 'old.png'), 'x')
  await writeFile(feedbackFile(root), JSON.stringify([expired, fresh]))
  const r = cli(root, ['pull'], remoteEnv)
  expect(r.code).toBe(0)
  expect(r.out).toContain('Removed 1 expired or purged redline.')
  const ids = (await readLocal(root)).map((x) => x.id)
  expect(ids).not.toContain(expired.id)
  expect(ids).toContain(fresh.id)
  expect(await exists(join(root, 'redline', 'screenshots', 'old.png'))).toBe(false)
})

test('pull names a removed item that had an unpushed local change', async () => {
  const root = await newRoot()
  const r0 = await saveWithScreenshot(item())
  cli(root, ['pull'], remoteEnv)
  await editLocal(root, r0.id, { status: 'fixed' })
  await deleteRemote(r0)
  const r = cli(root, ['pull'], remoteEnv)
  expect(r.out).toContain(`Removed 1 expired or purged redline (including ${r0.id}, changed locally).`)
  expect((await readLocal(root)).some((x) => x.id === r0.id)).toBe(false)
})

test('pull never removes anything when the remote list fails', async () => {
  const root = await newRoot()
  const r0 = await saveWithScreenshot(item())
  cli(root, ['pull'], remoteEnv)
  const before = await readFile(feedbackFile(root), 'utf-8')
  const r = cli(root, ['pull'], { ...remoteEnv, REDLINE_REMOTE_URL: 'http://127.0.0.1:9' })
  expect(r.code).toBe(1)
  expect(await readFile(feedbackFile(root), 'utf-8')).toBe(before)
  expect(await exists(join(root, 'redline', 'screenshots', `${r0.id}.png`))).toBe(true)
})
