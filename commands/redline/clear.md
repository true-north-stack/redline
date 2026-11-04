---
name: redline:clear
description: Clear all redlines (open, fixed, dismissed, deferred) from the file
allowed-tools:
  - Read
  - Write
  - Bash
---

Clear all redlines regardless of status.

## Process

1. Run `node redline/redline.mjs mode`. If the output starts with `remote`, tell the user this clears only the local file: rows in the inbox are untouched and expire through retention, and a later `pull` brings back any still there.
2. Read `redline/feedback.json` to count existing entries
3. Write an empty array `[]` to `redline/feedback.json`
4. Report the count cleared (e.g., "Cleared 5 redlines")

If the file doesn't exist or is already empty, report "No redlines to clear".
