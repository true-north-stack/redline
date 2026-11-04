// Server-side handlers for the admin inbox API. Framework-agnostic (Web Request/Response).
// A host's page layout guard does NOT protect route handlers, so every handler runs the
// admin check itself, on every request. Non-admins and local mode get a plain 404.

import type { RedlineConfig } from './redline-config'
import { STATUSES, isUuid } from './redline-storage'
import type { RedlineItem, RedlineStatus, RedlineStore } from './redline-storage'
import type { AdminConflict, AdminDetail, AdminItem, AdminListResponse } from './redline-admin-types'

export interface AdminHandlerOptions {
  config: RedlineConfig
  store: RedlineStore
  /** Resolve the signed-in admin from the host's server session, or null. Never trust the client. */
  isAdmin(req: Request): Promise<{ id: string } | null>
  /** Optional: map tester ids to display labels (names or emails). Missing ids fall back to the raw id. */
  describeTesters?(ids: string[]): Promise<Record<string, string>>
}

const SCREENSHOT_TTL_SECONDS = 300

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}
const notFound = () => json({ error: 'Not found' }, 404)
const bad = (error: string) => json({ error }, 400)

export function createAdminHandlers(o: AdminHandlerOptions) {
  const { config, store, isAdmin, describeTesters } = o
  const enabled = config.storage === 'supabase' && store.kind === 'supabase'

  /** Admin id, or null when the caller must see a 404 (local mode, or not an admin). */
  async function gate(req: Request): Promise<{ id: string } | null> {
    if (!enabled) return null
    return isAdmin(req)
  }

  async function labels(ids: (string | null)[]): Promise<Record<string, string>> {
    const distinct = [...new Set(ids.filter((i): i is string => !!i))]
    if (!distinct.length || !describeTesters) return {}
    try {
      return await describeTesters(distinct)
    } catch (err) {
      console.error('[redline] describeTesters failed', err)
      return {}
    }
  }

  const label = (map: Record<string, string>, id: string | null) => (id ? map[id] ?? id : null)
  const toAdmin = (i: RedlineItem, map: Record<string, string>): AdminItem => ({ ...i, tester_label: label(map, i.tester_id) })

  async function list(req: Request): Promise<Response> {
    if (!(await gate(req))) return notFound()
    const p = new URL(req.url).searchParams
    const status = p.get('status') || undefined
    const tester = p.get('tester') || undefined
    const version = p.get('version') || undefined
    const cursor = p.get('cursor') || undefined
    const limitRaw = p.get('limit')

    if (status && !STATUSES.includes(status as RedlineStatus)) return bad('invalid status')
    if (tester && !isUuid(tester)) return bad('invalid tester')
    let limit: number | undefined
    if (limitRaw) {
      limit = Number(limitRaw)
      if (!Number.isInteger(limit) || limit < 1) return bad('invalid limit')
    }

    let page, summary
    try {
      ;[page, summary] = await Promise.all([
        store.query({ status: status as RedlineStatus | undefined, testerId: tester, appVersion: version, cursor, limit }),
        store.summary(),
      ])
    } catch (err) {
      if (err instanceof Error && err.message.includes('invalid cursor')) return bad('invalid cursor')
      console.error(err)
      return json({ error: 'Could not load redlines' }, 500)
    }

    const map = await labels([...page.items.map((i) => i.tester_id), ...summary.testers])
    const body: AdminListResponse = {
      items: page.items.map((i) => toAdmin(i, map)),
      nextCursor: page.nextCursor,
      counts: summary.counts,
      testers: summary.testers.map((id) => ({ id, label: label(map, id) as string })),
      versions: summary.versions,
    }
    return json(body)
  }

  async function get(req: Request, id: string): Promise<Response> {
    if (!(await gate(req))) return notFound()
    if (!isUuid(id)) return bad('invalid id')
    try {
      const found = await store.get(id)
      if (!found) return notFound()
      const map = await labels([found.tester_id])
      const url = found.screenshot_path ? await store.screenshotUrl(found.screenshot_path, SCREENSHOT_TTL_SECONDS) : null
      const body: AdminDetail = { ...toAdmin(found, map), screenshot_url: url }
      return json(body)
    } catch (err) {
      console.error(err)
      return json({ error: 'Could not load redline' }, 500)
    }
  }

  async function patch(req: Request, id: string): Promise<Response> {
    const admin = await gate(req)
    if (!admin) return notFound()
    if (!(req.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
      return json({ error: 'Content-Type must be application/json' }, 415)
    }
    if (!isUuid(id)) return bad('invalid id')

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return bad('invalid JSON')
    }
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
    if (typeof b.status !== 'string' || !STATUSES.includes(b.status as RedlineStatus)) return bad('invalid status')
    // Opaque string: compared exactly by the store, never parsed as a date
    if (typeof b.expected_status_updated_at !== 'string' || !b.expected_status_updated_at) {
      return bad('expected_status_updated_at is required')
    }

    try {
      const result = await store.setStatus(id, b.status as RedlineStatus, admin.id, b.expected_status_updated_at)
      if ('missing' in result) return notFound()
      if ('conflict' in result) {
        const map = await labels([result.conflict.tester_id])
        const conflict: AdminConflict = { current: toAdmin(result.conflict, map) }
        return json(conflict, 409)
      }
      const map = await labels([result.item.tester_id])
      return json(toAdmin(result.item, map))
    } catch (err) {
      console.error(err)
      return json({ error: 'Could not update redline' }, 500)
    }
  }

  return { list, get, patch }
}
