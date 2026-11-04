// Local adapter, CLI purge and URL sanitizing. Node only, no browser.

import { test, expect } from '@playwright/test'
import { mkdtemp, readFile, writeFile, mkdir, access } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { localStore, type RedlineItem } from '../component/redline-storage'
import { sanitizePageUrl } from '../component/redline-config'

const CLI = fileURLToPath(new URL('../scripts/redline.mjs', import.meta.url))
const DAY = 86_400_000

function item(overrides: Partial<RedlineItem> = {}): RedlineItem {
  const created = new Date()
  return {
    id: crypto.randomUUID(),
    page_url: '/bookings',
    element_selector: '#save',
    element_text: 'Save',
    feedback: 'Button is misaligned',
    screenshot_path: null,
    status: 'open',
    created_at: created.toISOString(),
    ux_review_requested: false,
    tester_id: null,
    app_version: null,
    user_agent: null,
    expires_at: new Date(created.getTime() + 30 * DAY).toISOString(),
    ...overrides,
  }
}

const exists = (p: string) => access(p).then(() => true, () => false)

test('local store writes the same feedback.json + screenshots layout as before', async () => {
  const root = await mkdtemp(join(tmpdir(), 'redline-'))
  const store = localStore(root)

  const r = item()
  r.screenshot_path = await store.saveAttachment(r.id, new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }))
  await store.saveItem(r)
  await store.saveItem(item({ status: 'fixed' }))

  expect(r.screenshot_path).toBe(`redline/screenshots/${r.id}.png`)
  expect(await exists(join(root, r.screenshot_path))).toBe(true)

  const saved = JSON.parse(await readFile(join(root, 'redline', 'feedback.json'), 'utf-8'))
  expect(Array.isArray(saved)).toBe(true)
  expect(saved).toHaveLength(2)
  // Fields the slash commands rely on are all still there
  for (const key of ['id', 'page_url', 'element_selector', 'element_text', 'feedback', 'screenshot_path', 'status', 'created_at']) {
    expect(saved[0]).toHaveProperty(key)
  }

  expect(await store.list({ status: 'open' })).toHaveLength(1)
  expect(await store.list()).toHaveLength(2)
})

test('local purge deletes expired items and their screenshots, keeps the rest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'redline-'))
  const store = localStore(root)
  const old = item({ expires_at: new Date(Date.now() - DAY).toISOString() })
  old.screenshot_path = await store.saveAttachment(old.id, new Blob(['x'], { type: 'image/png' }))
  await store.saveItem(old)
  // Saved before expires_at existed: falls back to created_at + 30 days
  await store.saveItem({ ...item({ created_at: new Date(Date.now() - 31 * DAY).toISOString() }), expires_at: undefined as never })
  const fresh = item()
  await store.saveItem(fresh)

  expect(await store.purge()).toEqual({ items: 2, attachments: 1 })
  expect(await exists(join(root, old.screenshot_path))).toBe(false)
  expect((await store.list()).map((r) => r.id)).toEqual([fresh.id])
})

test('mode prints local without remote config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'redline-'))
  const env: Record<string, string | undefined> = { ...process.env, REDLINE_ROOT: root }
  delete env.REDLINE_REMOTE_URL
  delete env.REDLINE_SYNC_SECRET
  expect(execFileSync('node', [CLI, 'mode'], { env, encoding: 'utf-8' }).trim()).toBe('local')
})

test('CLI purge: expires_at by default, --days overrides', async () => {
  const root = await mkdtemp(join(tmpdir(), 'redline-'))
  await mkdir(join(root, 'redline', 'screenshots'), { recursive: true })
  const expired = item({ expires_at: new Date(Date.now() - DAY).toISOString(), screenshot_path: 'redline/screenshots/a.png' })
  const tenDaysOld = item({ created_at: new Date(Date.now() - 10 * DAY).toISOString() })
  const today = item()
  await writeFile(join(root, 'redline', 'screenshots', 'a.png'), 'x')
  await writeFile(join(root, 'redline', 'feedback.json'), JSON.stringify([expired, tenDaysOld, today]))

  const run = (...args: string[]) =>
    execFileSync('node', [CLI, 'purge', ...args], { env: { ...process.env, REDLINE_ROOT: root }, encoding: 'utf-8' }).trim()
  const remaining = async () => JSON.parse(await readFile(join(root, 'redline', 'feedback.json'), 'utf-8')).map((r: RedlineItem) => r.id)

  expect(run()).toBe('Purged 1 redline and 1 screenshot.')
  expect(await remaining()).toEqual([tenDaysOld.id, today.id])
  expect(await exists(join(root, 'redline', 'screenshots', 'a.png'))).toBe(false)

  expect(run('--days', '7')).toBe('Purged 1 redline and 0 screenshots.')
  expect(await remaining()).toEqual([today.id])
})

test('page URLs keep path and query keys, never values or token fragments', () => {
  expect(sanitizePageUrl('/clients')).toBe('/clients')
  expect(sanitizePageUrl('/clients?q=Jane%20Patient&tab=notes')).toBe('/clients?q=…&tab=…')
  expect(sanitizePageUrl('/settings#billing')).toBe('/settings#billing')
  expect(sanitizePageUrl('/auth/callback#access_token=abc&refresh_token=def')).toBe('/auth/callback')
  expect(sanitizePageUrl('https://app.example.com/jobs/123?token=secret')).toBe('/jobs/123?token=…')
})

test('local store inbox methods reject', async () => {
  const s = localStore(await mkdtemp(join(tmpdir(), 'redline-')))
  expect(s.kind).toBe('local')
  await expect(s.query({})).rejects.toThrow(/not supported/)
  await expect(s.summary()).rejects.toThrow(/not supported/)
  await expect(s.get(crypto.randomUUID())).rejects.toThrow(/not supported/)
  await expect(s.setStatus(crypto.randomUUID(), 'fixed', 'a', 'x')).rejects.toThrow(/not supported/)
  await expect(s.screenshotUrl('a.png')).rejects.toThrow(/not supported/)
})
