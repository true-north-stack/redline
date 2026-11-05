// Redline CLI gateway. The CLI never holds the service-role key: it calls this
// function with a shared secret, and the function holds the key server-side.
// Exactly two actions exist, `list` and `set_status`. There is deliberately no
// delete, no arbitrary query and no access beyond feedback.items and the
// screenshot bucket.
//
// The triage gate lives here: a row is listed, changed or echoed back in a
// conflict only if the owner has approved it (moved it to To Fix in the inbox,
// which stamps approved_at). Feedback still in To Review, or deferred or
// dismissed straight from it, never reaches the dev machine or the coding agent.
//
// Deploy with JWT verification off (auth is the shared secret below):
//   supabase functions deploy redline-sync --no-verify-jwt
//   supabase secrets set REDLINE_SYNC_SECRET=<long random value>
//
// Optional: REDLINE_PUBLIC_URL, the API URL the CLI can reach. Hosted projects
// don't need it. It exists for local `supabase functions serve`, where
// SUPABASE_URL is a container-internal host the CLI cannot resolve.

const BUCKET = Deno.env.get('REDLINE_BUCKET') ?? 'redline-screenshots'
// 'review' is deliberately absent: the CLI can't send anything back to To Review
const STATUSES = ['open', 'fixed', 'dismissed', 'deferred']
const APPROVED = 'approved_at=not.is.null'
const SIGN_TTL_SECONDS = 300
const SYNC_ACTOR = 'redline-cli'
const PAGE = 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function secretKey(): string | undefined {
  // New API keys arrive as a JSON dictionary; fall back to the legacy service_role key
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')
    const first = Object.values(keys)[0]
    if (typeof first === 'string') return first
  } catch {
    // not set or not JSON
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
}

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

const bad = (msg: string) => new Response(msg, { status: 400 })

// Upstream error bodies can quote row data (PostgREST "Failing row contains (...)"), so
// neither the response nor the log carries them: status and PostgREST code only.
async function upstream(what: string, res: Response): Promise<Response> {
  let code = ''
  try {
    const parsed = JSON.parse(await res.text())
    if (parsed && typeof parsed.code === 'string') code = ` ${parsed.code}`
  } catch {
    // not JSON
  }
  const msg = `${what} failed: ${res.status}${code}`
  console.error(`[redline-sync] ${msg}`)
  return new Response(msg, { status: 502 })
}

Deno.serve(async (req) => {
  const expected = Deno.env.get('REDLINE_SYNC_SECRET')
  if (!expected) return new Response('REDLINE_SYNC_SECRET is not set', { status: 500 })
  const provided = req.headers.get('x-redline-sync-secret') ?? ''
  if (!sameSecret(provided, expected)) return new Response('Unauthorized', { status: 401 })
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } })

  const url = Deno.env.get('SUPABASE_URL')
  const key = secretKey()
  if (!url || !key) return new Response('Missing SUPABASE_URL or secret key', { status: 500 })
  const publicUrl = Deno.env.get('REDLINE_PUBLIC_URL') || url
  const auth = { apikey: key, Authorization: `Bearer ${key}` }

  let body: Record<string, unknown>
  try {
    const parsed = await req.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return bad('Body must be a JSON object')
    body = parsed
  } catch {
    return bad('Body must be JSON')
  }

  // Signed URLs for private screenshots, one Storage request per page of rows. A path
  // that is gone, or a batch that fails, gets null: the CLI saves the item without its
  // screenshot and retries the download on the next pull.
  async function signAll(paths: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    if (!paths.length) return out
    try {
      const res = await fetch(`${url}/storage/v1/object/sign/${BUCKET}`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: SIGN_TTL_SECONDS, paths }),
      })
      if (!res.ok) {
        console.error(`[redline-sync] sign failed: ${res.status}`)
        return out
      }
      const signed: { path: string | null; signedURL: string | null; error: string | null }[] = await res.json()
      for (const s of signed) if (s.path && s.signedURL) out.set(s.path, `${publicUrl}/storage/v1${s.signedURL}`)
    } catch {
      console.error('[redline-sync] sign failed')
    }
    return out
  }

  try {
    if (body.action === 'list') {
      // Keyset pages on (created_at, id). PostgREST caps every response at its max_rows,
      // which may be below PAGE, so only an empty page ends the walk: a short page
      // proves nothing.
      const items: Record<string, unknown>[] = []
      let after: { created_at: string; id: string } | null = null
      for (;;) {
        const cursor = after
          ? `&or=(created_at.gt.${encodeURIComponent(after.created_at)},and(created_at.eq.${encodeURIComponent(after.created_at)},id.gt.${after.id}))`
          : ''
        const res = await fetch(`${url}/rest/v1/items?select=*&${APPROVED}&order=created_at.asc,id.asc&limit=${PAGE}${cursor}`, {
          headers: { ...auth, 'Accept-Profile': 'feedback' },
        })
        if (!res.ok) return upstream('Read', res)
        const rows: { id: string; created_at: string; screenshot_path: string | null }[] = await res.json()
        if (!rows.length) break
        const urls = await signAll(rows.map((r) => r.screenshot_path).filter((p): p is string => !!p))
        for (const r of rows) items.push({ ...r, screenshot_url: r.screenshot_path ? urls.get(r.screenshot_path) ?? null : null })
        const last = rows[rows.length - 1]
        after = { created_at: last.created_at, id: last.id }
      }
      return Response.json({ items })
    }

    if (body.action === 'set_status') {
      const { id, status, expected_status_updated_at: expectedAt } = body
      if (typeof id !== 'string' || !UUID.test(id)) return bad('id must be a UUID')
      if (typeof status !== 'string' || !STATUSES.includes(status)) return bad(`status must be one of ${STATUSES.join(', ')}`)
      if (typeof expectedAt !== 'string' || !expectedAt) return bad('expected_status_updated_at is required')

      // Conditional on the timestamp the caller last saw; the DB trigger restamps it
      const res = await fetch(`${url}/rest/v1/items?id=eq.${id}&${APPROVED}&status_updated_at=eq.${encodeURIComponent(expectedAt)}`, {
        method: 'PATCH',
        headers: {
          ...auth,
          'Content-Profile': 'feedback',
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({ status, status_updated_by: SYNC_ACTOR }),
      })
      if (!res.ok) return upstream('Update', res)
      const rows = await res.json()
      if (rows[0]) return Response.json({ item: rows[0] })

      // Zero rows: tell a stale timestamp from a missing row. An item the owner
      // hasn't approved counts as missing, so its text never leaves through a conflict either.
      const cur = await fetch(`${url}/rest/v1/items?select=*&id=eq.${id}&${APPROVED}&limit=1`, {
        headers: { ...auth, 'Accept-Profile': 'feedback' },
      })
      if (!cur.ok) return upstream('Read', cur)
      const current = (await cur.json())[0]
      return current ? Response.json({ conflict: current }, { status: 409 }) : Response.json({ missing: true }, { status: 404 })
    }
  } catch {
    return new Response('Upstream error', { status: 502 })
  }

  return bad('Unknown action')
})
