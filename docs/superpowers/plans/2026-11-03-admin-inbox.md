# Redline Admin Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner of a Redline host get notified about tester feedback stored in Supabase, triage it at `/admin/redline` on desktop or phone, and keep one status in sync with Claude Code's `/redline` commands.

**Architecture:** Route logic moves into two handler factories (`createFeedbackHandlers`, `createAdminHandlers`) that take the store plus host hooks and return plain `Request → Response` functions. The example route files just wire config and hooks into them. The Supabase adapter gains inbox queries, a conditional status update and signed screenshot URLs, backed by a migration whose trigger stamps `status_updated_at`. A scoped `redline-sync` edge function is the CLI's only way in, and the CLI's `pull` and `push` apply the spec's sync rules. The inbox UI is two client components, a list shell and a detail pane, tested on an esbuild fixture with a mocked API.

**Tech Stack:** TypeScript, React 19, Next.js App Router conventions (`after` from `next/server`), Supabase REST and Storage APIs over `fetch` (no supabase-js), Deno edge functions, Node CLI (no dependencies), Playwright, esbuild, Tailwind v4 (tests only).

**Spec:** `docs/superpowers/specs/2026-11-03-admin-inbox-design.md`

**Scope:** Redline repo only. Tap-first capture (spec part A) and FLT integration (spec part B) are separate plans.

## Global Constraints

- No new runtime dependencies. Components may use only `react`, `lucide-react` and `modern-screenshot`, which are already in use. New dev dependencies are for tests only.
- Every Supabase call goes over `fetch` to the REST and Storage APIs, as `redline-storage.ts` and `redline-purge` already do.
- Only `service_role` touches `feedback.*` and the bucket. Every new SQL function gets `revoke execute ... from public, anon, authenticated` and `grant execute ... to service_role`.
- Statuses: `open | fixed | dismissed | deferred`. Ids must match a UUID.
- Signed screenshot URLs: `ttlSeconds = 300`.
- Every admin response, errors included, sends `Cache-Control: no-store`.
- Non-admin, or local mode, gets **404** from every admin endpoint.
- Notifications receive only `NotificationSummary` (Task 3), never feedback text, element text or screenshots.
- `status_updated_at` is an opaque string. Never pass it through `new Date()`, which drops microseconds and makes every conditional update conflict. Store and compare it exactly as the API returns it.
- Exact UI copy:
  - `No open feedback. New submissions from testers show up here.` (Open tab). Other tabs: `No {status} feedback.`
  - `Changed elsewhere. Showing the latest.`
  - `Screenshot no longer available`
  - `This feedback is no longer available.`
  - `Marked {status} · Undo`
  - `Deletes in {N} days`
  - Actions: `Mark fixed`, `Defer`, `Dismiss`, `Reopen`
- Layout: side-by-side list and detail at ≥1024px. Below that, list and detail are separate views with a `Back` control. Tap targets are at least 44px tall, nothing is hover-only, and there is no horizontal scroll at 390px.
- List page size: 50 (max 100).
- Styling: Tailwind with shadcn token classes (`bg-card`, `bg-background`, `border-border`, `text-muted-foreground`, `text-destructive`), matching `component/redline-sidebar.tsx`.
- CLI remote config: `REDLINE_REMOTE_URL` and `REDLINE_SYNC_SECRET`, from the environment first, then `.env.redline` in the project root. CLI-written statuses carry `status_updated_by = 'redline-cli'`.

## Review Focus

1. **Timestamp round-trip.** `pull` then `push` with no other change must succeed. Expected: no conflict. Pinned in Task 6 (`pull stores the exact remote_status_updated_at string`, `push after pull succeeds`).
2. **Item purged while the inbox is open.** Opening or PATCHing it returns 404. Expected: `This feedback is no longer available.` and the row disappears. Pinned in Task 4 (`patch unknown id is 404`) and Task 7 (`a purged item shows the gone message`).
3. **Signed URL expires in a tab left open.** Expected: the item is refetched once, and a second failure shows `Screenshot no longer available` without looping. Pinned in Task 7 (`expired screenshot refetches once, then gives up`).
4. **Huge or empty fields at 390px.** A 2,000-character feedback, a 300-character path, a null tester, a null version. Expected: no horizontal scroll and no "null" text. Pinned in Task 8 (`no horizontal scroll at 390 with extreme fields`).
5. **Undo after a quick status change.** Undo must send the `status_updated_at` returned by the first PATCH, not the one originally loaded, or it 409s on every use. Pinned in Task 8 (`Undo uses the timestamp from the first PATCH`).

---

### Task 1: Test stack + inbox migration

**Files:**
- Create: `dev/test-stack.sh`
- Create: `supabase/migrations/20261103000000_redline_inbox.sql`
- Modify: `package.json` (scripts), `.gitignore`
- Test: `tests/supabase.spec.ts`

**Interfaces:**
- Produces: columns `feedback.items.status_updated_at timestamptz not null` and `status_updated_by text`. A trigger that sets `status_updated_at = now()` whenever `status` changes. RPC `feedback.inbox_summary() returns jsonb` shaped `{ counts: { open, fixed, dismissed, deferred }, testers: string[], versions: string[] }`. Test env file `.redline-stack/test.env` with `REDLINE_SB_URL`, `REDLINE_SB_SECRET`, `REDLINE_SB_PUBLIC`, `REDLINE_SB_PURGE_SECRET`, `REDLINE_SB_SYNC_SECRET`.

- [ ] **Step 1: Write `dev/test-stack.sh`.** It runs `supabase init` in `.redline-stack/` if that folder is missing, and remaps every port in `config.toml` from `543xx` to `553xx` (plus `shadow_port` → 55320 and `inspector_port` → 8183), so it never collides with a host's stack. It adds `"feedback"` to `[api] schemas`. Then it copies `supabase/migrations/*` and `supabase/functions/*` in, runs `supabase start` (or `supabase db reset` if the stack is already up), and writes `.redline-stack/fn.env` with `REDLINE_PURGE_SECRET` and `REDLINE_SYNC_SECRET` (random values). It starts `supabase functions serve --no-verify-jwt --env-file .redline-stack/fn.env` with `nohup`, logging to `.redline-stack/functions.log`, and waits until `POST /functions/v1/redline-purge` returns 401. Finally it writes `.redline-stack/test.env` from `supabase status -o env` plus the two secrets.
- [ ] **Step 2: Add the scripts and ignores.** In `package.json`, add `"test:stack": "bash dev/test-stack.sh"` and `"test:all": "bash -c 'set -a; . .redline-stack/test.env; set +a; playwright test'"`. Add `.redline-stack/` and `.env.redline` to `.gitignore`.
- [ ] **Step 3: Write the failing tests** in `tests/supabase.spec.ts`. Add `REDLINE_SB_SYNC_SECRET` to the skip condition.

```ts
test('status change stamps status_updated_at; other updates leave it', async () => {
  const r = await saveWithScreenshot(item())
  const t0 = (await readRow(r.id)).status_updated_at          // readRow: REST GET by id with SECRET
  await patchRow(r.id, { feedback: 'edited' })
  expect((await readRow(r.id)).status_updated_at).toBe(t0)
  await patchRow(r.id, { status: 'fixed' })
  expect((await readRow(r.id)).status_updated_at).not.toBe(t0)
})

test('inbox_summary returns zero-filled counts, testers and versions; the public key cannot call it', async () => {
  const before = await rpcSummary(SECRET)
  await saveWithScreenshot(item({ tester_id: 'tester-sum', app_version: '9.9.9' }))
  const after = await rpcSummary(SECRET)
  expect(Object.keys(after.counts).sort()).toEqual(['deferred', 'dismissed', 'fixed', 'open'])
  expect(after.counts.open).toBe(before.counts.open + 1)
  expect(after.testers).toContain('tester-sum')
  expect(after.versions).toContain('9.9.9')
  expect((await rpcRaw(PUBLIC)).status).not.toBe(200)
})
```

- [ ] **Step 4: Run** `pnpm test:stack && pnpm test:all -g "status_updated_at|inbox_summary"`. Expected: FAIL (column and function don't exist).
- [ ] **Step 5: Write the migration.** Add both columns, backfilling `status_updated_at` from `created_at`, then set its default to `now()`. Add the trigger function `feedback.stamp_status()` (`security invoker`, `set search_path = ''`, `if new.status is distinct from old.status then new.status_updated_at := now()`) as a `before update` trigger. Add the index `(status, created_at desc, id desc)`. `feedback.inbox_summary()` is `language sql stable`, `set search_path = ''`, with testers sorted ascending and versions sorted descending, nulls excluded. Apply the revokes and grants from Global Constraints to both functions.
- [ ] **Step 6: Run** `pnpm test:stack && pnpm test:all`. Expected: all pass, including the existing suites.
- [ ] **Step 7: Commit:** `feat: inbox migration (status stamps, summary RPC) and dev test stack`

---

### Task 2: Storage adapter inbox methods

**Files:**
- Modify: `component/redline-storage.ts`
- Test: `tests/supabase.spec.ts`, `tests/storage.spec.ts`

**Interfaces:**
- Consumes: the Task 1 columns and `inbox_summary`.
- Produces, in `redline-storage.ts`:

```ts
export interface RedlineItem { /* existing */ status_updated_at?: string; status_updated_by?: string | null }
export interface InboxQuery { status?: RedlineStatus; testerId?: string; appVersion?: string; cursor?: string; limit?: number }
export interface InboxPage { items: RedlineItem[]; nextCursor: string | null }
export interface InboxSummary { counts: Record<RedlineStatus, number>; testers: string[]; versions: string[] }
export type SetStatusResult = { item: RedlineItem } | { conflict: RedlineItem } | { missing: true }
// added to RedlineStore:
readonly kind: 'local' | 'supabase'
query(q: InboxQuery): Promise<InboxPage>
summary(): Promise<InboxSummary>
get(id: string): Promise<RedlineItem | null>
setStatus(id: string, status: RedlineStatus, by: string, expectedUpdatedAt: string): Promise<SetStatusResult>
screenshotUrl(path: string, ttlSeconds?: number): Promise<string | null>
export const STATUSES: readonly RedlineStatus[]
export const isUuid: (s: string) => boolean
```

- [ ] **Step 1: Write the failing tests.** In `tests/supabase.spec.ts`:
  - `query pages newest first with a stable cursor`: create 3 items with identical `created_at`, then query with `limit: 2`. Page one has 2 items. Page two has 1, with `nextCursor === null`. The ids across both pages are unique, and their order matches `created_at desc, id desc`.
  - `query filters by status, tester and version`: each filter returns only matching ids.
  - `get returns the item or null`
  - `setStatus: success, conflict, missing`. Success returns `item.status === 'fixed'`, `status_updated_by === 'admin-1'`, and a `status_updated_at` that differs from before. A second call with the old timestamp returns `{ conflict }` whose `status === 'fixed'`. A random UUID returns `{ missing: true }`.
  - `status_updated_at is returned exactly as stored`: the value from `get()` is `===` to a raw REST read of the same row.
  - `screenshotUrl signs for 300s and is null for a missing object`: fetching the URL gives 200 with the PNG bytes. With `ttlSeconds: 1`, after 2 seconds it's no longer 200. A path that doesn't exist gives `null`.

  In `tests/storage.spec.ts`: `local store inbox methods reject` checks that `query`, `summary`, `get`, `setStatus` and `screenshotUrl` each reject with `/not supported/`, and that `kind === 'local'`.
- [ ] **Step 2: Run** `pnpm test:all -g "query|get returns|setStatus|exactly as stored|screenshotUrl|inbox methods"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `query`: `order=created_at.desc,id.desc`, `limit` defaulting to 50 and clamped to 100. The cursor is base64url of `` `${created_at}|${id}` ``, applied as `or=(created_at.lt.C,and(created_at.eq.C,id.lt.I))`. Fetch `limit + 1` rows to decide `nextCursor`.
  - `summary`: `POST /rest/v1/rpc/inbox_summary` with `Content-Profile: feedback`.
  - `setStatus`: `PATCH items?id=eq.X&status_updated_at=eq.<encodeURIComponent(T)>` with body `{ status, status_updated_by }` and `Prefer: return=representation`. If no row comes back, `get(id)` decides between conflict and missing.
  - `screenshotUrl`: `POST /storage/v1/object/sign/{bucket}/{path}` with body `{ expiresIn }`. Return `${url}/storage/v1${signedURL}`, or `null` on a 400 or 404.
- [ ] **Step 4: Run** `pnpm test:all && pnpm typecheck`. Expected: all pass.
- [ ] **Step 5: Commit:** `feat: storage adapter inbox queries, conditional status, signed screenshots`

---

### Task 3: Feedback handlers + owner notification

**Files:**
- Create: `component/redline-handlers.ts`
- Modify: `component/api-route-example.ts` (reduced to wiring)
- Test: `tests/handlers.spec.ts`

**Interfaces:**
- Consumes: `RedlineStore`, `RedlineItem` (Task 2); `RedlineConfig`, `sanitizePageUrl`, `DEFAULT_RETENTION_DAYS` (`redline-config.ts`).
- Produces:

```ts
export interface NotificationSummary { id: string; page_url: string; tester_id: string | null; app_version: string | null; created_at: string; has_screenshot: boolean; ux_review_requested: boolean }
export function toNotificationSummary(item: RedlineItem): NotificationSummary
export interface FeedbackHandlerOptions {
  config: RedlineConfig
  store: RedlineStore
  getTesterId(req: Request): Promise<string | null>
  onRedlineCreated?(summary: NotificationSummary): Promise<void> | void
  defer?(task: () => Promise<void>): void            // route passes `after` from next/server
}
export function createFeedbackHandlers(o: FeedbackHandlerOptions): { GET(): Promise<Response>; POST(req: Request): Promise<Response> }
```

- [ ] **Step 1: Write the failing tests** in `tests/handlers.spec.ts`. They use `localStore(tmpdir)` for local mode, and a minimal in-memory `RedlineStore` with `kind: 'supabase'` for Supabase mode.
  - `POST saves and returns 201; GET lists open items` (local; same JSON shapes as today's route)
  - `missing feedback is 400`
  - `supabase mode: POST without a tester is 401, GET is 404`
  - `onRedlineCreated gets only the summary, deferred`. `defer` captures the task without running it, so the hook is not called before the response. After the captured task runs, check `Object.keys(summary).sort()` equals `['app_version','created_at','has_screenshot','id','page_url','tester_id','ux_review_requested']`, and that `JSON.stringify(summary)` doesn't contain the feedback string.
  - `a throwing onRedlineCreated still returns 201 and logs`: the console spy shows `[redline] onRedlineCreated failed`.
  - `no defer given: the hook runs without blocking the response`
- [ ] **Step 2: Run** `pnpm exec playwright test tests/handlers.spec.ts`. Expected: FAIL (the module doesn't exist).
- [ ] **Step 3: Implement** `createFeedbackHandlers` by moving the body of today's `GET` and `POST` into it unchanged. After `saveItem`, call `defer(() => safeNotify(summary))`, where the default `defer` is `(t) => { void t() }`. Then reduce `api-route-example.ts` to: the config import, `createRedlineStore`, the documented `getTesterId` stub, an `onRedlineCreated` example in a comment, and `export const { GET, POST } = createFeedbackHandlers({ ..., defer: after })`.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: all pass (the Supabase suite skips without the env).
- [ ] **Step 5: Commit:** `feat: feedback handler factory with content-free owner notification hook`

---

### Task 4: Admin API handlers + route examples

**Files:**
- Create: `component/redline-admin-types.ts`, `component/redline-admin-handlers.ts`, `component/api-admin-route-example.ts` (→ `api/admin/redlines/route.ts`), `component/api-admin-item-route-example.ts` (→ `api/admin/redlines/[id]/route.ts`)
- Test: `tests/admin-handlers.spec.ts`

**Interfaces:**
- Consumes: the Task 2 store methods, `STATUSES` and `isUuid`.
- Produces, in `redline-admin-types.ts` (type-only imports, so it's client-safe):

```ts
export type AdminItem = RedlineItem & { tester_label: string | null }
export type AdminDetail = AdminItem & { screenshot_url: string | null }
export interface AdminListResponse { items: AdminItem[]; nextCursor: string | null; counts: Record<RedlineStatus, number>; testers: { id: string; label: string }[]; versions: string[] }
export interface AdminConflict { current: AdminItem }
```

And in `redline-admin-handlers.ts`:

```ts
export interface AdminHandlerOptions { config: RedlineConfig; store: RedlineStore; isAdmin(req: Request): Promise<{ id: string } | null>; describeTesters?(ids: string[]): Promise<Record<string, string>> }
export function createAdminHandlers(o: AdminHandlerOptions): {
  list(req: Request): Promise<Response>                 // GET ?status&tester&version&cursor&limit
  get(req: Request, id: string): Promise<Response>      // GET :id → AdminDetail
  patch(req: Request, id: string): Promise<Response>    // PATCH :id { status, expected_status_updated_at }
}
```

- [ ] **Step 1: Write the failing tests** in `tests/admin-handlers.spec.ts`, against an in-memory store with the same conflict semantics as `setStatus`.
  - `non-admin gets 404 on list, get and patch, and the store is never called`
  - `local mode gets 404 even for an admin`
  - `every response sends Cache-Control: no-store` (200, 400, 404, 409, 415)
  - `list passes filters through and merges the summary`
  - `list labels testers via describeTesters, falling back to the raw id`
  - `list rejects an unknown status with 400`
  - `get includes a 300s screenshot_url, null without a screenshot, 404 for an unknown id`
  - `patch: 415 without a JSON content type; 400 for a bad status, a non-UUID id or a missing expected_status_updated_at`
  - `patch: 200 sets status_updated_by to the admin's id; 409 returns { current }`
  - `patch unknown id is 404`
- [ ] **Step 2: Run** `pnpm exec playwright test tests/admin-handlers.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the handlers. `isAdmin` is checked first, and before it the handlers check `config.storage === 'supabase'` and `store.kind === 'supabase'`. Every response goes through one `json(body, status)` helper that sets `no-store`. `describeTesters` is called once per response with the distinct non-null tester ids. Then write the two route examples. Each imports the config, creates the store, documents an `isAdmin` stub that returns `null` and a commented `describeTesters`, and exports `GET` and `PATCH`. The item route uses the Next 15+ signature, `(req, { params }: { params: Promise<{ id: string }> })`.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: all pass.
- [ ] **Step 5: Commit:** `feat: admin API handlers and route examples`

---

### Task 5: `redline-sync` edge function

**Files:**
- Create: `supabase/functions/redline-sync/index.ts`
- Test: `tests/supabase.spec.ts`

**Interfaces:**
- Consumes: the Task 1 schema. Env: `REDLINE_SYNC_SECRET`, `REDLINE_BUCKET` (default `redline-screenshots`), `SUPABASE_URL`, and the secret key, read the same way `redline-purge`'s `secretKey()` does.
- Produces: `POST /functions/v1/redline-sync` with header `x-redline-sync-secret`.
  - `{ action: 'list' }` → 200 `{ items: (RedlineItem & { screenshot_url: string | null })[] }`, every status, ordered `created_at asc`.
  - `{ action: 'set_status', id, status, expected_status_updated_at }` → 200 `{ item }`, 409 `{ conflict }` or 404 `{ missing: true }`, with `status_updated_by = 'redline-cli'`.

- [ ] **Step 1: Write the failing tests** (using a `sync(body, secret = SYNC_SECRET)` helper):
  - `sync rejects a wrong or missing secret with 401 and non-POST with 405`
  - `sync rejects unknown actions, bad ids and bad statuses with 400`
  - `sync list returns every status with signed screenshot URLs that download`
  - `sync set_status succeeds, conflicts with 409 and misses with 404`
  - `sync cannot delete`: `{ action: 'delete', id }` gives 400, and the row still exists.
- [ ] **Step 2: Run** `pnpm test:stack && pnpm test:all -g "sync "`. Expected: FAIL (404 from the functions gateway).
- [ ] **Step 3: Implement**, self-contained in the style of `redline-purge`. Copy `sameSecret` and `secretKey` across rather than sharing them, because hosts copy functions one at a time. Return 500 `REDLINE_SYNC_SECRET is not set` when the secret is unset. Use the same conditional PATCH and signing calls as Task 2.
- [ ] **Step 4: Run** `pnpm test:stack && pnpm test:all`. Expected: all pass.
- [ ] **Step 5: Commit:** `feat: redline-sync function for scoped CLI access`

---

### Task 6: CLI `mode`, `pull`, `push` + command files

**Files:**
- Modify: `scripts/redline.mjs`, `commands/redline.md`, `commands/redline/check.md`, `commands/redline/fix.md`, `commands/redline/defer.md`, `commands/redline/clear.md`
- Test: `tests/supabase.spec.ts` (CLI tests run with `REDLINE_ROOT` set to a temp dir), `tests/storage.spec.ts`

**Interfaces:**
- Consumes: the Task 5 function.
- Produces CLI commands:
  - `mode` prints `local`, or `remote <host>`.
  - `pull` and `push` each print `Supabase: <host>` first.
  - `pull` prints `Discarded local change on <id> (<page_url>): <local> → kept <remote>` for each conflict.
  - `push` prints `Conflict on <id>: changed in the inbox. Run pull.` for each conflict.
- Item fields on pulled items in `feedback.json`: `source: 'remote'`, `remote_status`, `remote_status_updated_at`.

- [ ] **Step 1: Write the failing tests.**
  - In `storage.spec.ts`: `mode prints local without remote config`.
  - In `supabase.spec.ts`:
    - `mode prints remote with the host from .env.redline`
    - `pull without remote config fails and names .env.redline`, even with `SUPABASE_URL` set
    - `pull stores source, remote_status and the exact remote_status_updated_at string`, compared `===` against `store.get()`
    - `push after pull succeeds and records redline-cli`: edit the local status, push, then check remote `status` and `status_updated_by === 'redline-cli'`, and that the local `remote_status` was updated
    - `push conflict changes nothing remotely and says to pull`: change the remote via `store.setStatus` after the pull
    - `pull after a conflict takes the remote status and reports the discarded change`
    - `pull keeps an unpushed local change when the remote has not moved`
    - `local-only items are never pushed`: an item with no `source` never produces a sync call (check that the remote has no row with that id)
    - `pull and push print the project host`
- [ ] **Step 2: Run** `pnpm test:all -g "mode|pull|push"`. Expected: FAIL.
- [ ] **Step 3: Implement** in `redline.mjs`. `loadRemote()` reads the env, then a minimal `KEY=VALUE` parse of `<root>/.env.redline`. Rewrite `pull` on `list`, using these merge rules per remote item:
  - new: add it and download the screenshot through `screenshot_url`, keeping the existing filename check
  - local status equals `remote_status`: take the remote copy
  - local changed, remote timestamp unchanged: keep the local change
  - both changed: take the remote and print the discard line

  `push` sends `set_status` for each `source: 'remote'` item whose `status !== remote_status`, and updates `remote_status` and `remote_status_updated_at` from the response. Remove the `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` path, and update the usage text and header comment.
- [ ] **Step 4: Update the command files.**
  - `check.md` and `fix.md`: the first step runs `node redline/redline.mjs mode`. If the output starts with `remote`, run `node redline/redline.mjs pull` and relay any `Discarded` lines.
  - `fix.md` and `defer.md`: the last step, when remote, runs `node redline/redline.mjs push` and relays any `Conflict` lines.
  - `clear.md`: when remote, say that it clears only the local file, and that remote rows expire through retention.
  - `commands/redline.md`: replace the `--env-file=.env ... pull` line with a pointer to `mode`.
- [ ] **Step 5: Run** `pnpm test:all && grep -c "redline.mjs mode" commands/redline/check.md commands/redline/fix.md`. Expected: all pass, and each count is at least 1.
- [ ] **Step 6: Commit:** `feat: CLI pull/push through redline-sync with one-status sync rules`

---

### Task 7: Inbox detail pane

**Files:**
- Create: `component/redline-admin-detail.tsx`, `tests/fixture/admin.tsx`, `tests/fixture/admin.css`, `tests/admin-ui.ts` (fixture build + mocked API helpers), `tests/admin-detail.spec.ts`
- Modify: `package.json` (dev dependencies `tailwindcss` and `@tailwindcss/cli`, pinned to the same exact 4.1.x version; confirm it with `pnpm view tailwindcss@4.1 version`)

**Interfaces:**
- Consumes: `AdminDetail`, `AdminItem`, `AdminConflict` (Task 4).
- Produces:

```ts
export interface RedlineAdminDetailProps {
  apiUrl: string
  id: string
  onBack?(): void                                            // shown below 1024px
  onStatusChanged(item: AdminItem, previous: AdminItem): void
  onGone(id: string): void
}
export function RedlineAdminDetail(p: RedlineAdminDetailProps): JSX.Element
```

- Test helpers in `tests/admin-ui.ts`:
  - `buildFixture()`: esbuild of `tests/fixture/admin.tsx`, plus CSS from `@tailwindcss/cli -i tests/fixture/admin.css`. `admin.css` imports Tailwind, adds `@source "../../component"`, and defines the shadcn color tokens.
  - `openAdmin(page, { view: 'detail' | 'inbox', id?, items, failList?, delayMs? })`: serves the fixture and a stateful fake of the Task 4 API through `page.route`, and returns `{ calls }` to record each request's method, URL and body.

- [ ] **Step 1: Write the failing tests** in `tests/admin-detail.spec.ts`. Freeze time with `page.clock` so the expiry text is exact.
  - `shows feedback, page link without the query, selector, element text, tester, version, user agent and "Deletes in 12 days"`
  - `screenshot opens in an in-page viewer and closes with Escape` (`role="dialog"`)
  - `no screenshot_url shows "Screenshot no longer available"`
  - `expired screenshot refetches once, then gives up`: the image route fails both times. Expect exactly 2 GETs of the item, then the message.
  - `each action PATCHes its status with expected_status_updated_at`: check the body for `Mark fixed`, `Defer` and `Dismiss`. `Reopen` is shown only when the status isn't `open`.
  - `409 shows "Changed elsewhere. Showing the latest." and renders the current status`
  - `a purged item shows the gone message`: a 404 on load, and a 404 on PATCH, each show `This feedback is no longer available.` and call `onGone`.
  - `Back shows only below 1024px`
- [ ] **Step 2: Run** `pnpm exec playwright test tests/admin-detail.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `RedlineAdminDetail`. It fetches `GET {apiUrl}/{id}` on mount and whenever `id` changes. The viewer is a fixed overlay with `role="dialog"` and `aria-modal`, closed by Escape, the close button or a backdrop click. The image's `onError` refetches the item at most once per `id`. "Deletes in N days" is `Math.ceil((expires_at - now) / 86_400_000)`. Actions are buttons at least 44px tall. Use the copy exactly as in Global Constraints.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: all pass.
- [ ] **Step 5: Commit:** `feat: admin inbox detail pane`

---

### Task 8: Inbox shell (list, filters, URL state, undo)

**Files:**
- Create: `component/redline-admin-inbox.tsx`, `tests/admin-inbox.spec.ts`
- Modify: `tests/fixture/admin.tsx` (the `inbox` view)

**Interfaces:**
- Consumes: `RedlineAdminDetail` (Task 7), `AdminListResponse` (Task 4), and the Task 7 test helpers.
- Produces: `export function RedlineAdminInbox({ apiUrl = '/api/admin/redlines' }: { apiUrl?: string }): JSX.Element`. URL state is `?status=&tester=&version=&id=`, kept with `history.pushState` (opening an item) and `history.replaceState` (changing a filter), plus a `popstate` listener. It uses no `next/navigation`, so it renders outside Next too. The spec's `basePath` prop is dropped, because the URL state uses the current path.

- [ ] **Step 1: Write the failing tests** in `tests/admin-inbox.spec.ts`, at 1280px unless marked 390.
  - `opens on Open with counts on every tab`: the tabs `Open`, `Deferred`, `Fixed`, `Dismissed` and `All` show counts from the response.
  - `tester and version filters narrow the list and land in the URL`
  - `Load more fetches the next cursor page and appends it`
  - `rows show the feedback's first lines, page, tester, version, relative time, a screenshot icon and a UX review badge`
  - `side by side at 1024+`: the detail pane's `x` is greater than the list's `x + width - 1`.
  - `?id= opens that item directly (390), and browser Back returns to the list`
  - `empty Open shows "No open feedback. New submissions from testers show up here."`
  - `failed load shows Retry, which recovers`
  - `loading shows skeleton rows` (`delayMs: 500`; `[data-skeleton]` is visible)
  - `Mark fixed moves the item out of Open, selects the next one and shows "Marked fixed · Undo"`
  - `Undo uses the timestamp from the first PATCH`: the second PATCH body's `expected_status_updated_at` equals the first response's `status_updated_at`, and the item is back in Open.
  - `Undo disappears after 5 seconds` (`page.clock.runFor(5000)`)
  - `counts update after a status change`
  - `no horizontal scroll at 390 with extreme fields`: a 2,000-character feedback, a 300-character path, and a null tester and version. Expect `document.documentElement.scrollWidth <= 390` and no text `null`.
  - `every button and row is at least 44px tall at 390`
- [ ] **Step 2: Run** `pnpm exec playwright test tests/admin-inbox.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `RedlineAdminInbox`.
  - Status changes are optimistic: on `onStatusChanged`, remove the row unless the tab is `All`, adjust the counts locally, then select the next row (or the previous one if it was last).
  - The undo bar holds the item returned by the first PATCH and PATCHes the previous status with that item's `status_updated_at`. It clears after 5,000 ms.
  - `onGone` removes the row.
  - Relative time uses `Intl.RelativeTimeFormat`.
  - The feedback preview uses `line-clamp-2`, and long paths use `truncate` with `min-w-0` parents.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: all pass.
- [ ] **Step 5: Commit:** `feat: admin inbox shell with filters, URL state and undo`

---

### Task 9: Docs, installer and full verification

**Files:**
- Modify: `README.md`, `AGENT-INSTALLATION.md`, `component/api-route-example.ts` header comment (only if it's out of date)

- [ ] **Step 1: Update `README.md`.**
  - Add an "Admin inbox" section: what it is, the two route files and the page, the `isAdmin` / `describeTesters` / `onRedlineCreated` hooks with what each must return, and the notification content rule.
  - In the Supabase setup steps, add: applying the inbox migration; deploying `redline-sync --no-verify-jwt`; `supabase secrets set REDLINE_SYNC_SECRET=<secret>`; and creating `.env.redline` with `REDLINE_REMOTE_URL` and `REDLINE_SYNC_SECRET`.
  - Replace the old `--env-file=.env ... pull` instructions.
  - Add `pnpm test:stack` / `pnpm test:all` to Development.
- [ ] **Step 2: Update `AGENT-INSTALLATION.md`.**
  - Step 6 copies `redline-handlers.ts`, `redline-admin-handlers.ts`, `redline-admin-types.ts`, `redline-admin-inbox.tsx` and `redline-admin-detail.tsx` as well.
  - Step 14 (Supabase): copy both admin route examples to `api/admin/redlines/route.ts` and `api/admin/redlines/[id]/route.ts`, plus `supabase/functions/redline-sync/`. Implement `isAdmin` from the host's own admin check. Create the admin page rendering `<RedlineAdminInbox />` inside the host's admin layout. Add `.env.redline` to `.gitignore`.
- [ ] **Step 3: Run the full suite.** `pnpm test:stack && pnpm test:all && pnpm typecheck`. Expected: every test passes with 0 skipped, and typecheck is clean.
- [ ] **Step 4: Check the spec against the build.** Read each spec section and confirm a passing test covers it.
- [ ] **Step 5: Commit:** `docs: admin inbox, sync function and CLI setup`
