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

Each redline object has: `id`, `page_url`, `element_selector`, `element_text`, `feedback`, `screenshot_path`, `status` (open|fixed|dismissed|deferred), `created_at`. `open` is the admin inbox's To Fix: feedback the owner has reviewed and wants fixed. An entry with any other status, including `review`, is never something to fix unless the user names its id. Newer items also carry `ux_review_requested`, `tester_id`, `app_version`, `user_agent` and `expires_at`.

Masked content appears as `[redacted]` in `element_text` and as black boxes in screenshots. Query values in `page_url` are saved as `…`. Don't try to recover any of it.

Run `node redline/redline.mjs mode` to see whether this project syncs with a remote inbox (`remote <host>`) or is local-only (`local`). Remote mode is set by `.env.redline` in the project root; `check` and `fix` pull first, and `fix` and `defer` push after. If `redline/redline.mjs` doesn't exist, the project predates remote sync: treat it as local mode and suggest re-running the install prompt from AGENT-INSTALLATION.md.

Pulled entries also carry `source`, `remote_host`, `remote_status` and `remote_status_updated_at`. Never edit `source`, `remote_host`, `remote_status` or `remote_status_updated_at` on any entry. The sync CLI owns them, and changing them breaks the next push or pull. Change only `status`.

Screenshots are stored in `redline/screenshots/` in the project root. When a redline has a screenshot, `screenshot_path` points to it (e.g., `redline/screenshots/{id}.png`). Read the screenshot when fixing to understand the visual context.

If the argument is `check` or empty, read and summarize open redlines.
If the argument is `fix`, find and fix each open redline in the codebase, then mark as fixed.
If the argument is `clear`, write an empty array to `redline/feedback.json`.
If the argument is `defer`, defer/list/undo deferred redlines.
If the argument is `ux-review`, run a UX Audit Framework review on the specified component or recent changes.
