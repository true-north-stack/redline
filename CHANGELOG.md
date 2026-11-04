# Changelog

## 1.2.0 (unreleased)

Redline can now collect feedback from testers on a deployed build, not only from your own machine. Local mode is still the default and works as before.

- **Opt-in Supabase storage.** Set `storage: 'supabase'` in `redline.config.ts` and feedback goes into your own Supabase project, in a `feedback` schema and a private screenshot bucket. Writes go through your API route with the secret key, which never reaches the browser. Testers can't read anything back, and every write needs a signed-in tester.
- **PHI masking.** Elements tagged `data-phi`, or matching your `phiSelectors`, become black boxes in screenshots and `[redacted]` in captured text, in the browser before anything is sent. Page URLs keep only the path and query keys. If masking fails, the screenshot and element text are dropped and the form says so.
- **Retention and purge.** Every item is stamped with `expires_at` (30 days by default, `retentionDays` to change it). In Supabase mode a daily `redline-purge` function deletes expired rows and their screenshots. Locally, `node redline/redline.mjs purge` does the same, and every `pull` removes expired items and items the inbox no longer has.
- **Admin inbox.** A page inside your own admin area to triage feedback from a browser or phone: filter by status, tester and version, open an item to see its screenshot and details, then Mark fixed, Defer, Dismiss or Reopen, with a 5 second Undo. Every admin request runs your `isAdmin` check.
- **Owner notification hook.** `onRedlineCreated(summary)` in the feedback route runs after the tester's response is sent. It gets metadata and the item id only, never feedback text or screenshots, so a notification can link to the inbox without carrying patient details.
- **Scoped sync CLI.** `node redline/redline.mjs pull` and `push` bring inbox feedback into `redline/feedback.json` for `/redline` and send status changes back. The CLI talks only to the `redline-sync` edge function with its own secret, so the dev machine never holds the service-role key. `/redline check` pulls first, and `/redline fix` and `/redline defer` push after.

### Upgrading from 1.1.x

- Re-run the install prompt from [AGENT-INSTALLATION.md](AGENT-INSTALLATION.md) in each project. The new inspector imports `redline-config.ts` and `redline-mask.ts`, so copying the inspector on its own breaks the build. The prompt copies the full set, adds `redline/redline.mjs`, and updates your `.gitignore`.
- Local mode keeps working. Projects that haven't re-run the installer yet are treated as local by the `/redline` commands, which suggest the upgrade.
- The feedback route now needs Next.js 15.1 or later, for `after` from `next/server`.
- Supabase mode is opt-in. Nothing changes until you follow the Supabase steps in the README and set `storage: 'supabase'`.
- If a project already runs Supabase mode from a pre-release build, redeploy the `redline-sync` function (`supabase functions deploy redline-sync`) when you upgrade. The new CLI expects its paged listing, and against the old function a `pull` can drop the newest items from `redline/feedback.json`. The rows in Supabase are never touched.
