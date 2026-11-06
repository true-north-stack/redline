# Changelog

## 1.2.1 (2026-11-05)

Fixes from the first host to run 1.2.0 end to end, The Freelancer Tool.

- **Size caps on tester feedback.** The feedback route refuses a note over 5,000 characters, a screenshot over 8 MB or a request over 10 MB with a 413 that names the field. The request size is counted as the body streams, so leaving out Content-Length doesn't get around it. The page URL, selector and element text, which Redline collects rather than the tester, are cut to 2,000, 1,000 and 2,000 characters instead of refused. Text fields that aren't strings get a 400. A new migration, `redline_limits`, enforces the same caps in the table and lowers the screenshot bucket's limit to 8 MB. Rows saved before it that are longer are cut to the caps first, so every row can still change status. The note box stops at 5,000 characters.
- **Clearer save errors.** A refused save now says what to do: shorten the note, untick Include Screenshot, or wait a few minutes after a 429 from the host's rate limit. Only errors that a retry can fix still say "Try again".
- **Element screenshots look like the page.** A heading or paragraph with no background of its own was drawn on Redline's dark fill and pushed down by the browser's default margins, so it came out as a dark strip with its text cut off. Screenshots now use the background the element actually sits on, and the picked element's own margins no longer shift it.
- **The inbox says "No screenshot"** for feedback sent without one. "Screenshot no longer available" is kept for screenshots that expired or failed to load.
- **The components pass current Next.js lint.** `eslint-config-next` 16 adds the React Compiler hook rules, which flagged 14 errors in the copy-in files. All of them are fixed, so hosts can lint the files they vendor.
- **README:** feedback text is untrusted input to the coding agent, return a tester id only for people you've let in, and rate limiting belongs in the host's route.

### Upgrading from 1.2.0

Re-run the install prompt from [AGENT-INSTALLATION.md](AGENT-INSTALLATION.md) to pick up the changed components, then apply the new `redline_limits` migration (renamed with a timestamp after your newest one). If your route wraps Redline's with its own caps, keep them; Redline's are an upper bound.

## 1.2.0 (2026-11-05)

Redline can now collect feedback from testers on a deployed build, not only from your own machine. Local mode is still the default and works as before.

- **Opt-in Supabase storage.** Set `storage: 'supabase'` in `redline.config.ts` and feedback goes into your own Supabase project, in a `feedback` schema and a private screenshot bucket. Writes go through your API route with the secret key, which never reaches the browser. Testers can't read anything back, and every write needs a signed-in tester. The README's setup covers a local stack from `supabase start` as well as a hosted project, and the local steps never write to a hosted one.
- **PHI masking.** Elements tagged `data-phi`, or matching your `phiSelectors`, become black boxes in screenshots and `[redacted]` in captured text, in the browser before anything is sent. Page URLs keep only the path and query keys. If masking fails, the screenshot and element text are dropped and the form says so.
- **Retention and purge.** Every item is stamped with `expires_at` (30 days by default, `retentionDays` to change it). In Supabase mode a daily `redline-purge` function deletes expired rows and their screenshots. Locally, `node redline/redline.mjs purge` does the same, and every `pull` removes expired items and items the inbox no longer has.
- **Admin inbox with a review gate.** A page inside your own admin area to triage feedback from a browser or phone. Every tester submission lands in To Review, and only what you move to To Fix reaches `/redline fix`. Filter by status, tester and version, open an item to see its screenshot and details, then Move to To Fix, Mark fixed, Defer or Dismiss, with a 5 second Undo. Every admin request runs your `isAdmin` check.
- **Owner notification hook.** `onRedlineCreated(summary)` in the feedback route runs after the tester's response is sent. It gets metadata and the item id only, never feedback text or screenshots, so a notification can link to the inbox without carrying patient details.
- **Scoped sync CLI.** `node redline/redline.mjs pull` and `push` bring inbox feedback into `redline/feedback.json` for `/redline` and send status changes back. The CLI talks only to the `redline-sync` edge function with its own secret, so the dev machine never holds the service-role key, and that function never hands over feedback still in To Review. `/redline check` pulls first, and `/redline fix` and `/redline defer` push after.

### Upgrading from 1.1.x

- Re-run the install prompt from [AGENT-INSTALLATION.md](AGENT-INSTALLATION.md) in each project. The new inspector imports `redline-config.ts` and `redline-mask.ts`, so copying the inspector on its own breaks the build. The prompt copies the full set, adds `redline/redline.mjs`, and updates your `.gitignore`.
- Local mode keeps working. Projects that haven't re-run the installer yet are treated as local by the `/redline` commands, which suggest the upgrade.
- The feedback route now needs Next.js 15.1 or later, for `after` from `next/server`.
- Supabase mode is opt-in. Nothing changes until you follow the Supabase steps in the README and set `storage: 'supabase'`.
- If a project already runs Supabase mode from a pre-release build, upgrade in this order: apply the `redline_triage` migration, redeploy `redline-sync` (`supabase functions deploy redline-sync --no-verify-jwt`), then deploy the app. The old function would list feedback still in To Review, and the new CLI expects the new function's paged listing. Rows that existed before the migration count as approved and stay in To Fix, and so do any the old app saves before its replacement is live. To send those back for review, run this once the new app is deployed and before anyone runs `pull`: `update feedback.items set status = 'review' where status = 'open' and status_updated_by is null;`. It selects every item that is in To Fix and whose status nobody has ever changed, including ones you had looked at and left open, so expect to re-approve a few. The rows in Supabase are otherwise untouched.
