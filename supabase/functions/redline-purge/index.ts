// Redline retention purge. Called daily by the redline-purge pg_cron job.
// Deletes screenshots of expired feedback through the Storage API, then the rows.
//
// Deploy with JWT verification off (auth is the shared secret below):
//   supabase functions deploy redline-purge --no-verify-jwt
//   supabase secrets set REDLINE_PURGE_SECRET=<same value as the Vault secret>

const BUCKET = Deno.env.get('REDLINE_BUCKET') ?? 'redline-screenshots'
const BATCH = 1000

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

Deno.serve(async (req) => {
  const expected = Deno.env.get('REDLINE_PURGE_SECRET')
  const provided = req.headers.get('x-redline-purge-secret') ?? ''
  if (!expected) return new Response('REDLINE_PURGE_SECRET is not set', { status: 500 })
  if (!sameSecret(provided, expected)) return new Response('Unauthorized', { status: 401 })

  const url = Deno.env.get('SUPABASE_URL')
  const key = secretKey()
  if (!url || !key) return new Response('Missing SUPABASE_URL or secret key', { status: 500 })
  const auth = { apikey: key, Authorization: `Bearer ${key}` }

  let items = 0
  let attachments = 0
  // Loop in batches until nothing expired is left
  for (;;) {
    const now = encodeURIComponent(new Date().toISOString())
    const res = await fetch(`${url}/rest/v1/items?select=id,screenshot_path&expires_at=lte.${now}&limit=${BATCH}`, {
      headers: { ...auth, 'Accept-Profile': 'feedback' },
    })
    if (!res.ok) return new Response(`Read failed: ${res.status} ${await res.text()}`, { status: 502 })
    const expired: { id: string; screenshot_path: string | null }[] = await res.json()
    if (!expired.length) break

    const paths = expired.map((r) => r.screenshot_path).filter((p): p is string => !!p)
    if (paths.length) {
      // Objects first: if this fails the rows stay, and tomorrow's run retries
      const del = await fetch(`${url}/storage/v1/object/${BUCKET}`, {
        method: 'DELETE',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: paths }),
      })
      if (!del.ok) return new Response(`Storage delete failed: ${del.status} ${await del.text()}`, { status: 502 })
    }

    const ids = expired.map((r) => r.id).join(',')
    const rows = await fetch(`${url}/rest/v1/items?id=in.(${ids})`, {
      method: 'DELETE',
      headers: { ...auth, 'Content-Profile': 'feedback' },
    })
    if (!rows.ok) return new Response(`Row delete failed: ${rows.status} ${await rows.text()}`, { status: 502 })

    items += expired.length
    attachments += paths.length
    if (expired.length < BATCH) break
  }

  return Response.json({ items, attachments })
})
