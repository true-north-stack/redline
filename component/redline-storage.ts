// Redline storage adapters. Server-only: used by the API route, never the browser.
//
// local    → redline/feedback.json + redline/screenshots/ in the project root (default)
// supabase → feedback.items table + a private bucket, written with the secret key

import { readFile, writeFile, mkdir, unlink } from 'fs/promises'
import { join } from 'path'
import { DEFAULT_BUCKET, type RedlineConfig } from './redline-config'

export type RedlineStatus = 'open' | 'fixed' | 'dismissed' | 'deferred'

export interface RedlineItem {
  id: string
  page_url: string
  element_selector: string
  element_text: string | null
  feedback: string
  screenshot_path: string | null
  status: RedlineStatus
  created_at: string
  ux_review_requested: boolean
  tester_id: string | null
  app_version: string | null
  user_agent: string | null
  expires_at: string
}

export interface RedlineStore {
  /** Store a screenshot for item id; returns the screenshot_path to save on the item. */
  saveAttachment(id: string, file: Blob): Promise<string>
  saveItem(item: RedlineItem): Promise<void>
  list(filter?: { status?: RedlineStatus }): Promise<RedlineItem[]>
  /** Delete items (and their screenshots) whose expires_at has passed. */
  purge(now?: Date): Promise<{ items: number; attachments: number }>
}

export function createRedlineStore(config: RedlineConfig, projectRoot: string): RedlineStore {
  if (typeof window !== 'undefined') throw new Error('[redline] storage is server-only')
  return config.storage === 'supabase' ? supabaseStore(config) : localStore(projectRoot)
}

// ---------------------------------------------------------------------------
// Local: redline/feedback.json (a JSON array) + redline/screenshots/{id}.png
// ---------------------------------------------------------------------------

export function localStore(projectRoot: string): RedlineStore {
  const dir = join(projectRoot, 'redline')
  const feedbackPath = join(dir, 'feedback.json')
  const screenshotsDir = join(dir, 'screenshots')

  async function read(): Promise<RedlineItem[]> {
    try {
      return JSON.parse(await readFile(feedbackPath, 'utf-8'))
    } catch {
      return []
    }
  }

  async function write(items: RedlineItem[]) {
    await mkdir(dir, { recursive: true })
    await writeFile(feedbackPath, JSON.stringify(items, null, 2))
  }

  return {
    async saveAttachment(id, file) {
      await mkdir(screenshotsDir, { recursive: true })
      const filename = `${id}${file.type === 'image/png' ? '.png' : '.jpg'}`
      await writeFile(join(screenshotsDir, filename), Buffer.from(await file.arrayBuffer()))
      return `redline/screenshots/${filename}`
    },

    async saveItem(item) {
      const items = await read()
      items.push(item)
      await write(items)
    },

    async list(filter) {
      const items = await read()
      return filter?.status ? items.filter((r) => r.status === filter.status) : items
    },

    async purge(now = new Date()) {
      const items = await read()
      const expired = items.filter((r) => isExpired(r, now))
      let attachments = 0
      for (const r of expired) {
        if (!r.screenshot_path) continue
        try {
          await unlink(join(projectRoot, r.screenshot_path))
          attachments++
        } catch {
          // already gone
        }
      }
      if (expired.length) await write(items.filter((r) => !isExpired(r, now)))
      return { items: expired.length, attachments }
    },
  }
}

// Items saved before expires_at existed fall back to created_at + 30 days
function isExpired(r: Partial<RedlineItem>, now: Date): boolean {
  const expires = r.expires_at
    ? new Date(r.expires_at)
    : new Date(new Date(r.created_at ?? 0).getTime() + 30 * 86_400_000)
  return expires.getTime() <= now.getTime()
}

// ---------------------------------------------------------------------------
// Supabase: feedback.items + private bucket, over the REST APIs (no client dependency)
// ---------------------------------------------------------------------------

export function supabaseStore(config: RedlineConfig): RedlineStore {
  const url = config.supabase?.url?.replace(/\/$/, '')
  const key = config.supabase?.secretKey
  const bucket = config.supabase?.bucket || DEFAULT_BUCKET
  if (!url || !key) throw new Error('[redline] storage is "supabase" but supabase.url / supabase.secretKey are missing')

  const auth = { apikey: key, Authorization: `Bearer ${key}` }

  async function rest(path: string, init: RequestInit & { profile: 'read' | 'write' }) {
    const { profile, headers, ...rest } = init
    const res = await fetch(`${url}/rest/v1/${path}`, {
      ...rest,
      headers: {
        ...auth,
        [profile === 'read' ? 'Accept-Profile' : 'Content-Profile']: 'feedback',
        'Content-Type': 'application/json',
        ...headers,
      },
    })
    if (!res.ok) throw new Error(`[redline] Supabase ${init.method ?? 'GET'} ${path} failed: ${res.status} ${await res.text()}`)
    return res
  }

  async function removeObjects(paths: string[]) {
    if (!paths.length) return
    const res = await fetch(`${url}/storage/v1/object/${bucket}`, {
      method: 'DELETE',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: paths }),
    })
    if (!res.ok) throw new Error(`[redline] Supabase storage delete failed: ${res.status} ${await res.text()}`)
  }

  return {
    async saveAttachment(id, file) {
      const path = `${id}${file.type === 'image/png' ? '.png' : '.jpg'}`
      const res = await fetch(`${url}/storage/v1/object/${bucket}/${path}`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': file.type || 'image/png', 'x-upsert': 'false' },
        body: file,
      })
      if (!res.ok) throw new Error(`[redline] Supabase upload failed: ${res.status} ${await res.text()}`)
      return path
    },

    async saveItem(item) {
      try {
        await rest('items', { method: 'POST', profile: 'write', body: JSON.stringify(item), headers: { Prefer: 'return=minimal' } })
      } catch (err) {
        // Don't leave an orphaned screenshot behind
        if (item.screenshot_path) await removeObjects([item.screenshot_path]).catch(() => {})
        throw err
      }
    },

    async list(filter) {
      const status = filter?.status ? `&status=eq.${filter.status}` : ''
      const res = await rest(`items?select=*&order=created_at.asc${status}`, { profile: 'read' })
      return res.json()
    },

    async purge(now = new Date()) {
      const res = await rest(
        `items?select=id,screenshot_path&expires_at=lte.${encodeURIComponent(now.toISOString())}&limit=1000`,
        { profile: 'read' },
      )
      const expired: Pick<RedlineItem, 'id' | 'screenshot_path'>[] = await res.json()
      if (!expired.length) return { items: 0, attachments: 0 }
      const paths = expired.map((r) => r.screenshot_path).filter((p): p is string => !!p)
      // Objects first: if this fails the rows stay, and the next run retries
      await removeObjects(paths)
      await rest(`items?id=in.(${expired.map((r) => r.id).join(',')})`, { method: 'DELETE', profile: 'write' })
      return { items: expired.length, attachments: paths.length }
    },
  }
}
