# Agent Installation

Copy the prompt below and paste it into [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Claude will handle the rest.

---

```
Install Redline from github.com/true-north-stack/redline into this project:

1. Clone https://github.com/true-north-stack/redline.git to /tmp/redline
2. Copy /tmp/redline/commands/redline.md to ~/.claude/commands/redline.md
3. Copy /tmp/redline/commands/redline/ directory to ~/.claude/commands/redline/
4. Copy /tmp/redline/VERSION to ~/.claude/commands/redline/VERSION
5. Copy /tmp/redline/docs/UX_AUDIT_FRAMEWORK.md to ~/.claude/docs/UX_AUDIT_FRAMEWORK.md (create ~/.claude/docs/ if needed)
6. Ask me where my React components live, then copy these from /tmp/redline/component/ there: redline-sidebar.tsx, redline-inspector.tsx, redline-mask.ts, redline-config.ts, redline-storage.ts
7. Ask me where my API routes live, then copy /tmp/redline/component/api-route-example.ts there as redlines/route.ts
8. Copy /tmp/redline/redline.config.ts to my project root, and fix the relative imports in redline.config.ts and route.ts to match where the files landed
9. Pass the PHI selectors to the inspector wherever it's rendered: phiSelectors={redlineConfig.phiSelectors}
10. Install modern-screenshot: run the project's package manager add command (e.g., pnpm add modern-screenshot or npm install modern-screenshot)
11. Add these lines to my .gitignore (if not already present): redline/feedback.json and redline/screenshots/
12. Create the redline/ directory in my project root and copy /tmp/redline/scripts/redline.mjs into it
13. Install the update checker hook: copy /tmp/redline/.claude/hooks/redline-check-update.js to ~/.claude/hooks/redline-check-update.js, then add it to ~/.claude/settings.json under hooks.SessionStart (same pattern as existing hooks)
14. Ask me whether testers will use Redline on a deployed build. If yes, copy /tmp/redline/supabase/migrations/*.sql (renamed with new timestamps) and /tmp/redline/supabase/functions/redline-purge/ into my supabase/ folder, implement getTesterId() in route.ts from my server-side session, and walk me through the Supabase setup steps in the Redline README. Don't change storage away from 'local' until I confirm.
15. Clean up: rm -rf /tmp/redline
16. Confirm setup is complete and show me how to use /redline
```
