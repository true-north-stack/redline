---
name: redline:defer
description: Defer a redline by number, or list all deferred redlines
argument-hint: "<number|list|undo number>"
allowed-tools:
  - Read
  - Write
  - Bash
---

# Redline Defer

Storage: `redline/feedback.json` in the project root.

Never edit `source`, `remote_host`, `remote_status` or `remote_status_updated_at` on any entry. The sync CLI owns them, and changing them breaks the next push or pull. Change only `status`.

## If argument is "list"

Show all deferred redlines with their UUIDs (so user can reference them directly in `/redline:fix`):

1. Read `redline/feedback.json`
2. Filter to entries where `status === 'deferred'`
3. Sort by `created_at` ascending
4. Display each with a row number, UUID, page_url, element_selector, feedback, and created_at

Display each with its UUID so the user can do `/redline:fix <uuid>` directly without undeferring first.

## If argument is a number

Defer an open redline by its position in the open list:

1. Read `redline/feedback.json`
2. Filter to entries where `status === 'open'`, sort by `created_at` ascending
3. Find the entry at position N (1-based)
4. Update its `status` to `'deferred'`
5. Write the updated array back to `redline/feedback.json`
6. Confirm which redline was deferred

## If argument is "undo" followed by a number

Reopen a deferred redline by its position in the deferred list:

1. Read `redline/feedback.json`
2. Filter to entries where `status === 'deferred'`, sort by `created_at` ascending
3. Find the entry at position N (1-based)
4. Update its `status` to `'open'`
5. Write the updated array back to `redline/feedback.json`
6. Confirm which redline was reopened

## After any change

If `redline/redline.mjs` does not exist in the project root (check with `test -f redline/redline.mjs`), this project was installed before remote sync existed and is local-only: skip every sync step in this command, carry on exactly as below, and at the end suggest re-running the install prompt from AGENT-INSTALLATION.md (github.com/true-north-stack/redline) to get remote sync.

Otherwise, after deferring or reopening, if `node redline/redline.mjs mode` prints `remote`, run `node redline/redline.mjs push` as the last step and relay any `Conflict on` lines. Skip this for `list`.
