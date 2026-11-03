// Supabase adapter, access lockdown, purge function and CLI pull against a real
// Supabase stack. Skipped unless these are set (e.g. from `supabase start` output):
//
//   REDLINE_SB_URL           API URL
//   REDLINE_SB_SECRET        secret key (sb_secret_…) or legacy service_role key
//   REDLINE_SB_PUBLIC        publishable or anon key (must be locked out)
//   REDLINE_SB_PURGE_SECRET  REDLINE_PURGE_SECRET the function was started with

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
const CLI = fileURLToPath(new URL('../scripts/redline.mjs', import.meta.url))
const DAY = 86_400_000
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

test.skip(!URL_ || !SECRET || !PUBLIC || !PURGE_SECRET, 'REDLINE_SB_* env not set')
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
