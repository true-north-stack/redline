// Redline storage adapters. Server-only: used by the API route, never the browser.
//
// local    → redline/feedback.json + redline/screenshots/ in the project root (default)
// supabase → feedback.items table + a private bucket, written with the secret key

import { readFile, writeFile, mkdir, unlink } from 'fs/promises'
import { join } from 'path'
import { DEFAULT_BUCKET, type RedlineConfig } from './redline-config'

/** 'review' is To Review (tester feedback the owner hasn't triaged); 'open' is To Fix. */
export type RedlineStatus = 'review' | 'open' | 'fixed' | 'dismissed' | 'deferred'

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
  status_updated_at?: string
  status_updated_by?: string | null
  /** Supabase mode: when the owner first moved it to To Fix. Only approved rows sync to the CLI. */
  approved_at?: string | null
}

export interface InboxQuery {
  status?: RedlineStatus
  testerId?: string
  appVersion?: string
  cursor?: string
  limit?: number
}
export interface InboxPage {
  items: RedlineItem[]
  nextCursor: string | null
}
export interface InboxSummary {
  counts: Record<RedlineStatus, number>
  testers: string[]
  versions: string[]
}
export type SetStatusResult = { item: RedlineItem } | { conflict: RedlineItem } | { missing: true }

export const STATUSES: readonly RedlineStatus[] = ['review', 'open', 'fixed', 'dismissed', 'deferred']
export const isUuid = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

const DEFAULT_PAGE = 50
const MAX_PAGE = 100
/** Rows per request when reading everything. PostgREST may cap responses lower (max_rows). */
const SCAN_PAGE = 1000

export interface RedlineStore {
  readonly kind: 'local' | 'supabase'
  /** Store a screenshot for item id; returns the screenshot_path to save on the item. */
  saveAttachment(id: string, file: Blob): Promise<string>
  saveItem(item: RedlineItem): Promise<void>
  list(filter?: { status?: RedlineStatus }): Promise<RedlineItem[]>
  /** Delete items (and their screenshots) whose expires_at has passed. */
  purge(now?: Date): Promise<{ items: number; attachments: number }>
  /** Admin inbox: newest first, keyset-paged. Supabase only. */
  query(q: InboxQuery): Promise<InboxPage>
  summary(): Promise<InboxSummary>
  get(id: string): Promise<RedlineItem | null>
  /** Conditional on status_updated_at still equal to expectedUpdatedAt (opaque string). */
  setStatus(id: string, status: RedlineStatus, by: string, expectedUpdatedAt: string): Promise<SetStatusResult>
  /** Short-lived signed URL for a screenshot, or null if the object is gone. */
  screenshotUrl(path: string, ttlSeconds?: number): Promise<string | null>
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

  const unsupported = () => Promise.reject(new Error('[redline] inbox is not supported by the local store (use storage: "supabase")'))

  return {
    kind: 'local',
    query: unsupported,
    summary: unsupported,
    get: unsupported,
    setStatus: unsupported,
    screenshotUrl: unsupported,

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

// Only an item with an expires_at can expire. Items saved before 1.2.0 have none and are
// kept, so an automatic purge never deletes an owner's older notes.
function isExpired(r: Partial<RedlineItem>, now: Date): boolean {
  return !!r.expires_at && new Date(r.expires_at).getTime() <= now.getTime()
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

  // Error bodies can quote row data (PostgREST "Failing row contains (...)" carries
  // feedback text), and callers log these messages. Keep the status and PostgREST code only.
  async function failure(what: string, res: Response): Promise<Error> {
    let code = ''
    try {
      const parsed = JSON.parse(await res.text())
      if (parsed && typeof parsed.code === 'string' && /^[\w.-]{1,32}$/.test(parsed.code)) code = ` (${parsed.code})`
    } catch {
      // not JSON
    }
    return new Error(`[redline] Supabase ${what} failed: ${res.status}${code}`)
  }

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
    if (!res.ok) throw await failure(`${init.method ?? 'GET'} ${path.split('?')[0]}`, res)
    return res
  }

  async function removeObjects(paths: string[]) {
    if (!paths.length) return
    const res = await fetch(`${url}/storage/v1/object/${bucket}`, {
      method: 'DELETE',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: paths }),
    })
    if (!res.ok) throw await failure('storage delete', res)
  }

  return {
    kind: 'supabase',

    async saveAttachment(id, file) {
      const path = `${id}${file.type === 'image/png' ? '.png' : '.jpg'}`
      const res = await fetch(`${url}/storage/v1/object/${bucket}/${path}`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': file.type || 'image/png', 'x-upsert': 'false' },
        body: file,
      })
      if (!res.ok) throw await failure('upload', res)
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
      // Keyset pages on (created_at, id). PostgREST caps each response at max_rows, which
      // may be below SCAN_PAGE, so only an empty page ends the walk.
      const status = filter?.status ? `&status=eq.${filter.status}` : ''
      const all: RedlineItem[] = []
      let after: RedlineItem | undefined
      for (;;) {
        const cursor = after
          ? `&or=(created_at.gt.${encodeURIComponent(after.created_at)},and(created_at.eq.${encodeURIComponent(after.created_at)},id.gt.${after.id}))`
          : ''
        const res = await rest(`items?select=*&order=created_at.asc,id.asc&limit=${SCAN_PAGE}${status}${cursor}`, { profile: 'read' })
        const rows: RedlineItem[] = await res.json()
        if (!rows.length) return all
        all.push(...rows)
        after = rows[rows.length - 1]
      }
    },

    async purge(now = new Date()) {
      let items = 0
      let attachments = 0
      let lastIds = ''
      // Batches until none are left; rows read are deleted, so an empty read means done
      for (;;) {
        const res = await rest(
          `items?select=id,screenshot_path&expires_at=lte.${encodeURIComponent(now.toISOString())}&limit=${SCAN_PAGE}`,
          { profile: 'read' },
        )
        const expired: Pick<RedlineItem, 'id' | 'screenshot_path'>[] = await res.json()
        if (!expired.length) break
        const ids = expired.map((r) => r.id).join(',')
        if (ids === lastIds) throw new Error('[redline] Supabase purge: row delete had no effect')
        lastIds = ids
        const paths = expired.map((r) => r.screenshot_path).filter((p): p is string => !!p)
        // Objects first: if this fails the rows stay, and the next run retries
        await removeObjects(paths)
        await rest(`items?id=in.(${ids})`, { method: 'DELETE', profile: 'write' })
        items += expired.length
        attachments += paths.length
      }
      return { items, attachments }
    },

    async query(q) {
      const limit = Math.min(Math.max(Math.floor(q.limit ?? DEFAULT_PAGE) || DEFAULT_PAGE, 1), MAX_PAGE)
      const filters: string[] = []
      if (q.status) filters.push(`status=eq.${encodeURIComponent(q.status)}`)
      if (q.testerId) filters.push(`tester_id=eq.${encodeURIComponent(q.testerId)}`)
      if (q.appVersion) filters.push(`app_version=eq.${encodeURIComponent(q.appVersion)}`)
      if (q.cursor) {
        const [c, id] = Buffer.from(q.cursor, 'base64url').toString('utf-8').split('|')
        if (!c || !id || !isUuid(id) || /[,()&]/.test(c)) throw new Error('[redline] invalid cursor')
        const ec = encodeURIComponent(c)
        filters.push(`or=(created_at.lt.${ec},and(created_at.eq.${ec},id.lt.${id}))`)
      }
      const res = await rest(
        `items?select=*&order=created_at.desc,id.desc&limit=${limit + 1}${filters.map((f) => `&${f}`).join('')}`,
        { profile: 'read' },
      )
      const rows: RedlineItem[] = await res.json()
      const items = rows.slice(0, limit)
      const last = items[items.length - 1]
      const nextCursor =
        rows.length > limit && last ? Buffer.from(`${last.created_at}|${last.id}`).toString('base64url') : null
      return { items, nextCursor }
    },

    async summary() {
      const res = await rest('rpc/inbox_summary', { method: 'POST', profile: 'write', body: '{}' })
      return res.json()
    },

    async get(id) {
      if (!isUuid(id)) return null
      const res = await rest(`items?select=*&id=eq.${id}&limit=1`, { profile: 'read' })
      return (await res.json())[0] ?? null
    },

    async setStatus(id, status, by, expectedUpdatedAt) {
      if (!isUuid(id)) return { missing: true }
      const res = await rest(`items?id=eq.${id}&status_updated_at=eq.${encodeURIComponent(expectedUpdatedAt)}`, {
        method: 'PATCH',
        profile: 'write',
        body: JSON.stringify({ status, status_updated_by: by }),
        headers: { Prefer: 'return=representation' },
      })
      const rows: RedlineItem[] = await res.json()
      if (rows[0]) return { item: rows[0] }
      const current = await this.get(id)
      return current ? { conflict: current } : { missing: true }
    },

    async screenshotUrl(path, ttlSeconds = 300) {
      const res = await fetch(`${url}/storage/v1/object/sign/${bucket}/${path}`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: ttlSeconds }),
      })
      if (res.status === 400 || res.status === 404) return null
      if (!res.ok) throw await failure('sign', res)
      const { signedURL } = await res.json()
      return `${url}/storage/v1${signedURL}`
    },
  }
}
