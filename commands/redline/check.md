---
name: redline:check
description: Check redlines waiting to be fixed (in-app dev feedback) and summarize what needs attention
allowed-tools:
  - Read
  - Bash
---

Query all redlines waiting to be fixed (status `open`, the admin inbox's To Fix) from `redline/feedback.json` in the project root and present a summary.

## Process

0. If `redline/redline.mjs` does not exist in the project root (check with `test -f redline/redline.mjs`), this project was installed before remote sync existed and is local-only: skip every sync step in this command, carry on exactly as below, and at the end suggest re-running the install prompt from AGENT-INSTALLATION.md (github.com/true-north-stack/redline) to get remote sync. Otherwise run `node redline/redline.mjs mode`. If the output starts with `remote`, run `node redline/redline.mjs pull` and relay any `Discarded local change` and `Removed` lines to the user. If it prints `local`, skip this step.

1. Read `redline/feedback.json` from the project root using the Read tool
2. Parse the JSON array
3. Filter to entries where `status === 'open'`
4. Sort by `created_at` ascending

For each open redline, show:
1. Number (row position in the open list, for use with `/redline:defer`)
2. Page URL
3. Element selector
4. Feedback text
5. When it was left

End with a count: "X redlines to fix"

If the file doesn't exist or is empty, report "0 redlines to fix".
