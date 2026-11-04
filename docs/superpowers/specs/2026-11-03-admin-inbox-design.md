# Redline Admin Inbox: Design

**Date:** 2026-11-03
**Status:** Draft
**First host:** FLT (The Freelancer Tool)
**Builds on:** `feat/supabase-storage` (storage adapters, Supabase backend, PHI masking)

## Why

With `storage: 'supabase'`, tester feedback lands in the host's database, but the only way to see it is `node redline/redline.mjs pull` followed by `/redline` in Claude Code. The person running the alpha has no way to know feedback arrived, and no way to look at it from a browser or a phone.

FLT's alpha checklist (section 7 of `docs/ALPHA-CHECKLIST.md` in the FLT repo) sets the bar for hosted Redline. It has to work signed in, be tap-first at 390px, need no voice (a key tester is Deaf), include a screenshot, and notify the owner. This spec covers the owner side: the notification and the inbox at `/admin/redline`.

## Goals

1. The owner is told when feedback arrives.
2. The owner can open an item and see the feedback, screenshot, page, tester, app version and time, then set its status, at a desk or on a phone.
3. Every item has one status, the same in the inbox, in `/redline check` and in `/redline fix`. Status never drifts between copies.
4. The inbox lives inside the host's own admin area, behind the host's own admin check.

## Non-goals

- Comments, threads, assignment or labels. This is triage, not a ticket tracker.
- Showing testers what happened to their feedback.
- Full-text search. Filters only.
- An inbox for local mode. Local mode keeps the sidebar plus Claude Code.
- Editing Redline config from the UI. Storage mode, keys, PHI selectors and retention stay in `redline.config.ts`. Storage mode can't sensibly be saved in the storage it picks. Keys can't sit behind a form that writes to a database. PHI selectors are tied to markup, so they need code review.

## Anti-goals (a failure even if it works)

- Anything that widens who can see PHI. That covers feedback text or screenshots in email, public or long-lived screenshot URLs, and cached admin responses.
- A second source of truth for status.
- An admin endpoint whose protection depends on the page layout's guard alone.

## Out of this spec, but required for FLT's alpha

The inbox alone does not satisfy the checklist. Two sibling pieces of work have to ship with it:

- **A. Tap-first capture (Redline repo, separate spec).** The inspector is mouse-only today. Element mode depends on `mousemove` for its highlight, and area mode is built on `mousedown`/`mousemove`/`mouseup` (`component/redline-inspector.tsx:183-291`). On a phone, area capture doesn't work.
- **B. FLT integration (FLT repo, FLT milestone format).** FLT's copies in `apps/webapp/src/components/shared/` predate config, storage and masking, so they need upgrading. FLT also needs the migrations applied, its hooks implemented (see "FLT integration" below), PHI tagged with `data-phi`, and `feedbackButtonEnabled()` in `lib/env.ts` changed so the button shows on deployed copies when storage is Supabase and the user is signed in.

Suggested order: this spec's Redline pieces, then A, then B. B can start in parallel for desktop.

## How it works

### Data

Add a third migration (new timestamp):

- `status_updated_at timestamptz not null default now()`, backfilled from `created_at`.
- `status_updated_by text`: the admin's id, or `redline-cli` for changes pushed from Claude Code.
- An index on `(status, created_at desc)`.

Grants don't change: only `service_role` can touch the schema and the bucket.

### Storage adapter (`component/redline-storage.ts`)

Add three methods to `RedlineStore`. The Supabase adapter implements them. The local adapter throws `not supported`.

- `query({ status?, testerId?, appVersion?, cursor?, limit? })` returns `{ items, nextCursor, counts }`. Items are newest first. `cursor` is the last item's `created_at` plus its `id`. `counts` holds the totals per status, ignoring the other filters.
- `get(id)` returns one item, or `null`.
- `setStatus(id, status, by, expectedUpdatedAt)` is a conditional update: `?id=eq.X&status_updated_at=eq.T` with `Prefer: return=representation`. Zero rows back means `{ conflict: currentItem }`.
- `screenshotUrl(path, ttlSeconds = 300)` returns a signed URL from `POST /storage/v1/object/sign/{bucket}/{path}`.

The existing `list()` stays as is (ascending, used by the CLI).

### Admin API (`component/api-admin-route-example.ts`)

The host copies this to its admin API folder. In Next.js that's two files, `api/admin/redlines/route.ts` and `api/admin/redlines/[id]/route.ts`. It supports Supabase mode only and returns 404 in local mode.

The host supplies:

- `isAdmin(req): Promise<{ id: string } | null>`. Every handler calls it. A non-admin gets **404**, not 403, so the endpoint doesn't reveal that it exists.
- `describeTesters(ids): Promise<Record<string, string>>` is optional. It maps tester ids to display labels. Without it, the raw id is shown.

Endpoints:

| Method | Path | Returns |
|---|---|---|
| GET | `/api/admin/redlines?status=open&tester=&version=&cursor=` | `{ items, nextCursor, counts, testers, versions }`. Each item has a `tester_label`. `testers` and `versions` are the distinct values for the filter menus. |
| GET | `/api/admin/redlines/:id` | The item plus `screenshot_url`, signed for 5 minutes, or `null` if there's no screenshot or the file is gone |
| PATCH | `/api/admin/redlines/:id` | Body `{ status, expected_status_updated_at }`. Returns 200 with the item, 409 with the current item, 400 for a bad status or id |

Every response is sent with `Cache-Control: no-store`. PATCH requires `Content-Type: application/json`, so a plain cross-site form post can't trigger it. Status must be one of `open | fixed | dismissed | deferred`, and the id must be a UUID.

### Notification

In the tester-facing `POST /api/redlines`, after `saveItem` succeeds, the route calls an optional host hook, `onRedlineCreated(item)`, using `after()` from `next/server` so the tester's response isn't held up. If the hook fails, the error is logged and the tester still gets their 201.

**What the notification may contain:** the page path (already sanitized), the tester's label, the app version, the time, whether a screenshot is attached, and a link to `/admin/redline?id=<uuid>`. **Never** the feedback text, the element text or the screenshot. Feedback is free-typed and may contain patient details, and email doesn't have the access controls the database has. The owner reads the content in the inbox, behind the admin check.

There's one email per item and no batching in v1. Alpha volume is small.

### Inbox UI (`component/redline-admin-inbox.tsx`)

This is a client component, styled with Tailwind and shadcn token classes (`bg-card`, `border-border`, `text-muted-foreground`) like the existing sidebar, with icons from `lucide-react`. Its props are `apiUrl` (default `/api/admin/redlines`) and `basePath` (default `/admin/redline`). The host renders it inside a page under its own admin layout.

**Layout.** At 1024px and up, the list is on the left and the detail on the right. Below 1024px, it shows the list, and tapping an item opens the detail full-width with a Back control. State lives in the URL (`?status=open&id=…`), so the notification link opens the item directly and the browser's Back button works.

**List row.** Each row shows the status, the first two lines of the feedback, the page path, the tester label, the app version and the relative time. It also shows a camera icon if there's a screenshot and a "UX review" badge if one was requested. Rows are at least 44px tall, and nothing depends on hover.

**Filters.** Status tabs with counts come first: Open (the default), Deferred, Fixed, Dismissed and All. Tester and version menus sit beside them. The list loads 50 at a time with a "Load more" control.

**Detail.** In order:
- the full feedback text
- the screenshot, which opens full-size in an in-page viewer (not a new tab, because the signed URL expires)
- the page URL as stored. Its link opens the path without the redacted query, the same as the sidebar.
- the element selector and element text
- the tester, app version and user agent
- the created date, plus "Deletes in N days" so the owner knows retention is running
- actions: **Mark fixed**, **Defer**, **Dismiss**, and **Reopen** on items that aren't open

**After a status change.** The change is optimistic. The item leaves the current filter and the next item is selected, so the owner can work through the list in one pass. An inline "Marked fixed · Undo" shows for 5 seconds, and Undo PATCHes the previous status back.

**States.**
- Loading shows skeleton rows.
- An empty filter shows a message for that filter, for example "No open feedback. New submissions from testers show up here."
- A failed load shows an error with Retry.
- A 409 shows "Changed elsewhere. Showing the latest." and reloads the item.
- A missing screenshot shows "Screenshot no longer available".
- If a signed URL has expired, the image is fetched again once on its error event.

### One status everywhere (CLI and skills)

**Scoped access (Chad's decision).** The dev machine never holds the service-role key. A new edge function, `supabase/functions/redline-sync`, is the CLI's only way in. It's deployed with `--no-verify-jwt` and authenticated by its own shared secret in an `x-redline-sync-secret` header, compared in constant time like the purge function, and kept separate from the purge secret. It reads the service-role key from its own environment and allows only these actions:

| Action | Does |
|---|---|
| `POST { action: 'list' }` | Returns every item (all statuses, for the sync rules), each with a 5-minute signed `screenshot_url` |
| `POST { action: 'set_status', id, status, expected_status_updated_at }` | The same conditional update as `setStatus`. Returns `{ item }`, or `{ conflict: item }` |

It rejects any other action and validates the status values and UUIDs. It has no way to delete, create or read anything outside `feedback.items` and the screenshot bucket. `pull` (already built on the REST API with the service-role key) is reworked to use the function, and the `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` path in `redline.mjs` is removed.

**Which project.** The remote the CLI talks to is set by its own env vars, `REDLINE_REMOTE_URL` and `REDLINE_SYNC_SECRET`, read from a gitignored `.env.redline` in the project root. They're kept apart from the app's `SUPABASE_URL`, because a host's dev env usually points at its local stack while tester feedback lives in a deployed project (for FLT, `flt-lab`). The commands are in remote mode when `.env.redline` exists, whatever `redline.config.ts` says on the dev machine. Every `pull` and `push` prints the project host it's talking to.

**What gets recorded.** `pull` marks each item it brings down with `source: 'remote'`, plus `remote_status` and `remote_status_updated_at` as last seen. Items created locally have no `source` and are never pushed.

**Sync rules:**
- `pull`: if the local status still equals `remote_status`, take the remote copy. If the local status was changed and the remote wasn't (same `remote_status_updated_at`), keep the local change for `push`. If both changed, **the remote status wins** and `pull` lists each local change it discarded, by id and page. The inbox is a person's deliberate decision. A local change is usually Claude's.
- `push`: for each remote item whose local status differs from `remote_status`, it does the same conditional update as `setStatus`, with `status_updated_by = 'redline-cli'`. On success it updates `remote_status` and `remote_status_updated_at`. On a conflict it does nothing and says to run `pull`, which then settles the item by the rule above. So no item stays different between the two copies for more than one pull.

**Command files.** In remote mode, `check.md` and `fix.md` run `pull` first, and `fix.md` and `defer.md` run `push` after. `clear.md` clears only the local file, never the remote rows. Deleting rows is the purge's job.

## FLT integration (built in B, recorded here so the Redline pieces fit)

- **Page:** `apps/webapp/src/app/(dashboard)/admin/redline/page.tsx`, rendering `<RedlineAdminInbox />` inside the existing `AdminLayout`, which already redirects non-superadmins.
- **Nav:** a "Tester Feedback" entry under Oversight › Queues in `admin-shell.tsx`, next to Email Quarantine.
- **`isAdmin`:** the `is_superadmin` RPC through `createServerClient()`, the same check `AdminLayout` uses. It runs again in the API route, because route handlers aren't covered by the layout.
- **`getTesterId`:** the signed-in user's id. While a superadmin is impersonating, it records the real admin, not the interpreter being impersonated.
- **`describeTesters`:** a profiles lookup through `createAdminClient()`, giving name and email.
- **`onRedlineCreated`:** FLT's `sendEmail` gateway (`lib/email/gateway.ts`) to an address in a server env var, `REDLINE_NOTIFY_TO`.
- **Migrations and both functions** (`redline-purge`, `redline-sync`) reach `flt-lab` through FLT's existing process. Nothing in this work pushes to a remote.
- **`.env.redline`** in FLT's root holds `flt-lab`'s URL and the sync secret, and is gitignored.

## Security checklist

- The admin check runs on the server in every admin handler, not only in the page layout.
- Signed screenshot URLs last 5 minutes. They're made when an item is opened, never stored, never logged.
- Every admin response is sent with `no-store`.
- No new database grants. `anon` and `authenticated` still can't read anything.
- Notifications carry no feedback text, element text or screenshots.
- The admin API returns 404 in local mode and to non-admins.
- No machine outside the host's servers holds the service-role key. The CLI holds only the sync secret, which can list feedback and change status, nothing else.
- `.env.redline` is added to `.gitignore` by the installer.

## Testing

- **Supabase spec, against the local stack:** `query` filters, cursor paging and counts; `get`; `setStatus` success and conflict; signed URLs that work and then expire; a missing screenshot giving `null`.
- **Admin route:** a non-admin gets 404; an admin gets 200; a bad status or id gets 400; a stale update gets 409; every response carries `no-store`; local mode gets 404.
- **Notification:** the hook is called after a save; a throwing hook still gives the tester a 201; the payload never contains the feedback or element text.
- **Sync function, served locally:** a wrong or missing secret gets 401; an unknown action gets 400; `list` returns signed URLs; `set_status` succeeds and conflicts as `setStatus` does; it can't delete or reach other tables.
- **CLI:** a pull/push round trip through the sync function; a push conflict changes nothing; the next pull takes the remote status and reports the discarded local change; pull keeps local changes that haven't been pushed when the remote hasn't moved; local-only items are never pushed; both commands print the project host.
- **Inbox UI (Playwright on the fixture, at 1280px and 390px):** filters and counts, the deep link `?id=`, detail, every status action, Undo, the empty, error, conflict and missing-screenshot states, Back on mobile, and no element smaller than 44px.

## Decisions

**Chad's:**
- FLT is the first host.
- Skip the discovery questions and spec directly.
- The dev machine gets scoped access through a `redline-sync` function, never the service-role key.

**Claude's** (proposed earlier in the conversation and not contested, or made while writing; check these):
- Config stays in code. The inbox is triage only.
- Supabase is the source of truth for status in Supabase mode, and the CLI does conditional push with skip-on-conflict.
- Notifications are content-free, one email per item.
- Non-admins get 404 rather than 403.
- Redline ships the inbox UI, styled with shadcn tokens, rather than FLT building its own. This fits the existing sidebar. The cost is that the inbox doesn't use FLT's own `SegmentedControl` or `Table`.
- Signed URLs last 5 minutes.
- Impersonated feedback is attributed to the real admin.
- If a status changed both locally and in the inbox, the inbox wins, and `pull` reports what it discarded.
- The CLI's remote is set by `REDLINE_REMOTE_*` in `.env.redline`, not the app's own Supabase env vars.
- The nav label is "Tester Feedback".

## Left to the builder

The component's internal structure, user-agent display (raw or parsed), skeleton design, the exact copy for empty states (following the examples above), and the paging cursor encoding.

## Release

Merge `feat/supabase-storage` and this work, then cut a Redline minor version (1.2.0) the usual way.
