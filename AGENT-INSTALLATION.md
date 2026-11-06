# Agent Installation

Copy the prompt below and paste it into [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Claude will handle the rest.

Requirements: a Next.js App Router project on Next.js 15.1 or later. The feedback route imports `after` from `next/server`, which 15.1 introduced.

Upgrading from 1.2.x: paste the same prompt. It adds `redline-intro.tsx` and `redline-touch.ts`, which the new inspector imports, and `redline-shortcuts.ts`, the keyboard shortcut hook, and passes the new `audience` prop.

Upgrading from 1.1.x: paste the same prompt. It replaces the commands and component files and adds the new ones (`redline-config.ts`, `redline-mask.ts` and the storage and handler files), which the new inspector imports. Local mode keeps working as before.

---

```
Install Redline from github.com/true-north-stack/redline into this project:

1. Clone https://github.com/true-north-stack/redline.git to /tmp/redline
2. Copy /tmp/redline/commands/redline.md to ~/.claude/commands/redline.md
3. Copy /tmp/redline/commands/redline/ directory to ~/.claude/commands/redline/
4. Copy /tmp/redline/VERSION to ~/.claude/commands/redline/VERSION
5. Copy /tmp/redline/docs/UX_AUDIT_FRAMEWORK.md to ~/.claude/docs/UX_AUDIT_FRAMEWORK.md (create ~/.claude/docs/ if needed)
6. Ask me where my React components live, then copy these from /tmp/redline/component/ there: redline-sidebar.tsx, redline-inspector.tsx, redline-intro.tsx, redline-touch.ts, redline-shortcuts.ts, redline-mask.ts, redline-config.ts, redline-storage.ts, redline-handlers.ts, redline-admin-handlers.ts, redline-admin-types.ts, redline-admin-inbox.tsx, redline-admin-detail.tsx
7. Wire the keyboard shortcuts. Find the component that holds the inspector's on/off state. If the project has no Redline key listener, call `useRedlineShortcuts(activate)` from redline-shortcuts.ts there, where `activate` takes the mode (`'element'` or `'area'`) and turns the inspector on in it. If it already has its own listener, leave it alone and tell me the hook exists. If that listener's keys differ from r, u and e, pass `shortcuts={false}` to the inspector so the introduction doesn't advertise keys that don't work
8. Check that the project's Next.js version is 15.1 or later (the feedback route imports `after` from next/server); if it is older, stop and tell me. Then ask me where my API routes live and copy /tmp/redline/component/api-route-example.ts there as redlines/route.ts
9. Copy /tmp/redline/redline.config.ts to my project root, and fix the relative imports in redline.config.ts and route.ts to match where the files landed
10. Pass the PHI selectors to the inspector wherever it's rendered: phiSelectors={redlineConfig.phiSelectors}. Also pass audience={redlineConfig.storage === 'supabase' ? 'tester' : 'developer'} there, so testers get the plain feedback wording and developers keep the selector and UX review options
11. Install modern-screenshot: run the project's package manager add command (e.g., pnpm add modern-screenshot or npm install modern-screenshot)
12. Add these lines to my .gitignore (if not already present): redline/feedback.json* (the trailing * also covers the CLI's temp file), redline/screenshots/ and .env.redline. If an older line reads exactly redline/feedback.json, replace it with redline/feedback.json*
13. Create the redline/ directory in my project root and copy /tmp/redline/scripts/redline.mjs into it
14. Install the update checker hook: copy /tmp/redline/.claude/hooks/redline-check-update.js to ~/.claude/hooks/redline-check-update.js, then add it to ~/.claude/settings.json under hooks.SessionStart (same pattern as existing hooks)
15. Ask me whether testers will use Redline on a deployed build. If yes: copy /tmp/redline/supabase/migrations/*.sql (renamed with new timestamps that keep their original order) and /tmp/redline/supabase/functions/redline-purge/ and /tmp/redline/supabase/functions/redline-sync/ into my supabase/ folder. Implement getTesterId() in route.ts from my server-side session. Copy /tmp/redline/component/api-admin-route-example.ts to api/admin/redlines/route.ts and /tmp/redline/component/api-admin-item-route-example.ts to api/admin/redlines/[id]/route.ts. In both files, fix the relative imports of redline.config, redline-storage and redline-admin-handlers to match where those files landed, and implement isAdmin in both from my own admin check (it must return null for non-admins). Create an admin page that renders <RedlineAdminInbox /> inside my existing admin layout. Make sure .env.redline is in .gitignore. Then ask me whether to set up my local Supabase stack, my hosted Supabase project, or both, and walk me through the matching Supabase setup steps in the Redline README: the steps for every database, then the local or hosted ones. Never run a command that writes to a hosted project (supabase db push, supabase functions deploy, supabase secrets set) unless I chose hosted and confirm that command. Don't change storage away from 'local' until I confirm.
16. Clean up: rm -rf /tmp/redline
17. Confirm setup is complete and show me how to use /redline
```
