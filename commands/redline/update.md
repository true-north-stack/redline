---
name: redline:update
description: Update Redline to latest version from GitHub
allowed-tools:
  - Bash
  - Read
  - Write
  - AskUserQuestion
  - WebFetch
---

# Redline Update

Update Redline from the GitHub repository (github.com/true-north-stack/redline).

## Step 1: Check versions

Read the installed version:
```bash
cat ~/.claude/commands/redline/VERSION 2>/dev/null || echo "0.0.0"
```

Fetch the latest version from GitHub:
```bash
curl -sL https://raw.githubusercontent.com/true-north-stack/redline/main/VERSION
```

**If installed == latest:**
```
## Redline Update

**Installed:** X.Y.Z
**Latest:** X.Y.Z

You're already on the latest version.
```
Exit.

## Step 2: Show what's new and confirm

Fetch the CHANGELOG from GitHub:
```bash
curl -sL https://raw.githubusercontent.com/true-north-stack/redline/main/CHANGELOG.md
```

Display changes between installed and latest versions. If no CHANGELOG exists yet, just show the version diff.

```
## Redline Update Available

**Installed:** X.Y.Z
**Latest:** A.B.C

### What's New
(changelog entries between versions, or "See GitHub for details" if no changelog)

The update will replace:
- `~/.claude/commands/redline.md` (router)
- `~/.claude/commands/redline/` (all subcommands)
- `~/.claude/hooks/redline-check-update.js` (update hook)
- `~/.claude/docs/UX_AUDIT_FRAMEWORK.md` (UX framework)

Your project's Redline files (the components, the API routes and `redline/redline.mjs`) will NOT be updated automatically. If the new release changes any of them, you'll be told how to update them.
```

Ask the user: "Proceed with update?" with options "Yes, update now" and "No, cancel".

If cancelled, exit.

## Step 3: Run update

```bash
# Clone latest to temp directory
rm -rf /tmp/redline && git clone https://github.com/true-north-stack/redline.git /tmp/redline
```

Copy updated files:
```bash
# Commands
cp /tmp/redline/commands/redline.md ~/.claude/commands/redline.md
cp /tmp/redline/commands/redline/*.md ~/.claude/commands/redline/

# VERSION
cp /tmp/redline/VERSION ~/.claude/commands/redline/VERSION

# Hook
cp /tmp/redline/.claude/hooks/redline-check-update.js ~/.claude/hooks/redline-check-update.js 2>/dev/null || true

# UX Audit Framework
mkdir -p ~/.claude/docs
cp /tmp/redline/docs/UX_AUDIT_FRAMEWORK.md ~/.claude/docs/UX_AUDIT_FRAMEWORK.md 2>/dev/null || true
```

Check whether this project's Redline files differ from the new release. Run this from the project root, before the clean-up below deletes /tmp/redline. The installed components live wherever the installer put them, so find them by the inspector's file name:

```bash
COMPONENTS="$(dirname "$(find . -name redline-inspector.tsx -not -path '*/node_modules/*' -print -quit)")"
CHANGED=""
for f in redline-sidebar.tsx redline-inspector.tsx redline-intro.tsx redline-touch.ts redline-shortcuts.ts redline-mask.ts redline-config.ts redline-storage.ts redline-handlers.ts redline-admin-handlers.ts redline-admin-types.ts redline-admin-inbox.tsx redline-admin-detail.tsx; do
  # A file missing from the project counts as changed: the new release needs it
  cmp -s "$COMPONENTS/$f" "/tmp/redline/component/$f" || CHANGED="$CHANGED $f"
done
cmp -s redline/redline.mjs /tmp/redline/scripts/redline.mjs || CHANGED="$CHANGED redline/redline.mjs"
echo "Changed or missing:${CHANGED:- none}"
```

If no `redline-inspector.tsx` is found, the project doesn't have the components installed; say so and skip this check.

Clear the update cache:
```bash
rm -f ~/.claude/cache/redline-update-check.json
```

Clean up:
```bash
rm -rf /tmp/redline
```

## Step 4: Display result

```
+--------------------------------------------------+
|  Redline Updated: vX.Y.Z -> vA.B.C              |
+--------------------------------------------------+

Restart your session to pick up new commands.
```

If the check listed any changed or missing files, add:
```
Redline's project files changed upstream: <the list from the check>.
To update them, re-run the install prompt from AGENT-INSTALLATION.md in this project.
Don't copy redline-inspector.tsx on its own: the new inspector imports redline-config.ts,
redline-mask.ts, redline-intro.tsx and redline-touch.ts, so copying it alone breaks the build. The install prompt copies the
full set, including the redline-shortcuts.ts hook, and keeps local mode working.
```
