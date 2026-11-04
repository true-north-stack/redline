// Local adapter, CLI purge and URL sanitizing. Node only, no browser.

import { test, expect } from '@playwright/test'
import { mkdtemp, readFile, writeFile, mkdir, access } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { localStore, supabaseStore, type RedlineItem } from '../component/redline-storage'
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

test('malformed feedback.json aborts pull, push and purge and is left byte-identical', async () => {
  const root = await mkdtemp(join(tmpdir(), 'redline-'))
  await mkdir(join(root, 'redline'), { recursive: true })
  const file = join(root, 'redline', 'feedback.json')
  const bad = '[{"id": "x", "status": "open",'
  await writeFile(file, bad)
  const env = { ...process.env, REDLINE_ROOT: root, REDLINE_REMOTE_URL: 'http://127.0.0.1:9', REDLINE_SYNC_SECRET: 's' }
  for (const cmd of ['pull', 'push', 'purge']) {
    let failure: { status?: number; stderr?: string } | null = null
    try {
      execFileSync('node', [CLI, cmd], { env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      failure = e as { status?: number; stderr?: string }
    }
    expect(failure?.status).toBe(1)
    expect(failure?.stderr).toContain('redline/feedback.json is not valid JSON; fix or move it, then retry.')
    expect(await readFile(file, 'utf-8')).toBe(bad)
  }
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
  // Protocol-relative and backslash forms parse as a host, so only the path survives
  expect(sanitizePageUrl('//evil.com/x')).toBe('/x')
  expect(sanitizePageUrl('/\\evil.com')).toBe('/')
  // A real path that starts with extra slashes collapses to one, so it can't read as //host
  expect(sanitizePageUrl('https://app.example.com//evil.com/x?a=1')).toBe('/evil.com/x?a=…')
  expect(sanitizePageUrl('https://app.example.com/\\evil.com')).toBe('/evil.com')
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

// ---- Final review fixes ----

test('Supabase errors keep method, path, status and code but never the response body', async () => {
  const SENTINEL = 'Failing row contains (Jane Q. Patient)'
  const real = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ code: '23514', message: 'new row violates check', details: SENTINEL }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch
  const plain = (async () => new Response(`<html>${SENTINEL}</html>`, { status: 500 })) as typeof fetch
  try {
    const s = supabaseStore({ storage: 'supabase', supabase: { url: 'http://sb.test', secretKey: 'k' } })
    const failures: Error[] = []
    const attempt = async (p: Promise<unknown>) => {
      try {
        await p
        throw new Error('expected a failure')
      } catch (e) {
        failures.push(e as Error)
      }
    }
    await attempt(s.saveItem(item()))
    await attempt(s.list())
    await attempt(s.saveAttachment(crypto.randomUUID(), new Blob(['x'], { type: 'image/png' })))
    await attempt(s.summary())
    globalThis.fetch = plain
    await attempt(s.screenshotUrl('a.png'))
    await attempt(s.get(crypto.randomUUID()))
    expect(failures).toHaveLength(6)
    for (const e of failures) {
      expect(e.message).not.toContain(SENTINEL)
      expect(e.message).not.toContain('Jane')
      expect(e.message).toMatch(/\b(400|500)\b/)
    }
    expect(failures[0].message).toContain('POST items')
    expect(failures[0].message).toContain('23514')
  } finally {
    globalThis.fetch = real
  }
})

test('an invalid REDLINE_REMOTE_URL is reported without echoing its value', async () => {
  const root = await mkdtemp(join(tmpdir(), 'redline-'))
  const env = { ...process.env, REDLINE_ROOT: root, REDLINE_REMOTE_URL: 'sb_secret_pasted-by-mistake', REDLINE_SYNC_SECRET: 's' }
  for (const cmd of ['mode', 'pull']) {
    let failure: { status?: number; stderr?: string; stdout?: string } | null = null
    try {
      execFileSync('node', [CLI, cmd], { env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      failure = e as { status?: number; stderr?: string }
    }
    expect(failure?.status).toBe(1)
    expect(failure?.stderr?.trim()).toBe('REDLINE_REMOTE_URL is not a valid URL')
    expect(`${failure?.stderr}${failure?.stdout}`).not.toContain('pasted-by-mistake')
  }
})
