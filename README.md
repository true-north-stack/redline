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

`redline/feedback.json` plus `redline/screenshots/`, written by your API route. Local storage never runs a purge on its own; to enforce retention, run:

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

1. Copy `supabase/migrations/*.sql` into your migrations (rename them with your own timestamps) and apply them.
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
5. Set `storage: 'supabase'` in `redline.config.ts`.

The migration schedules `redline-purge` daily at 03:17 UTC with pg_cron. It deletes expired screenshots through the Storage API, then the rows. Deleting from `storage.objects` in SQL would leave the files behind. Retention is stamped on each item as `expires_at` when it's saved, so changing `retentionDays` affects new feedback only.

To work through remote feedback with Claude, pull it into the local file first:

```bash
node --env-file=.env redline/redline.mjs pull   # needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
```

`/redline check`, `/redline fix` and the rest then work as usual. Status changes stay local.

## Development

```bash
pnpm install
pnpm test        # Playwright: PHI masking (real browser), local storage, CLI, URL sanitizing
pnpm typecheck
```

The Supabase tests run against a live stack when `REDLINE_SB_URL`, `REDLINE_SB_SECRET`, `REDLINE_SB_PUBLIC` and `REDLINE_SB_PURGE_SECRET` are set; see `tests/supabase.spec.ts`.

## Install

See **[AGENT-INSTALLATION.md](AGENT-INSTALLATION.md)** — paste the prompt into Claude Code and it handles everything.

MIT License
