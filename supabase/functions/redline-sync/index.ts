// Redline CLI gateway. The CLI never holds the service-role key: it calls this
// function with a shared secret, and the function holds the key server-side.
// Exactly two actions exist, `list` and `set_status`. There is deliberately no
// delete, no arbitrary query and no access beyond feedback.items and the
// screenshot bucket.
//
// Deploy with JWT verification off (auth is the shared secret below):
//   supabase functions deploy redline-sync --no-verify-jwt
//   supabase secrets set REDLINE_SYNC_SECRET=<long random value>
//
// Optional: REDLINE_PUBLIC_URL, the API URL the CLI can reach. Hosted projects
// don't need it. It exists for local `supabase functions serve`, where
// SUPABASE_URL is a container-internal host the CLI cannot resolve.

const BUCKET = Deno.env.get('REDLINE_BUCKET') ?? 'redline-screenshots'
const STATUSES = ['open', 'fixed', 'dismissed', 'deferred']
const SIGN_TTL_SECONDS = 300
const SYNC_ACTOR = 'redline-cli'
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

Deno.serve(async (req) => {
  const expected = Deno.env.get('REDLINE_SYNC_SECRET')
  if (!expected) return new Response('REDLINE_SYNC_SECRET is not set', { status: 500 })
  const provided = req.headers.get('x-redline-sync-secret') ?? ''
  if (!sameSecret(provided, expected)) return new Response('Unauthorized', { status: 401 })
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } })

  const url = Deno.env.get('SUPABASE_URL')
  const key = secretKey()
  if (!url || !key) return new Response('Missing SUPABASE_URL or secret key', { status: 500 })
  const publicUrl = Deno.env.get('REDLINE_PUBLIC_URL') ?? url
  const auth = { apikey: key, Authorization: `Bearer ${key}` }

  let body: Record<string, unknown>
  try {
    const parsed = await req.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return bad('Body must be a JSON object')
    body = parsed
  } catch {
    return bad('Body must be JSON')
  }

  // Signed URL for a private screenshot; null when the object is gone
  async function sign(path: string): Promise<string | null> {
    const res = await fetch(`${url}/storage/v1/object/sign/${BUCKET}/${path}`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: SIGN_TTL_SECONDS }),
    })
    if (res.status === 400 || res.status === 404) return null
    if (!res.ok) throw new Error(`Sign failed: ${res.status} ${await res.text()}`)
    const { signedURL } = await res.json()
    return `${publicUrl}/storage/v1${signedURL}`
  }

  try {
    if (body.action === 'list') {
      const res = await fetch(`${url}/rest/v1/items?select=*&order=created_at.asc`, {
        headers: { ...auth, 'Accept-Profile': 'feedback' },
      })
      if (!res.ok) return new Response(`Read failed: ${res.status} ${await res.text()}`, { status: 502 })
      const rows: { screenshot_path: string | null }[] = await res.json()
      const items = await Promise.all(
        rows.map(async (r) => ({ ...r, screenshot_url: r.screenshot_path ? await sign(r.screenshot_path) : null })),
      )
      return Response.json({ items })
    }

    if (body.action === 'set_status') {
      const { id, status, expected_status_updated_at: expectedAt } = body
      if (typeof id !== 'string' || !UUID.test(id)) return bad('id must be a UUID')
      if (typeof status !== 'string' || !STATUSES.includes(status)) return bad(`status must be one of ${STATUSES.join(', ')}`)
      if (typeof expectedAt !== 'string' || !expectedAt) return bad('expected_status_updated_at is required')

      // Conditional on the timestamp the caller last saw; the DB trigger restamps it
      const res = await fetch(`${url}/rest/v1/items?id=eq.${id}&status_updated_at=eq.${encodeURIComponent(expectedAt)}`, {
        method: 'PATCH',
        headers: {
          ...auth,
          'Content-Profile': 'feedback',
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({ status, status_updated_by: SYNC_ACTOR }),
      })
      if (!res.ok) return new Response(`Update failed: ${res.status} ${await res.text()}`, { status: 502 })
      const rows = await res.json()
      if (rows[0]) return Response.json({ item: rows[0] })

      // Zero rows: tell a stale timestamp from a missing row
      const cur = await fetch(`${url}/rest/v1/items?select=*&id=eq.${id}&limit=1`, {
        headers: { ...auth, 'Accept-Profile': 'feedback' },
      })
      if (!cur.ok) return new Response(`Read failed: ${cur.status} ${await cur.text()}`, { status: 502 })
      const current = (await cur.json())[0]
      return current ? Response.json({ conflict: current }, { status: 409 }) : Response.json({ missing: true }, { status: 404 })
    }
  } catch (e) {
    return new Response(e instanceof Error ? e.message : 'Upstream error', { status: 502 })
  }

  return bad('Unknown action')
})
