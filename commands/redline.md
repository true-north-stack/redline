---
name: redline
description: Manage in-app dev feedback (redlines). Routes to check/fix/clear/defer/ux-review or defaults to check.
argument-hint: "<check|fix|clear|defer|ux-review|update>"
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - Agent
---

Route to the appropriate redline subcommand based on the argument:

- `check` or no argument → run `/redline:check`
- `fix` → run `/redline:fix`
- `clear` → run `/redline:clear`
- `defer` → run `/redline:defer`
- `ux-review` → run `/redline:ux-review`
- `update` → run `/redline:update`

Storage: `redline/feedback.json` in the project root — a JSON array of redline objects.

Each redline object has: `id`, `page_url`, `element_selector`, `element_text`, `feedback`, `screenshot_path`, `status` (open|fixed|dismissed|deferred), `created_at`. Newer items also carry `ux_review_requested`, `tester_id`, `app_version`, `user_agent` and `expires_at`.

Masked content appears as `[redacted]` in `element_text` and as black boxes in screenshots. Query values in `page_url` are saved as `…`. Don't try to recover any of it.

If the project stores redlines in Supabase (`storage: 'supabase'` in `redline.config.ts`), run `node --env-file=.env redline/redline.mjs pull` first to copy them into `redline/feedback.json`.

Screenshots are stored in `redline/screenshots/` in the project root. When a redline has a screenshot, `screenshot_path` points to it (e.g., `redline/screenshots/{id}.png`). Read the screenshot when fixing to understand the visual context.

If the argument is `check` or empty, read and summarize open redlines.
If the argument is `fix`, find and fix each open redline in the codebase, then mark as fixed.
If the argument is `clear`, write an empty array to `redline/feedback.json`.
If the argument is `defer`, defer/list/undo deferred redlines.
If the argument is `ux-review`, run a UX Audit Framework review on the specified component or recent changes.
