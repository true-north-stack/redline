// Server-side handlers for the tester-facing feedback route. Framework-agnostic
// (Web Request/Response); the host's route file wires in config, store and session.

import { randomUUID } from 'crypto'
import type { RedlineConfig } from './redline-config'
import { DEFAULT_RETENTION_DAYS, LIMITS, sanitizePageUrl } from './redline-config'
import type { RedlineItem, RedlineStore } from './redline-storage'

/**
 * The only thing the owner-notification hook ever receives. Feedback is free-typed and
 * may contain patient details, and email has none of the database's access controls,
 * so no feedback text, element text or screenshot is included. Metadata and a link only.
 */
export interface NotificationSummary {
  id: string
  page_url: string
  tester_id: string | null
  app_version: string | null
  created_at: string
  has_screenshot: boolean
  ux_review_requested: boolean
}

export function toNotificationSummary(item: RedlineItem): NotificationSummary {
  return {
    id: item.id,
    page_url: item.page_url,
    tester_id: item.tester_id,
    app_version: item.app_version,
    created_at: item.created_at,
    has_screenshot: item.screenshot_path !== null,
    ux_review_requested: item.ux_review_requested,
  }
}


const tooLarge = (field: string) => Response.json({ error: 'too_large', field }, { status: 413 })

/** The request body, or null once it passes max bytes (the rest is never read). */
async function readCapped(req: Request, max: number): Promise<ArrayBuffer | null> {
  if (!req.body) return new ArrayBuffer(0)
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out.buffer
}

/** Cut to n UTF-16 units without leaving half of a surrogate pair (an emoji) at the end. */
function cut(s: string, n: number): string {
  if (s.length <= n) return s
  const code = s.charCodeAt(n - 1)
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n)
}

/** A file part from multipart form data. Checked by shape: Node 18 has no global File. */
function isFilePart(v: unknown): v is File {
  return typeof v === 'object' && v !== null && typeof (v as Blob).size === 'number' && typeof (v as Blob).arrayBuffer === 'function'
}

export interface FeedbackHandlerOptions {
  config: RedlineConfig
  store: RedlineStore
  getTesterId(req: Request): Promise<string | null>
  onRedlineCreated?(summary: NotificationSummary): Promise<void> | void
  /** Run work after the response is sent. Next routes pass `after` from next/server. */
  defer?(task: () => Promise<void>): void
}

export function createFeedbackHandlers(o: FeedbackHandlerOptions) {
  const { config, store, getTesterId, onRedlineCreated } = o
  const defer = o.defer ?? ((t: () => Promise<void>) => { void t() })
  const isSupabase = store.kind === 'supabase'

  async function safeNotify(summary: NotificationSummary): Promise<void> {
    try {
      await onRedlineCreated?.(summary)
    } catch (err) {
      console.error('[redline] onRedlineCreated failed', err)
    }
  }

  async function GET(): Promise<Response> {
    // Testers never read feedback back in Supabase mode — pull it with `node redline/redline.mjs pull`
    if (isSupabase) return new Response('Not found', { status: 404 })
    const open = await store.list({ status: 'open' })
    return Response.json({ data: open, count: open.length })
  }

  async function POST(req: Request): Promise<Response> {
    const testerId = await getTesterId(req)
    if (isSupabase && !testerId) return new Response('Unauthorized', { status: 401 })

    // A declared size over the cap is refused before reading; a body with no length
    // (chunked) is counted as it streams and refused the moment it passes the cap
    if (Number(req.headers.get('content-length')) > LIMITS.requestBytes) return tooLarge('request')
    const raw = await readCapped(req, LIMITS.requestBytes)
    if (!raw) return tooLarge('request')

    const id = randomUUID()
    const contentType = req.headers.get('content-type') ?? ''
    const body = new Response(raw, { headers: { 'content-type': contentType } })
    let fields: Record<string, unknown>
    let screenshot: unknown = null

    try {
      if (contentType.includes('multipart/form-data')) {
        // Multipart form data (with screenshot)
        const formData = await body.formData()
        fields = {
          page_url: formData.get('page_url'),
          element_selector: formData.get('element_selector'),
          element_text: formData.get('element_text') || null,
          feedback: formData.get('feedback'),
          ux_review_requested: formData.get('ux_review_requested') === 'true',
        }
        screenshot = formData.get('screenshot')
      } else {
        // JSON body (no screenshot)
        const json = await body.json()
        if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('not an object')
        fields = { ...json, ux_review_requested: json.ux_review_requested === true }
      }
    } catch {
      return Response.json({ error: 'invalid body' }, { status: 400 })
    }

    // Text fields are strings or absent: anything else (an object, a file) is refused,
    // so it can never slip past the length caps as "[object Object]"
    for (const field of ['feedback', 'element_text', 'element_selector', 'page_url'] as const) {
      const value = fields[field]
      if (value != null && typeof value !== 'string') {
        return Response.json({ error: 'invalid field', field }, { status: 400 })
      }
    }
    if (screenshot != null && !isFilePart(screenshot)) {
      return Response.json({ error: 'invalid field', field: 'screenshot' }, { status: 400 })
    }

    // A multipart body carries every line break as CRLF, a JSON body as LF. Store LF either
    // way, so the same note reads and counts the same whether or not a screenshot came with it.
    for (const field of ['feedback', 'element_text'] as const) {
      const value = fields[field]
      if (typeof value === 'string') fields[field] = value.replace(/\r\n?/g, '\n')
    }

    if (typeof fields.feedback !== 'string' || !fields.feedback.trim()) {
      return Response.json({ error: 'feedback is required' }, { status: 400 })
    }
    // The tester types the note and chooses the screenshot, so those are refused when
    // too large. The page URL, selector and element text are collected for them, so
    // they are cut to size instead: refusing would leave the tester nothing to fix.
    if (fields.feedback.length > LIMITS.feedback) return tooLarge('feedback')
    if (screenshot && screenshot.size > LIMITS.screenshotBytes) return tooLarge('screenshot')
    const pageUrl = cut(sanitizePageUrl((fields.page_url as string | null) ?? ''), LIMITS.page_url)
    const selector = cut((fields.element_selector as string | null) ?? '', LIMITS.element_selector)
    const rawText = (fields.element_text as string | null) || null
    const elementText = rawText === null ? null : cut(rawText, LIMITS.element_text)

    const now = new Date()
    const retentionDays = config.retentionDays ?? DEFAULT_RETENTION_DAYS

    let saved: RedlineItem
    try {
      const newRedline: RedlineItem = {
        id,
        // Re-sanitized here so query values and tokens never reach storage, even from old clients
        page_url: pageUrl,
        element_selector: selector,
        element_text: elementText,
        feedback: fields.feedback,
        screenshot_path: screenshot ? await store.saveAttachment(id, screenshot) : null,
        // Tester feedback waits in To Review until the owner moves it to To Fix. In local
        // mode the owner is the one leaving it, so it starts in To Fix.
        status: isSupabase ? 'review' : 'open',
        created_at: now.toISOString(),
        ux_review_requested: fields.ux_review_requested === true,
        tester_id: testerId,
        app_version: config.appVersion || null,
        user_agent: cut(req.headers.get('user-agent') ?? '', LIMITS.user_agent) || null,
        expires_at: new Date(now.getTime() + retentionDays * 86_400_000).toISOString(),
      }
      await store.saveItem(newRedline)
      saved = newRedline
    } catch (err) {
      console.error(err)
      return Response.json({ error: 'Could not save redline' }, { status: 500 })
    }

    // Saved. Nothing below may fail the tester's response, or a retry would duplicate it.
    if (onRedlineCreated) {
      const summary = toNotificationSummary(saved)
      try {
        defer(() => safeNotify(summary))
      } catch (err) {
        console.error('[redline] defer failed', err)
      }
    }
    return Response.json(saved, { status: 201 })
  }

  return { GET, POST }
}
