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

All triple-tap shortcuts work the same way: tap three times within 500ms. They won't trigger while typing in inputs or textareas, or with a modifier key held, and they stand down while a Redline dialog is open. `Ctrl+Enter` submits as well as `Cmd+Enter`.

The listener ships with Redline as a hook. Call it where the inspector's on/off state lives:

```tsx
import { useRedlineShortcuts } from '@/components/redline-shortcuts'

useRedlineShortcuts((mode) => { setMode(mode); setActive(true) })  // mode is 'element' or 'area'
// Pass { enabled: false } as a second argument to switch it off
```

If your app already has its own listener, keep it and pass `shortcuts={false}` to the inspector when its keys differ from r, u and e.

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

## On phones

Redline works with a finger. With the inspector on, there is no hover, so a tap stages a pick instead of selecting it. The bar at the bottom shows the picked element's name:

- **Smaller** and **Bigger** move the pick to a smaller or larger element around the tap.
- **Comment** opens the feedback box for the pick. **Cancel** drops it.
- **Area** lets you draw a box with your finger. Drag its corner handles to adjust, then tap Comment.
- **Done** turns Redline off.
- The dock button moves the bar to the top of the screen, so you can pick the app's own bottom navigation.

Tapping a link while the inspector is on stages the link instead of following it. A mouse on a touchscreen laptop still gets the desktop pill and hover outline.

## First-run introduction

The first time someone turns Redline on in a browser, a short introduction explains how to pick something and what happens next. Tick "Don't show this again" and it stays away; the choice lives in `localStorage` under `redline:intro:v1`, and if storage is blocked it shows again next time. Click or tap the `?` button on the pill or the touch bar to reopen it.

## Features

- **Element screenshots** — opt-in on submit, captured via `modern-screenshot` (supports Tailwind v4, `oklab()`, modern CSS)
- **Area screenshots** — drag to capture any region of the page with live dimension overlay
- **Screenshot preview** — area captures show a preview in the feedback modal before submit
- **Request UX Audit** — opt-in 55-point audit including the Steve Jobs Pitch
- **Flat file by default** — `redline/feedback.json`. Opt into Supabase for remote testers
- **PHI masking** — `[data-phi]`, email and phone fields, text areas, editable text, mailto/tel links and your own selectors are blacked out before anything leaves the browser
- **Retention** — feedback and screenshots expire after 30 days (configurable)
- **Batch fix** — 10 redlines? One command
- **`initialMode` prop** — launch the inspector directly into area mode programmatically

## The Steve Jobs Pitch

> We're walking into a room to pitch this to Steve Jobs. Will he invest — or will he fire us on the spot?

Is it pitch ready? Will SJ fire us? What questions will he ask? What gaps will he discover? Does it excite him? Does everything work E2E?

## Commands

| Command | What it does |
|---------|-------------|
| `/redline check` | See feedback waiting to be fixed |
| `/redline fix` | Fix every redline in To Fix |
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
  phiSelectors={redlineConfig.phiSelectors} // Extra selectors to mask, on top of [data-phi] and the defaults
  maskDefaults={redlineConfig.maskDefaults} // Mask email/phone fields, text areas, editable text and mailto/tel links (default true)
  audience="developer"       // 'tester' or 'developer' (default developer). Testers get plain wording: no selector, no UX review, screenshot on by default
  shortcuts={true}           // Whether the introduction mentions the r/u/e keys (default true). Pass false if your own listener uses other keys
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
  phiSelectors: ['.client-name'],   // masked in addition to [data-phi] and the defaults
  maskDefaults: true,               // email/phone fields, text areas, editable text, mailto/tel links (default true)
  retentionDays: 30,                // feedback + screenshots expire after this
  appVersion: process.env.NEXT_PUBLIC_APP_VERSION,
})
```

Every redline saves `page_url`, `element_selector`, `element_text`, `feedback`, `screenshot_path`, `status`, `created_at`, plus `tester_id`, `app_version`, `user_agent` (browser and OS), `ux_review_requested` and `expires_at`.

## PHI Masking

Before a screenshot or element text is captured, every element matching `[data-phi]`, one of the defaults below, or one of `phiSelectors` is replaced. Screenshots get a solid black box of the same size, and captured text gets `[redacted]`. This happens in the browser, so unmasked content never reaches the network or disk. If masking fails for any reason (a bad selector, say), the screenshot and element text are dropped instead of being sent.

```tsx
<span data-phi>{client.name}</span>
```

- Page URLs keep the path and query keys only: `/clients?q=Jane` is saved as `/clients?q=…`, and token fragments such as `#access_token=…` are dropped. The server re-sanitizes too.
- Without any tagging, Redline masks the places that hold personal data on almost every app: `input[type="email"]`, `input[type="tel"]`, `textarea`, editable text (`[contenteditable]`), and `mailto:` and `tel:` links. Set `maskDefaults: false` only if nothing in those places is private. Redline's own feedback box is never captured, so it isn't affected.
- Beyond those, masking only covers elements you tag. Tag anything else that can show patient or personal data before testers see it, such as names in headings, toasts or table cells (`phiSelectors: ['[data-sonner-toast]']` covers Sonner toasts, for instance).
- The feedback text is whatever the tester types. The modal reminds them not to type patient details, but Redline can't mask it.
- Masking reaches into open shadow roots and same-origin iframes, nested ones included. Closed shadow roots and cross-origin iframes aren't rendered in screenshots at all.
- Selectors with combinators (`.card .name`, `:host`) can't be evaluated across those boundaries, so on a page with shadow or iframe content they drop the screenshot instead of guessing. Tag the element itself (`data-phi`, or a plain class) to keep screenshots.

## Storage

### Local (default)

`redline/feedback.json` plus `redline/screenshots/`, written by your API route. Local storage never runs a purge on its own, and `pull` never removes an item created on this machine. To enforce retention, run:

```bash
node redline/redline.mjs purge            # delete items past their expires_at, plus screenshots
node redline/redline.mjs purge --days 7   # or anything older than 7 days, dated or not
```

Keep local mode out of deployed environments: it writes to the server's filesystem without authentication.

### Supabase (opt-in)

For testers on a deployed build. Feedback goes into the host's own Supabase project, in a dedicated `feedback` schema and a private `redline-screenshots` bucket.

- **Writes go through your API route on the server**, using the secret key. The key never reaches the browser.
- **Testers can't read anything back.** `anon` and `authenticated` get no grants, RLS is on with no policies, and the bucket has no storage policies. `GET /api/redlines` returns 404 in this mode.
- **Every write needs a tester.** Implement `getTesterId()` in the route from your own server-side session. Requests without one get a 401. Return an id only for people you've let in as testers, not for every signed-in user.
- **Every field has a size cap.** The note is refused over 5,000 characters, the screenshot over 8 MB and the whole request over 10 MB (counted as it streams, so a request without a length can't get around it), each with a 413 and `{ "error": "too_large", "field": "<name>" }`. The feedback box then tells the tester to shorten the note or untick the screenshot. The fields Redline collects itself are cut to size instead: page URL 2,000 characters, selector 1,000, element text 2,000, user agent 512. Text fields that aren't strings get a 400. The database enforces the same caps.
- **Rate limiting is yours.** Redline keeps no shared state between server instances, so it can't count requests reliably. Limit notes per tester in your route or platform, and answer with a 429. The feedback box then tells the tester to wait a few minutes.

Setup has two parts. The first is the same everywhere. The second depends on where the database runs: a local stack from `supabase start`, or a hosted Supabase project. Do the local version while you develop and the hosted one when testers arrive. They don't share anything, so doing one never touches the other.

**Everywhere:**

1. Copy `supabase/migrations/*.sql` (five files) into your migrations (rename them with your own timestamps, keeping their order, since each builds on the one before). The third one, `redline_inbox`, adds `status_updated_at`, `status_updated_by` and the index the admin inbox uses. The fourth, `redline_triage`, adds the To Review status that every tester submission starts in. The fifth, `redline_limits`, adds the size caps.
2. Add `feedback` to the exposed schemas: `schemas = [..., "feedback"]` under `[api]` in `supabase/config.toml` for a local stack, or Dashboard → Data API settings for a hosted project.
3. Copy `supabase/functions/redline-purge/` and `supabase/functions/redline-sync/` into your `supabase/functions/`.
4. Pick two long random strings (`openssl rand -hex 24` works), one for the purge function and one for the sync function. Keep them apart, since the sync secret goes on every dev machine and the purge secret never needs to.
5. Set `storage: 'supabase'` in `redline.config.ts` once the steps for your database are done.

**On a local stack** (nothing here reaches a hosted project):

1. Apply the migrations the way you apply any other: `supabase migration up`, or `supabase db reset`.
2. Put the function secrets in a gitignored env file, for example `supabase/functions/.env.redline`:
   ```
   REDLINE_PURGE_SECRET=<purge secret>
   REDLINE_SYNC_SECRET=<sync secret>
   REDLINE_PUBLIC_URL=http://127.0.0.1:54321
   ```
   `REDLINE_PUBLIC_URL` is the API URL from `supabase status`. Inside a locally served function, `SUPABASE_URL` points at a container your machine can't reach, so screenshot links need this one.
3. Serve the functions and leave it running while you work: `supabase functions serve --no-verify-jwt --env-file supabase/functions/.env.redline`. Without it, `pull`, `push` and the purge have nothing to talk to.
4. Give the daily purge its address and secret, in the SQL editor of Studio or `psql`:
   ```sql
   select vault.create_secret('http://kong:8000', 'redline_purge_base_url');
   select vault.create_secret('<purge secret>', 'redline_purge_secret');
   ```
   The purge runs inside the database container, where `127.0.0.1` is the container itself, so it reaches the functions through the stack's internal gateway at `http://kong:8000`, whatever ports your stack uses. These two secrets aren't part of a migration, so `supabase db reset` deletes them. Run this again after every reset, or the purge stops without an error.
5. Create `.env.redline` in the project root (gitignored), pointing the CLI at the local stack:
   ```
   REDLINE_REMOTE_URL=http://127.0.0.1:54321
   REDLINE_SYNC_SECRET=<sync secret>
   ```

**On a hosted project:**

1. Apply the migrations with `supabase db push`, or however you ship migrations to that project.
2. Deploy both functions and set their secrets:
   ```bash
   supabase functions deploy redline-purge --no-verify-jwt
   supabase functions deploy redline-sync --no-verify-jwt
   supabase secrets set REDLINE_PURGE_SECRET=<purge secret> REDLINE_SYNC_SECRET=<sync secret>
   ```
   Hosted functions see the right `SUPABASE_URL`, so `REDLINE_PUBLIC_URL` isn't needed.
3. Give the daily purge its address and secret, in the project's SQL editor:
   ```sql
   select vault.create_secret('https://<project-ref>.supabase.co', 'redline_purge_base_url');
   select vault.create_secret('<purge secret>', 'redline_purge_secret');
   ```
4. On each machine that runs `/redline` against tester feedback, create `.env.redline` in the project root (gitignored):
   ```
   REDLINE_REMOTE_URL=https://<project-ref>.supabase.co
   REDLINE_SYNC_SECRET=<sync secret>
   ```

The migration schedules `redline-purge` daily at 03:17 UTC with pg_cron. It deletes expired screenshots through the Storage API, then the rows. Deleting from `storage.objects` in SQL would leave the files behind. Retention is stamped on each item as `expires_at` when it's saved, so changing `retentionDays` affects new feedback only.

### Working through remote feedback with Claude

```bash
node redline/redline.mjs mode   # prints `local`, or `remote <host>` when .env.redline exists
node redline/redline.mjs pull   # bring the inbox into redline/feedback.json
node redline/redline.mjs push   # send local status changes back to the inbox
```

`/redline check` pulls first, and `/redline fix` and `/redline defer` push afterwards, so `/redline` and the inbox show one status. `/redline clear` empties only the local file, never the remote rows.

The dev machine never holds the service-role key. The CLI talks only to the `redline-sync` function with the sync secret, and that function can list feedback you've approved for fixing and change its status, nothing else. `REDLINE_REMOTE_URL` and `REDLINE_SYNC_SECRET` come from the environment or `.env.redline`, kept apart from your app's own `SUPABASE_URL` because a dev env usually points at a local stack while tester feedback lives in a deployed project. Every `pull` and `push` prints the host it's talking to.

Sync rules: `pull` takes the remote copy unless you changed the status locally and the remote hasn't moved, in which case your change waits for `push`. If both changed, the inbox wins, and `pull` lists each local change it discarded by id and page. `push` is a conditional update, so if the inbox changed in the meantime it does nothing for that item and tells you to run `pull`. Items created locally are never pushed.

Retention reaches the dev machine for pulled items. Every `pull` deletes pulled items whose `expires_at` has passed or that the inbox no longer has (purged, deleted, or sent back to To Review there), along with their screenshots, and prints one line saying how many it removed. If one of them had a local status change you hadn't pushed, that line names it. Items created on this machine are never touched by `pull`, however old. Items saved before 1.2.0 have no `expires_at`, so plain `purge` keeps them too and says how many it kept; `purge --days N` removes them by age.

## Admin inbox

An inbox for the person running the alpha, inside your own admin area. It reads and triages Supabase-mode feedback from a browser or phone: filter by status, tester and version, and open an item to see the feedback, screenshot, page, tester, app version and time.

Every tester submission lands in **To Review**, and nothing there can be fixed. You read it and decide: **Move to To Fix**, Defer or Dismiss. Only feedback you've moved to To Fix reaches `/redline fix`. The gate is enforced by the database and the `redline-sync` function, not trusted to the CLI: moving an item to To Fix stamps it as approved, and the function only lists, changes or echoes approved items. Feedback still in To Review, or deferred or dismissed straight from it, never reaches your dev machine or the coding agent. Treat feedback text as untrusted input to the agent even after you approve it: anyone you let in as a tester wrote it, and text can carry instructions aimed at an agent. Read what you move to To Fix, and dismiss anything that reads like instructions to an agent. Undoing a Move to To Fix sends the item back to To Review and withdraws the approval, and the next `pull` removes its local copy. From To Fix an item goes to Fixed, usually by `/redline fix`, or by Mark fixed in the inbox. A fixed, deferred or dismissed item can be moved back to To Fix, never back to To Review, since you've already reviewed it. Tabs: To Review, To Fix, Deferred, Fixed, Dismissed, All. A status change is optimistic with a 5 second Undo, and a stale change (someone else got there first) shows "Changed elsewhere" and reloads the item. It is not available in local mode, where the admin API returns 404.

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

State lives in the URL (`?status=review&id=<uuid>`) through the History API, so a notification link opens the item directly and the browser's Back button works. At 1024px and up it is a list with a detail pane; below that, the detail opens full-width with a Back control.

Hooks you implement in the route files:

| Hook | Where | What it must return |
|---|---|---|
| `isAdmin(req)` | both admin route files | `{ id: string }` for an admin, `null` for everyone else. Runs on every request, because your layout guard does not cover route handlers. A `null` gets a 404, not a 403, so the endpoint doesn't reveal itself. The stub denies everyone until you wire it. |
| `describeTesters(ids)` | both admin route files, optional | `Record<string, string>` mapping tester ids to display labels (a name or email). Without it the inbox shows the raw id. |
| `onRedlineCreated(summary)` | `app/api/redlines/route.ts`, optional | Nothing. It runs after the tester's response is sent, and if it throws, the error is logged and the tester still gets their 201. |

Notification content rule: `onRedlineCreated` receives the page path, tester id, app version, time, whether a screenshot is attached, the UX-review flag and the item id. It never receives feedback text, element text or screenshots, because feedback is free-typed and may contain patient details, and email lacks the database's access controls. Send the owner a link such as `/admin/redline?status=review&id=<id>` and let them read and triage the content in the inbox, behind the admin check.

Every admin response is sent with `Cache-Control: no-store`. PATCH needs `Content-Type: application/json`, a valid status (`review`, `open`, `fixed`, `dismissed`, `deferred`; `open` is To Fix; `review` is accepted so Undo can return an item to To Review) and a UUID id. Screenshot URLs are signed for 5 minutes, made when an item is opened, and never stored.

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
