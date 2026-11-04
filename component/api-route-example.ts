// Example: app/api/redlines/route.ts (Next.js App Router)
// Saves redlines through the storage adapter chosen in redline.config.ts:
//   local    → redline/feedback.json + redline/screenshots/ in the project root (default)
//   supabase → feedback.items + a private bucket in the host's Supabase project
//
// Adjust these imports to wherever you copied the files.
import { after } from 'next/server'
import { execSync } from 'child_process'
import redlineConfig from '../redline.config'
import { createRedlineStore } from './redline-storage'
import { createFeedbackHandlers } from './redline-handlers'

// Find project root (git root) — important for monorepos where cwd is a subdirectory
function getProjectRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim()
  } catch {
    return process.cwd()
  }
}

const store = createRedlineStore(redlineConfig, getProjectRoot())

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

/**
 * Optional owner notification. Runs after the response is sent; a failure is logged
 * and never affects the tester. It receives metadata only (NotificationSummary):
 * never the feedback text, element text or screenshot, because feedback may contain
 * patient details and email lacks the database's access controls. Link to your
 * admin inbox instead. Example:
 *
 *   async function onRedlineCreated(s: NotificationSummary) {
 *     await sendEmail({
 *       to: 'owner@example.com',
 *       subject: `New redline on ${s.page_url}`,
 *       text: `Open the inbox: https://app.example.com/admin/redline?id=${s.id}`,
 *     })
 *   }
 */

export const { GET, POST } = createFeedbackHandlers({
  config: redlineConfig,
  store,
  getTesterId,
  // onRedlineCreated,
  defer: after,
})
