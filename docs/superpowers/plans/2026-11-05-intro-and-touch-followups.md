# Introduction and touch capture: follow-ups

Items the task and final reviews found and deliberately deferred past 1.3.0, kept here so they outlive the build ledger. None blocks the release.

- Task 1: minor (deferred): describeElement returns aria-label/alt of a masked element verbatim (name is shown only on the tester's own screen, never sent) — final review to triage
- Task 1: minor (deferred): aria-label not whitespace-collapsed; no tests for alt fallback / role=button
- Task 2: minor (deferred): keys are case-sensitive (Caps Lock makes them dead); unrequested preventDefault on the activating press; no tests for latest-callback or unmount cleanup
- Task 3: minor (deferred): initial focus on × shows a red ring that reads as highlighted (controller visual check) — prefer focusing Next
- Task 3: minor (deferred): touch tile resting frame — finger dot covers "Comment" chip label (intro.tsx:518, 629-630)
- Task 3: minor (deferred): desktop shared page height leaves ~110px gap on tester page 3 (deliberate; confirm)
- Task 3: minor (deferred): two-column touch tiles at 400-480px untested; overflow test checks dialog not root; #bbb/#dc2626 off-palette; iPhone UA matches /mac/
- Task 4: minor (deferred): `e instanceof PointerEvent` evaluated before type check (inspector:187)
- Task 4: minor (deferred): pre-existing noise "[redline] isAdmin failed" in test output
- Task 4: minor (deferred): area-mode interception untested on a drag that starts on a host element
- Task 5: minor (deferred): pen hover flips UI and drops the staged pick; describeElement errors swallowed silently; aria-live misses the first pick; bare span named "Section"; scroll test doesn't assert hostEvents; outline not rAF-throttled and can go stale
- Task 6: minor (deferred): detached JSDoc in redline-mask.ts:48-56; mask exclusion of Redline UI has no unit test; 20x20 boxes cover their own handles; pen tap clears a finger-drawn draft; Esc during "Capturing…" deactivates; sleep-based negative tests; "Done mid-draw" uses programmatic click
- Task 7: minor (deferred): fragile `${'${bundle}'}`.replace in tester-mode.spec.ts (use function replacement or direct interpolation); loose textarea-fit assertion, no desktop overflow assertion; touch-box.spec overrides iPhone 13 viewport; 500ms window swallows a deliberate backdrop tap right after opening
- Task 7: minor (deferred): elementShot not cleared on close (same-element re-pick may briefly show prior canvas); preview redraws on every render; element captures draw rounded corners square; area preview uncapped
- Task 8: minor (deferred): a hidden-but-connected host target gets no focus fallback (check activeElement after focus()); focus recording relies on intro's passive focus effect (add a comment); finger-closing-a-desktop-intro path untested; pre-existing isAdmin noise
- Task 8: minor (deferred): pill ? on very short viewports untested; a host that server-renders active=true can hit a hydration mismatch on touchUi/introOpen (hosts load the inspector client-only via dynamic import, as FLT does)
- Task 9: minor (deferred): update.md closing message has an uneven wrapped line (inside a code fence)
- Final: parked — S changes mode without telling the host, so a host tracking initialMode can go out of sync (pre-existing; fixing needs an onModeChange API) — Ruling: deferred to a later release, not a regression
- Final: minor (deferred): intro-flow tests use unscoped getByRole('dialog'); intro keeps "⌘ Enter sends" wording
- Final: parked — a blocked mode change still updates `seen`, so inspector mode and host initialMode can drift (same onModeChange API gap) — Ruling: deferred with the S/onModeChange item
- Final: minor (deferred): scope intro-flow getByRole('dialog') to .rl-intro-root; admin-detail role=dialog + data-redline-ui interplay undecided

Still to check on a real phone before release: iOS long-press on links, touch-action on the area overlay, 16px note text preventing focus zoom, whether the iOS keyboard covers the feedback box, and native scrolling (emulation can not prove these).
