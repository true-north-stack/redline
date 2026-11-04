---
name: redline:clear
description: Clear all redlines (open, fixed, dismissed, deferred) from the file
allowed-tools:
  - Read
  - Write
---

Clear all redlines regardless of status.

## Process

1. Read `redline/feedback.json` to count existing entries
2. Write an empty array `[]` to `redline/feedback.json`
3. Report the count cleared (e.g., "Cleared 5 redlines")

In remote mode (`node redline/redline.mjs mode` starts with `remote`), tell the user this clears only the local file. Rows in the inbox are untouched and expire through retention. A later `pull` brings back any that are still there.

If the file doesn't exist or is already empty, report "No redlines to clear".
