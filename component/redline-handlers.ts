// Server-side handlers for the tester-facing feedback route. Framework-agnostic
// (Web Request/Response); the host's route file wires in config, store and session.

import { randomUUID } from 'crypto'
import type { RedlineConfig } from './redline-config'
import { DEFAULT_RETENTION_DAYS, sanitizePageUrl } from './redline-config'
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

    const id = randomUUID()
    const contentType = req.headers.get('content-type') ?? ''
    let fields: Record<string, unknown>
    let screenshot: File | null = null

    if (contentType.includes('multipart/form-data')) {
      // Multipart form data (with screenshot)
      const formData = await req.formData()
      fields = {
        page_url: formData.get('page_url'),
        element_selector: formData.get('element_selector'),
        element_text: formData.get('element_text') || null,
        feedback: formData.get('feedback'),
        ux_review_requested: formData.get('ux_review_requested') === 'true',
      }
      screenshot = formData.get('screenshot') as File | null
    } else {
      // JSON body (no screenshot)
      const body = await req.json()
      fields = { ...body, ux_review_requested: body.ux_review_requested === true }
    }

    if (typeof fields.feedback !== 'string' || !fields.feedback.trim()) {
      return Response.json({ error: 'feedback is required' }, { status: 400 })
    }

    const now = new Date()
    const retentionDays = config.retentionDays ?? DEFAULT_RETENTION_DAYS

    try {
      const newRedline: RedlineItem = {
        id,
        // Re-sanitized here so query values and tokens never reach storage, even from old clients
        page_url: sanitizePageUrl(String(fields.page_url ?? '')),
        element_selector: String(fields.element_selector ?? ''),
        element_text: (fields.element_text as string | null) || null,
        feedback: fields.feedback,
        screenshot_path: screenshot ? await store.saveAttachment(id, screenshot) : null,
        status: 'open',
        created_at: now.toISOString(),
        ux_review_requested: fields.ux_review_requested === true,
        tester_id: testerId,
        app_version: config.appVersion || null,
        user_agent: req.headers.get('user-agent'),
        expires_at: new Date(now.getTime() + retentionDays * 86_400_000).toISOString(),
      }
      await store.saveItem(newRedline)
      if (onRedlineCreated) {
        const summary = toNotificationSummary(newRedline)
        defer(() => safeNotify(summary))
      }
      return Response.json(newRedline, { status: 201 })
    } catch (err) {
      console.error(err)
      return Response.json({ error: 'Could not save redline' }, { status: 500 })
    }
  }

  return { GET, POST }
}
