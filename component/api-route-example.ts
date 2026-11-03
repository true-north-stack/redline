// Example: app/api/redlines/route.ts (Next.js App Router)
// Saves redlines through the storage adapter chosen in redline.config.ts:
//   local    → redline/feedback.json + redline/screenshots/ in the project root (default)
//   supabase → feedback.items + a private bucket in the host's Supabase project
//
// Adjust these imports to wherever you copied the files.
import redlineConfig from '../redline.config'
import { createRedlineStore, type RedlineItem } from './redline-storage'
import { DEFAULT_RETENTION_DAYS, sanitizePageUrl } from './redline-config'

import { randomUUID } from 'crypto'
import { execSync } from 'child_process'

// Find project root (git root) — important for monorepos where cwd is a subdirectory
function getProjectRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim()
  } catch {
    return process.cwd()
  }
}

const store = createRedlineStore(redlineConfig, getProjectRoot())
const isSupabase = redlineConfig.storage === 'supabase'

/**
 * Who left this redline. Resolve it from your own server-side session; never trust
 * an ID sent by the client. Required in Supabase mode (requests without a tester
 * get a 401), optional locally. Example with @supabase/ssr:
 *
 *   const supabase = await createClient()            // your server client
 *   const { data } = await supabase.auth.getUser()
 *   return data.user?.id ?? null
 */
async function getTesterId(_req: Request): Promise<string | null> {
  return null
}

export async function GET() {
  // Testers never read feedback back in Supabase mode — pull it with `node redline/redline.mjs pull`
  if (isSupabase) return new Response('Not found', { status: 404 })
  const open = await store.list({ status: 'open' })
  return Response.json({ data: open, count: open.length })
}

export async function POST(req: Request) {
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
  const retentionDays = redlineConfig.retentionDays ?? DEFAULT_RETENTION_DAYS

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
      app_version: redlineConfig.appVersion || null,
      user_agent: req.headers.get('user-agent'),
      expires_at: new Date(now.getTime() + retentionDays * 86_400_000).toISOString(),
    }
    await store.saveItem(newRedline)
    return Response.json(newRedline, { status: 201 })
  } catch (err) {
    console.error(err)
    return Response.json({ error: 'Could not save redline' }, { status: 500 })
  }
}
