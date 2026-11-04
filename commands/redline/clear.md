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

1. If `redline/redline.mjs` does not exist in the project root (check with `test -f redline/redline.mjs`), this project was installed before remote sync existed and is local-only: skip every sync step in this command, carry on exactly as below, and at the end suggest re-running the install prompt from AGENT-INSTALLATION.md (github.com/true-north-stack/redline) to get remote sync. Otherwise run `node redline/redline.mjs mode`. If the output starts with `remote`, tell the user this clears only the local file: rows in the inbox are untouched and expire through retention, and a later `pull` brings back any still there.
2. Read `redline/feedback.json` to count existing entries
3. Write an empty array `[]` to `redline/feedback.json`
4. Report the count cleared (e.g., "Cleared 5 redlines")

If the file doesn't exist or is already empty, report "No redlines to clear".
