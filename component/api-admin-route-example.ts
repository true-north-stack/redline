// Example: app/api/admin/redlines/route.ts (Next.js App Router)
// Admin inbox list API. Supabase mode only; local mode and non-admins get a 404.
// The page layout guard does NOT protect route handlers, so isAdmin runs on every request.
//
// Adjust these imports to wherever you copied the files.
import { execSync } from 'child_process'
import redlineConfig from '../redline.config'
import { createRedlineStore } from './redline-storage'
import { createAdminHandlers } from './redline-admin-handlers'

function getProjectRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim()
  } catch {
    return process.cwd()
  }
}

const store = createRedlineStore(redlineConfig, getProjectRoot())

/**
 * Who may read and triage feedback. Resolve from your own server-side session, and
 * check your own admin flag or role. Return null for everyone else (they get a 404).
 * The stub below denies everyone until you wire it. Example with @supabase/ssr:
 *
 *   const supabase = await createClient()
 *   const { data } = await supabase.auth.getUser()
 *   if (!data.user) return null
 *   const { data: profile } = await supabase.from('profiles').select('is_admin').eq('id', data.user.id).single()
 *   return profile?.is_admin ? { id: data.user.id } : null
 */
async function isAdmin(_req: Request): Promise<{ id: string } | null> {
  return null
}

/**
 * Optional: show names or emails instead of raw tester ids. Called once per response
 * with the distinct tester ids. Example with a service-role client:
 *
 *   async function describeTesters(ids: string[]) {
 *     const { data } = await adminClient.from('profiles').select('id, full_name').in('id', ids)
 *     return Object.fromEntries((data ?? []).map((p) => [p.id, p.full_name]))
 *   }
 */

const handlers = createAdminHandlers({
  config: redlineConfig,
  store,
  isAdmin,
  // describeTesters,
})

export const GET = handlers.list
