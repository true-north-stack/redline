# Redline

**Your UX Feedback Loop Champion**

![Redline in action](assets/redline-screenshot.png)

In-app dev feedback for AI-assisted development. A JSON file by default; your own Supabase project when testers are remote.

## How It Works

1. **Triple-tap a shortcut** → select element or drag an area → type feedback → submit
2. **`/redline fix`** → Claude reads feedback + screenshots, finds the code, fixes it
3. Ship it

Leave as many redlines as you want. Fix them all at once.

## Keyboard Shortcuts

| Shortcut | Mode | Notes |
|----------|------|-------|
| `rrr` | Element select | Right hand |
| `uuu` | Element select | Left hand |
| `eee` | Area screenshot | Launches directly into area capture |
| `s` | Toggle mode | Switch between element/area while inspector is open |
| `Esc` | Cancel/exit | Cancel selection, close modal, or deactivate inspector |
| `Cmd+Enter` | Submit | Submit feedback from the modal |

All triple-tap shortcuts work the same way — tap three times within 500ms. They won't trigger while typing in inputs or textareas.

## Two Capture Modes

### Element Mode (default)

Hover over any element to highlight it. Click to select. A feedback modal opens with the CSS selector and element text pre-filled.

- Generates semantic selectors (`data-testid` > `id` > CSS path)
- Screenshot captured silently on selection — opt-in to include on submit
- Best for targeting specific components for code-level fixes

### Area Screenshot Mode

Click and drag to capture any rectangular region of the page. A red overlay highlights your selection area with live pixel dimensions as you drag. On release, the screenshot is captured and the feedback modal opens with a preview.

- Viewport captured via `modern-screenshot`, cropped to your selection
- Screenshot auto-included (the whole point of area mode)
- Best for layout issues, spacing problems, or multi-element feedback
- Drag in any direction — the selection normalizes automatically
- Tiny drags (< 20px) are ignored to prevent accidental captures

A mode indicator pill at the top of the screen shows which mode is active. Press **`s`** to toggle between modes while the inspector is open.

## Features

- **Element screenshots** — opt-in on submit, captured via `modern-screenshot` (supports Tailwind v4, `oklab()`, modern CSS)
- **Area screenshots** — drag to capture any region of the page with live dimension overlay
- **Screenshot preview** — area captures show a preview in the feedback modal before submit
- **Request UX Audit** — opt-in 55-point audit including the Steve Jobs Pitch
- **Flat file by default** — `redline/feedback.json`. Opt into Supabase for remote testers
- **PHI masking** — `[data-phi]` and your own selectors are blacked out before anything leaves the browser
- **Retention** — feedback and screenshots expire after 30 days (configurable)
- **Batch fix** — 10 redlines? One command
- **`initialMode` prop** — launch the inspector directly into area mode programmatically

## The Steve Jobs Pitch

> We're walking into a room to pitch this to Steve Jobs. Will he invest — or will he fire us on the spot?

Is it pitch ready? Will SJ fire us? What questions will he ask? What gaps will he discover? Does it excite him? Does everything work E2E?

## Commands

| Command | What it does |
|---------|-------------|
| `/redline check` | See open feedback |
| `/redline fix` | Fix all open redlines |
| `/redline fix <uuid>` | Fix a specific one |
| `/redline clear` | Clear all feedback |
| `/redline defer <n>` | Defer / list / undo |
| `/redline ux-review` | Standalone UX audit |

## Component API

```tsx
<RedlineInspector
  active={boolean}           // Whether the inspector is active
  onDeactivate={() => void}  // Called when the inspector should close
  apiUrl="/api/redlines"     // API endpoint for submitting feedback (default: /api/redlines)
  initialMode="element"      // Starting mode: 'element' or 'area' (default: element)
  phiSelectors={redlineConfig.phiSelectors} // Extra selectors to mask, on top of [data-phi]
/>
```

## Config

One file in the project root, `redline.config.ts`, read by the API route and the inspector:

```ts
import { defineRedlineConfig } from './components/redline-config'

export default defineRedlineConfig({
  storage: 'local',                 // 'local' (default) or 'supabase'
  supabase: {                       // Supabase mode only. Server-only env vars, never NEXT_PUBLIC_*
    url: process.env.SUPABASE_URL,
    secretKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    bucket: 'redline-screenshots',
  },
  phiSelectors: ['.client-name'],   // masked in addition to [data-phi]
  retentionDays: 30,                // feedback + screenshots expire after this
  appVersion: process.env.NEXT_PUBLIC_APP_VERSION,
})
```

Every redline saves `page_url`, `element_selector`, `element_text`, `feedback`, `screenshot_path`, `status`, `created_at`, plus `tester_id`, `app_version`, `user_agent` (browser and OS), `ux_review_requested` and `expires_at`.

## PHI Masking

Before a screenshot or element text is captured, every element matching `[data-phi]` or one of `phiSelectors` is replaced. Screenshots get a solid black box of the same size, and captured text gets `[redacted]`. This happens in the browser, so unmasked content never reaches the network or disk. If masking fails for any reason (a bad selector, say), the screenshot and element text are dropped instead of being sent.

```tsx
<span data-phi>{client.name}</span>
```

- Page URLs keep the path and query keys only: `/clients?q=Jane` is saved as `/clients?q=…`, and token fragments such as `#access_token=…` are dropped. The server re-sanitizes too.
- Masking only covers elements you tag. Tag anything that can show patient or personal data before testers see it.
- The feedback text is whatever the tester types. The modal reminds them not to type patient details, but Redline can't mask it.
- Masking reaches into open shadow roots and same-origin iframes, nested ones included. Closed shadow roots and cross-origin iframes aren't rendered in screenshots at all.
- Selectors with combinators (`.card .name`, `:host`) can't be evaluated across those boundaries, so on a page with shadow or iframe content they drop the screenshot instead of guessing. Tag the element itself (`data-phi`, or a plain class) to keep screenshots.

## Storage

### Local (default)

`redline/feedback.json` plus `redline/screenshots/`, written by your API route. Local storage never runs a purge on its own (in remote mode, `pull` does); to enforce retention, run:

```bash
node redline/redline.mjs purge            # delete items past their expires_at, plus screenshots
node redline/redline.mjs purge --days 7   # or anything older than 7 days
```

Keep local mode out of deployed environments: it writes to the server's filesystem without authentication.

### Supabase (opt-in)

For testers on a deployed build. Feedback goes into the host's own Supabase project, in a dedicated `feedback` schema and a private `redline-screenshots` bucket.

- **Writes go through your API route on the server**, using the secret key. The key never reaches the browser.
- **Testers can't read anything back.** `anon` and `authenticated` get no grants, RLS is on with no policies, and the bucket has no storage policies. `GET /api/redlines` returns 404 in this mode.
- **Every write needs a tester.** Implement `getTesterId()` in the route from your own server-side session. Requests without one get a 401.

Setup:

1. Copy `supabase/migrations/*.sql` (three files) into your migrations (rename them with your own timestamps) and apply them. The third one, `redline_inbox`, adds `status_updated_at`, `status_updated_by` and the index the admin inbox uses.
2. Add `feedback` to the exposed schemas: Dashboard → Data API settings, or `schemas = [..., "feedback"]` under `[api]` in `config.toml`.
3. Deploy the purge function: copy `supabase/functions/redline-purge/`, then `supabase functions deploy redline-purge --no-verify-jwt`.
4. Pick a long random string and set it in both places:
   ```bash
   supabase secrets set REDLINE_PURGE_SECRET=<secret>
   ```
   ```sql
   select vault.create_secret('https://<project-ref>.supabase.co', 'redline_purge_base_url');
   select vault.create_secret('<secret>', 'redline_purge_secret');
   ```
5. Deploy the sync function the CLI uses: copy `supabase/functions/redline-sync/`, then `supabase functions deploy redline-sync --no-verify-jwt`. Give it its own secret, separate from the purge secret:
   ```bash
   supabase secrets set REDLINE_SYNC_SECRET=<secret>
   ```
   When you serve functions locally, `SUPABASE_URL` inside the function is container-internal, so also set `REDLINE_PUBLIC_URL` to the API URL your machine can reach. Hosted projects don't need it.
6. On each machine that runs `/redline` against remote feedback, create `.env.redline` in the project root (gitignored) with the project that holds tester feedback:
   ```
   REDLINE_REMOTE_URL=https://<project-ref>.supabase.co
   REDLINE_SYNC_SECRET=<the secret from step 5>
   ```
7. Set `storage: 'supabase'` in `redline.config.ts`.

The migration schedules `redline-purge` daily at 03:17 UTC with pg_cron. It deletes expired screenshots through the Storage API, then the rows. Deleting from `storage.objects` in SQL would leave the files behind. Retention is stamped on each item as `expires_at` when it's saved, so changing `retentionDays` affects new feedback only.

### Working through remote feedback with Claude

```bash
node redline/redline.mjs mode   # prints `local`, or `remote <host>` when .env.redline exists
node redline/redline.mjs pull   # bring the inbox into redline/feedback.json
node redline/redline.mjs push   # send local status changes back to the inbox
```

`/redline check` pulls first, and `/redline fix` and `/redline defer` push afterwards, so `/redline` and the inbox show one status. `/redline clear` empties only the local file, never the remote rows.

The dev machine never holds the service-role key. The CLI talks only to the `redline-sync` function with the sync secret, and that function can list feedback and change status, nothing else. `REDLINE_REMOTE_URL` and `REDLINE_SYNC_SECRET` come from the environment or `.env.redline`, kept apart from your app's own `SUPABASE_URL` because a dev env usually points at a local stack while tester feedback lives in a deployed project. Every `pull` and `push` prints the host it's talking to.

Sync rules: `pull` takes the remote copy unless you changed the status locally and the remote hasn't moved, in which case your change waits for `push`. If both changed, the inbox wins, and `pull` lists each local change it discarded by id and page. `push` is a conditional update, so if the inbox changed in the meantime it does nothing for that item and tells you to run `pull`. Items created locally are never pushed.

Retention reaches the dev machine too. Every `pull` deletes local items whose `expires_at` has passed and pulled items the inbox no longer has (purged or deleted there), along with their screenshots, and prints one line saying how many it removed. If one of them had a local status change you hadn't pushed, that line names it.

## Admin inbox

An inbox for the person running the alpha, inside your own admin area. It reads and triages Supabase-mode feedback from a browser or phone: filter by status, tester and version, open an item to see the feedback, screenshot, page, tester, app version and time, then Mark fixed, Defer, Dismiss or Reopen. A status change is optimistic with a 5 second Undo, and a stale change (someone else got there first) shows "Changed elsewhere" and reloads the item. It is not available in local mode, where the admin API returns 404.

Three pieces, all copied into your project:

- `component/api-admin-route-example.ts` as `app/api/admin/redlines/route.ts` (GET, the list)
- `component/api-admin-item-route-example.ts` as `app/api/admin/redlines/[id]/route.ts` (GET and PATCH, one item)
- A page in your admin layout that renders the inbox:

```tsx
import { RedlineAdminInbox } from '@/components/redline-admin-inbox'

export default function Page() {
  return <RedlineAdminInbox />   // apiUrl defaults to /api/admin/redlines
}
```

State lives in the URL (`?status=open&id=<uuid>`) through the History API, so a notification link opens the item directly and the browser's Back button works. At 1024px and up it is a list with a detail pane; below that, the detail opens full-width with a Back control.

Hooks you implement in the route files:

| Hook | Where | What it must return |
|---|---|---|
| `isAdmin(req)` | both admin route files | `{ id: string }` for an admin, `null` for everyone else. Runs on every request, because your layout guard does not cover route handlers. A `null` gets a 404, not a 403, so the endpoint doesn't reveal itself. The stub denies everyone until you wire it. |
| `describeTesters(ids)` | both admin route files, optional | `Record<string, string>` mapping tester ids to display labels (a name or email). Without it the inbox shows the raw id. |
| `onRedlineCreated(summary)` | `app/api/redlines/route.ts`, optional | Nothing. It runs after the tester's response is sent, and if it throws, the error is logged and the tester still gets their 201. |

Notification content rule: `onRedlineCreated` receives the page path, tester id, app version, time, whether a screenshot is attached, the UX-review flag and the item id. It never receives feedback text, element text or screenshots, because feedback is free-typed and may contain patient details, and email lacks the database's access controls. Send the owner a link such as `/admin/redline?id=<id>` and let them read the content in the inbox, behind the admin check.

Every admin response is sent with `Cache-Control: no-store`. PATCH needs `Content-Type: application/json`, a valid status (`open`, `fixed`, `dismissed`, `deferred`) and a UUID id. Screenshot URLs are signed for 5 minutes, made when an item is opened, and never stored.

## Development

```bash
pnpm install
pnpm test:stack  # start an isolated Supabase stack on 553xx ports in .redline-stack/ (needs Docker and the Supabase CLI)
pnpm test:all    # the full Playwright suite against that stack, nothing skipped; extra args pass through
pnpm test        # Playwright without the stack: Supabase specs skip
pnpm typecheck
```

`pnpm test:stack` writes `.redline-stack/test.env`, and `pnpm test:all` loads it, so the Supabase, admin, sync function and CLI tests all run. Plain `pnpm test` skips the specs that need a live stack. The stack uses its own ports and never touches another project's local Supabase.

## Install

See **[AGENT-INSTALLATION.md](AGENT-INSTALLATION.md)** — paste the prompt into Claude Code and it handles everything.

MIT License
