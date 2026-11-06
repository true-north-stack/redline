# First-run Introduction and Touch Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A first-run introduction modal for testers and developers, real touch capture in the inspector (tap-to-stage picks with Smaller/Bigger/Comment, touch area drawing with corner handles, a bottom control bar), and a tester-facing feedback box, released later as Redline 1.3.0.

**Architecture:** Pure DOM helpers for touch picking go in a new `redline-touch.ts`, the modal in a new `redline-intro.tsx`, and the triple-tap listener in a new `redline-shortcuts.ts`. The inspector (`redline-inspector.tsx`) moves its mouse handlers onto pointer events, grows a touch UI (bottom bar, staged pick, area draft) chosen per interaction by `pointerType`, takes an `audience` prop for tester wording, and opens the introduction on first activation.

**Tech Stack:** React 19 client components with inline styles (the inspector's existing style; no Tailwind in the inspector or intro), TypeScript 5.9, Playwright 1.55 with esbuild-bundled fixtures, Chromium plus WebKit with iPhone 13 emulation.

**Spec:** `docs/superpowers/specs/2026-11-05-intro-and-touch-design.md`. The clickable mockup at `docs/superpowers/specs/assets/2026-11-05-intro-mockup.html` is the visual reference for the desktop introduction: spacing, colors, animation timing and copy.

## Global Constraints

- Branch `feat/intro-and-touch`, based on 1.2.1 (`80e647e`). Never push. Never touch VERSION; the release bump is separate.
- Copy-in files must stay client-safe and dependency-free beyond what hosts already install (`react`, `lucide-react`, `modern-screenshot`). No new runtime dependencies.
- Every new or changed component passes `pnpm -s lint` (eslint-config-next 16 with React Compiler rules) and `pnpm -s typecheck` with no disables except where an existing pattern already justifies one.
- Colors: `#1a1a1a` panel, `#111` inset, `#333` borders, `#ef4444` accent, text `#eee` / `#aaa` / `#888`. Touch targets at least 44px tall.
- Every Redline-rendered root element carries `data-redline-ui`, so inspector handlers ignore it.
- Desktop must not get worse: hover outline (dashed, solid when selected), click to select, `S`, `Esc` and Cmd+Enter keep working exactly as today. The full existing suite must keep passing.
- Copy uses plain words, no em-dashes, and never the word "inbound".
- `localStorage` key `redline:intro:v1`. Every storage access is wrapped in try/catch.
- Tests run with `pnpm test:all` (needs `pnpm test:stack` once). Touch tests run on Chromium with touch emulation and on WebKit with `devices['iPhone 13']`.

## Review Focus

1. A tap that lands on Redline's own bottom bar or intro must never stage a pick or reach the page. Expect Redline's control to work and the page to see nothing. Tested in Task 5.
2. A tap on a link while the inspector is on must not navigate. Expect the link to be staged, and the URL unchanged. Tested in Task 5.
3. Turning Redline off mid-pick, or mid-drag on touch, must leave no overlay, outline, scroll lock or bar behind. Tested in Tasks 5 and 6.
4. A mouse used after a touch on the same device (a touchscreen laptop) must show the desktop pill and hover outline again. Tested in Task 5.
5. With storage blocked (`localStorage` throws), the introduction still opens on activation, closes normally, and the inspector works. Tested in Task 3.

---

### Task 1: Touch picking helpers

**Files:**
- Create: `component/redline-touch.ts`
- Create: `tests/fixture/touch-helpers.ts` (esbuild entry exposing the helpers on `window.__touch`)
- Test: `tests/touch-helpers.spec.ts`

**Interfaces:**
- Consumes: `redactedText(el: HTMLElement, selectors: string[], maxLength: number): string | null` from `component/redline-mask.ts`.
- Produces:
  - `export const TAP_SLOP_PX = 10`
  - `export function isMeaningful(el: Element): boolean`: true for `button`, `a[href]`, `input`, `select`, `textarea`, `label`, `li`, `summary`, `img`, and any element with a `role` attribute other than `presentation` or `none`.
  - `export function pickPath(touched: Element): HTMLElement[]`: candidates from the touched element up to (not including) `body`, innermost first. Returns `[]` if `touched` is inside `[data-redline-ui]`. It skips `html`, `body`, and elements at least 90% of the viewport in both width and height. It collapses runs of same-box elements (every edge within 1px). Each run keeps its outermost meaningful element if it has one, otherwise its innermost element.
  - `export function defaultPickIndex(path: HTMLElement[]): number`: the index of the first meaningful element, or `0`.
  - `export function describeElement(el: HTMLElement, masks: string[]): string`: `"<Kind>: <name>"`, or just `"<Kind>"` when there is no name.
    - Kind: `Button` (a `button`, or `role="button"`), `Link` (`a`), `Field` (`input`, `select`, `textarea`), `Label`, `List item` (`li`), `Image` (`img`), `Heading` (`h1` to `h6`), `Text` (`p`). Otherwise it is the `role` value with its first letter capitalized, else `Section`.
    - Name: `aria-label`, then `alt` for `img`, then the visible text from `redactedText(el, masks, 40)` with whitespace collapsed. A name longer than 40 characters ends in `…`.

- [ ] **Step 1: Write the failing tests** in `tests/touch-helpers.spec.ts`. Each one loads a page whose markup is given inline and calls the helpers through `window.__touch`.
  - `pickPath climbs from a span inside a button, and the default pick is the button`: in `<div id="card" style="padding:16px"><button id="save"><span id="label">Save invoice</span></button></div>`, the path from `#label` has ids `['label','save','card']`, and `defaultPickIndex` points at `save`.
  - `same-box wrappers collapse to one step`: with `<div id="outer"><div id="inner" style="padding:8px"><p id="t">Hi</p></div></div>`, where outer and inner have the same box, the path from `#t` holds exactly one of `outer`/`inner`, and that is `inner`.
  - `a same-box run keeps its meaningful element`: in `<a id="link" href="/x" style="display:block"><div id="wrap">Go</div></a>`, the path from `#wrap` contains `link` and not `wrap`.
  - `nothing inside Redline UI is pickable`: for `<div data-redline-ui><button id="b">x</button></div>`, `pickPath(#b)` is `[]`.
  - `full-viewport containers are skipped`: a `div` sized `100vw x 100vh` never appears in the path.
  - `describeElement names things in plain words`: the button gives `"Button: Save invoice"`, `<a href="/c">Clients</a>` gives `"Link: Clients"`, `<input aria-label="Search clients">` gives `"Field: Search clients"`, `<h1>Dashboard</h1>` gives `"Heading: Dashboard"`, an empty `<div>` gives `"Section"`, and `<div role="dialog" aria-label="Edit">` gives `"Dialog: Edit"`.
  - `describeElement never shows masked text`: `<button><span data-phi>Jane Doe</span></button>` gives a string that doesn't contain `Jane`.
  - `long names are cut at 40 characters`: a button whose text is 60 `x` characters gives a name of 40 characters ending in `…`.

- [ ] **Step 2: Run them to see them fail.** `npx playwright test tests/touch-helpers.spec.ts`. Expect a FAIL because the module doesn't exist.

- [ ] **Step 3: Implement `component/redline-touch.ts`** with the signatures above. The fixture entry is `import * as t from '../../component/redline-touch'; (window as any).__touch = t`, bundled the same way `tests/fixture/app.tsx` is.

- [ ] **Step 4: Run the tests and see them pass.** Then run `pnpm -s typecheck && pnpm -s lint`, which must be clean.

- [ ] **Step 5: Commit.** `git add component/redline-touch.ts tests/fixture/touch-helpers.ts tests/touch-helpers.spec.ts && git commit -m "feat: touch picking helpers (meaningful target, pick path, plain-words names)"`

### Task 2: Shortcut hook

**Files:**
- Create: `component/redline-shortcuts.ts`
- Create: `tests/fixture/shortcuts.tsx` (renders a small component that calls the hook and writes the activations to `window.__activations`)
- Test: `tests/shortcuts.spec.ts`

**Interfaces:**
- Produces: `export function useRedlineShortcuts(onActivate: (mode: 'element' | 'area') => void, options?: { enabled?: boolean }): void`
  - `r` or `u` pressed three times within 500ms calls `onActivate('element')`. `e` pressed three times calls `onActivate('area')`.
  - Presses are ignored when the target is an `input`, `textarea`, `select` or contentEditable element, when Meta, Ctrl or Alt is held, and when `e.repeat` is set. Mixing keys resets the count.
  - `enabled: false` attaches no listener. The listener is on `document`, uses the latest `onActivate` (through a ref updated in a layout effect), and is removed on unmount.

- [ ] **Step 1: Write the failing tests.**
  - `rrr, uuu and eee activate element, element and area`.
  - `three presses slower than 500ms in total do nothing`: press, wait 300ms, press, wait 300ms, press, and `__activations` is empty.
  - `typing rrr in an input does nothing`.
  - `Cmd+R and key repeat do nothing`.
  - `mixed keys reset the count`: `r r e` gives nothing, then `e e` makes `e e e` and gives `['area']`.
  - `enabled false listens to nothing`.
- [ ] **Step 2: Run them to see them fail.** `npx playwright test tests/shortcuts.spec.ts`. Expect a FAIL.
- [ ] **Step 3: Implement the hook.**
- [ ] **Step 4: Run them to see them pass.** Lint and typecheck must be clean.
- [ ] **Step 5: Commit.** `feat: useRedlineShortcuts, the documented triple-tap keys as a hook`

### Task 3: Introduction modal

**Files:**
- Create: `component/redline-intro.tsx`
- Create: `tests/fixture/intro.tsx`, which renders `<RedlineIntro {...window.__INTRO_PROPS__} onClose={() => (window.__introClosed = (window.__introClosed ?? 0) + 1)} />`
- Test: `tests/intro.spec.ts`

**Interfaces:**
- Produces:
  - `export const INTRO_STORAGE_KEY = 'redline:intro:v1'`
  - `export function introDismissed(): boolean`: true only when storage reads `'1'`. It returns false if storage throws.
  - `export function dismissIntro(): void`: writes `'1'` and swallows errors.
  - `export interface RedlineIntroProps { audience: 'tester' | 'developer'; touch: boolean; shortcuts: boolean; onClose(): void }`
  - `export function RedlineIntro(props: RedlineIntroProps)`: a `role="dialog"` element with `aria-modal="true"`, `aria-labelledby` pointing at the page title, and `data-redline-ui` on the root.
- Pages and their exact copy. These are verbatim strings for both the tests and the UI.
  - **Desktop page 1.** Title `Point at what you mean`. Text `Pick one thing on the page, or a whole region.` Element tile caption `Element. Hover, then click.` Area tile caption `Area. Drag a box.` Hint `Press S to switch between them.`
    - Element animation: as mockup draft 4, a dashed outline moves across three elements and turns solid on the click.
    - Area animation: a dashed box being dragged.
  - **Desktop page 2.** Title `Say what's wrong`. The text depends on the audience:
    - Tester: `A box opens with a screenshot attached. Write what you expected to see.`
    - Developer: `A box opens for your note. Tick Include Screenshot to attach what you picked.`
    - Hint: `⌘ Enter sends. Esc backs out.`, where `⌘` becomes `Ctrl` unless `navigator.platform` or the user agent says Mac.
    - Tester only: `Don't type client names or details. Anything private on screen is blacked out before it's sent.`
  - **Desktop page 3.** Shown only when `shortcuts` is true. Title `Next time, use the keyboard`. Text `Tap a letter three times quickly, anywhere outside a text field.` Three rows, each a key and what it does:
    - `R R R`: `Pick an element (or U U U with your left hand)`
    - `E E E`: `Drag an area`
    - `Esc`: `Turn Redline off`
    - Last line, developer: `Then run /redline fix in Claude Code and it works through them.` Tester: `Every note goes to the team, who read each one.`
  - **Touch page 1.** Title `Point at what you mean`. Text `Tap one thing on the page, or draw a box around a region.`
    - Element tile caption `Element. Tap it, then Bigger for the whole thing.` It animates three frames in a loop: a finger dot taps an inner element and a solid outline appears, a "Bigger" chip pulses and the outline grows to its card, then a "Comment" chip pulses.
    - Area tile caption `Area. Switch to Area, then drag a box.` A finger dot drags out a dashed box.
  - **Touch page 2.** Same as desktop page 2, without the keyboard hint.
- Chrome:
  - **Header:** a red dot, `Redline`, and an `×` button with `aria-label="Close"`.
  - **Footer:** a checkbox labelled `Don't show this again`, page dots, `Back` (hidden on page 1), and `Next`, which reads `Start` on the last page.
- Closing:
  - Start, × and Esc all call `onClose()`. If the checkbox is ticked at that moment, `dismissIntro()` is called first.
  - Esc is handled on the dialog with `stopPropagation()` and `preventDefault()`, so it never reaches the inspector's handler.
  - Focus moves to the first button when the dialog opens, and Tab and Shift+Tab cycle inside it.
- Reduced motion: under `prefers-reduced-motion: reduce`, nothing animates and every tile shows its final frame. The captions are always visible, so they carry the meaning without the motion.
- Layout: centered over a `rgba(0,0,0,0.5)` backdrop, `width: min(440px, calc(100vw - 32px))`, at most `calc(100dvh - 32px)` tall with its own scroll. Touch tiles stack in one column below 400px.

- [ ] **Step 1: Write the failing tests.**
  - `desktop shows three pages in order, and Start closes`: check each title and Next/Back, check that Back is hidden on page 1, that the last button reads `Start`, and that clicking it makes `__introClosed === 1`.
  - `tester and developer wording differ where the spec says`: on page 2, the tester sees the privacy line and the "screenshot attached" text, and the developer sees "Tick Include Screenshot". On page 3, each gets its own last line.
  - `shortcuts false skips the keyboard page`: page 2's button reads `Start`.
  - `touch shows two pages and no keyboard hints`: no text matches `/Enter|Esc|S to switch|R R R/`.
  - `Don't show this again persists only when ticked`: close unticked and `introDismissed()` is false. Tick, close, and `localStorage['redline:intro:v1'] === '1'`.
  - `blocked storage still opens and closes`: an init script makes `localStorage` getters throw. The dialog still renders, `introDismissed()` returns false, and closing still calls `onClose`.
  - `Esc closes and does not bubble`: a window `keydown` listener in the bubble phase never sees the Escape.
  - `focus stays inside the dialog`: Tab ten times, and `document.activeElement` stays inside `[role=dialog]`.
  - `reduced motion: nothing animates`: with `page.emulateMedia({ reducedMotion: 'reduce' })`, `document.getAnimations().length === 0` and the captions are visible.
  - `fits a 390px screen`: with the viewport at 390x844, the dialog's bounding box is inside the viewport and `scrollWidth <= clientWidth` on the root.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement `component/redline-intro.tsx`.** Use inline styles and CSS keyframes in a scoped `<style>` element whose class names are prefixed `rl-intro-`. Port the mockup's markup and keyframes, with no Tailwind.
- [ ] **Step 4: Run them to see them pass.** Lint and typecheck must be clean.
- [ ] **Step 5: Commit.** `feat: first-run introduction modal, desktop and touch, tester and developer wording`

### Task 4: Inspector on pointer events, with earlier interception

**Files:**
- Modify: `component/redline-inspector.tsx`, the element-mode effect (about lines 163-217) and the area-mode effect (about lines 263-328)
- Modify: `tests/fixture/app.tsx`. Unless `props.showIntro` is true, it sets `localStorage['redline:intro:v1'] = '1'` (inside try/catch) before rendering, so existing tests never see the introduction. It also forwards every prop.
- Test: `tests/inspector-pointer.spec.ts`

**Interfaces:**
- Produces, inside the inspector, for later tasks:
  - State `touchUi: boolean`. On activation it is set from `window.matchMedia('(pointer: coarse)').matches`, in the existing render-time activation block, guarded with `typeof window`. Every `pointerdown` sets it to `e.pointerType === 'touch'`.
  - Element mode listens to `pointermove` for hover, but only when `pointerType === 'mouse'`. Selecting happens on `pointerup` for mouse.
  - `pointerdown`, `mousedown`, `touchstart` and `click` are captured on `document`. The `touchstart` listener is passive, with stopPropagation only, so scrolling still works. For any target outside `[data-redline-ui]`, the handler calls `stopPropagation()`, and also `preventDefault()` for everything except touchstart.
  - Area mode moves to `pointerdown`/`pointermove`/`pointerup` on the existing interaction overlay with `setPointerCapture`, and uses `pointercancel` to reset. A mouse pointerup captures straight away, as today.

- [ ] **Step 1: Write the failing tests.**
  - `the page never sees pointerdown, mousedown or click on what is picked`: the host page registers listeners on `#save` for `pointerdown`, `mousedown` and `click` that push to `window.__hostEvents`. Click `#save` with the inspector on, and `__hostEvents` stays empty while the feedback box opens.
  - `desktop still works as before`: hovering shows the dashed outline, the click selects with a solid outline, S toggles to area, a mouse drag of 100x80 opens the box with a preview, and Esc steps back. Look these up in the existing tests and reuse their selectors.
- [ ] **Step 2: Run them to see them fail.** The pointerdown check fails today, because only click is intercepted.
- [ ] **Step 3: Implement the pointer-event refactor.**
- [ ] **Step 4: Run them to see them pass, along with the full existing suite.** Run `pnpm test:all`. All tests must pass.
- [ ] **Step 5: Commit.** `refactor: inspector on pointer events; intercept pointerdown, mousedown and touchstart`

### Task 5: Touch element picking and the bottom bar

**Files:**
- Modify: `component/redline-inspector.tsx`
- Modify: `playwright.config.ts`. Add the project `{ name: 'webkit-iphone', use: { ...devices['iPhone 13'] }, testMatch: /touch.*\.spec\.ts|intro-flow\.spec\.ts/ }`. Keep chromium as it is: chromium runs every spec, and touch specs set `hasTouch` and `isMobile` themselves with `test.use`.
- Test: `tests/touch-pick.spec.ts`

**Interfaces:**
- Consumes: Task 1's `pickPath`, `defaultPickIndex`, `describeElement` and `TAP_SLOP_PX`, and Task 4's `touchUi` and interception.
- Produces:
  - State `staged: { path: HTMLElement[]; index: number } | null`.
  - **Tap detection:** remember the pointerdown point. Moving more than `TAP_SLOP_PX` or a `pointercancel` drops it. A touch `pointerup` within the slop stages `pickPath(elementFromPoint(x, y))` at `defaultPickIndex`. Tapping elsewhere replaces the staged pick.
  - **Outline:** the staged element gets a solid `#ef4444` outline with a 150ms transition on its box.
  - **Touch bottom bar** (`data-testid="redline-touch-bar"`, `data-redline-ui`):
    - Placement: fixed to the bottom, full width, padded by `env(safe-area-inset-bottom)`, and replacing the top pill whenever `touchUi` is true.
    - **No pick staged:** a segmented switch with `Element` and `Area` (`aria-pressed`), a `?` button with `aria-label="Show introduction"` (it does nothing until Task 8), and `Done`, which calls `onDeactivate`.
    - **A pick staged:** the pick's name (`data-testid="redline-pick-name"`, from `describeElement(el, masks)`), then `Smaller`, `Bigger`, a large red `Comment`, and `Cancel`.
      - Smaller and Bigger change the index and are disabled at the ends of the path.
      - Comment calls `setSelectedEl(path[index])` and clears `staged`, so the existing screenshot effect and feedback box take over.
      - Cancel clears `staged`.
  - **Desktop pill:** gains a `?` button with `aria-label="Show introduction"`.

- [ ] **Step 1: Write the failing tests.** Use `test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })` on chromium, and the webkit-iphone project picks the file up too. The page has a card containing a button, which contains a span reading `Save invoice`, plus a link `<a id="nav" href="/elsewhere">Clients</a>` and enough content below to scroll.
  - `tap on the label stages the button and names it`: tap `#label`, and the bar reads `Button: Save invoice`.
  - `Bigger grows to the card, Smaller comes back, both disable at the ends`.
  - `Comment opens the feedback box for the staged element`.
  - `a scroll gesture selects nothing`: swipe up 200px with touch (CDP `Input.dispatchTouchEvent` on chromium, `page.touchscreen` plus moves on webkit). After it, no bar name shows and `window.scrollY > 0`.
  - `tapping a link stages it and does not navigate`: the URL stays the same.
  - `tapping Redline's own bar never reaches the page`: tapping `Done` turns Redline off and the host listeners stay empty.
  - `Done mid-pick leaves nothing behind`: no `[data-redline-ui]` remains, and `document.body.style.overflow` and touch-action are restored.
  - `a mouse after a touch brings back the pill and hover`: tap once, press Cancel, then move the mouse. The pill text `Select Element` is visible and the bar is gone.
  - `every touch control is at least 44px tall`.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement the touch pick flow.**
- [ ] **Step 4: Run them to see them pass on both projects.** Run `npx playwright test tests/touch-pick.spec.ts`. Then run `pnpm test:all`, and everything must pass.
- [ ] **Step 5: Commit.** `feat: touch picking: tap to stage, Smaller/Bigger/Comment, bottom bar with Done`

### Task 6: Touch area drawing with corner handles

**Files:**
- Modify: `component/redline-inspector.tsx`
- Test: `tests/touch-area.spec.ts`

**Interfaces:**
- Consumes: Task 4's pointer-based area code and Task 5's bar.
- Produces:
  - State `areaDraft: AreaRect | null`, for touch only.
  - **Drawing:** in Area mode on touch, the overlay has `touch-action: none` and the bar hint reads `Drag to draw a box.`. A one-finger drag of at least 20x20 sets `areaDraft` and doesn't capture yet.
  - **Handles:** four corner handles (`data-redline-handle="nw"|"ne"|"sw"|"se"`), each with a 44x44 hit area. Dragging a handle moves its corner.
  - **Bar after drawing:** the hint becomes `Adjust the corners, then Comment.`, with `Comment` (calls `captureArea(areaDraft)`) and `Cancel` (clears the draft).
  - **Leaving Area:** switching back to Element, or pressing Done, clears the draft and restores scrolling. A mouse drag keeps today's immediate capture.

- [ ] **Step 1: Write the failing tests** on the same two projects.
  - `drag draws a box, Comment opens the box with a preview`.
  - `a handle drag resizes the box`: the `se` handle moved +40,+30 grows the draft by 40x30, give or take 2px.
  - `a drag under 20px draws nothing`.
  - `the page does not scroll while drawing`: `scrollY` is unchanged after the drag.
  - `Done mid-draw restores scrolling`: after Done, a swipe scrolls the page again.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement the touch area flow.**
- [ ] **Step 4: Run them to see them pass on both projects**, then run `pnpm test:all`.
- [ ] **Step 5: Commit.** `feat: touch area capture with corner handles`

### Task 7: Tester wording in the feedback box

**Files:**
- Modify: `component/redline-inspector.tsx`, the props and the feedback modal (about lines 686-933)
- Test: `tests/tester-mode.spec.ts`

**Interfaces:**
- Produces new `RedlineInspectorProps`:
  - `audience?: 'tester' | 'developer'`, defaulting to `'developer'`.
  - `shortcuts?: boolean`, defaulting to `true` and passed on to the introduction in Task 8.
- Tester wording:
  - **Title:** `What's wrong here?` for both element and area.
  - **Hidden:** the element selector block, the area dimensions line, the `Request UX Review` checkbox, and the `Cmd+Enter to submit · Esc to cancel` hint.
  - **Screenshot:** an element pick starts with `includeScreenshot` true once its capture succeeds. If the capture drops, the existing dropped message shows and the box stays unticked.
- Developer wording: unchanged.
- Both audiences: submitting with Ctrl+Enter now works as well as Cmd+Enter (`e.metaKey || e.ctrlKey`).

- [ ] **Step 1: Write the failing tests.**
  - `tester box: plain title, no selector, no UX review, no keyboard hint`.
  - `tester element pick has Include Screenshot ticked and sends a screenshot`: intercept the POST and expect `screenshot` in the form.
  - `developer box is unchanged`: title `Redline Feedback`, the selector is visible, `Request UX Review` is present, and Include Screenshot is unticked.
  - `Ctrl+Enter submits`.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement tester wording.**
- [ ] **Step 4: Run them to see them pass**, then run `pnpm test:all`.
- [ ] **Step 5: Commit.** `feat: tester wording in the feedback box; screenshot on by default for testers; Ctrl+Enter`

### Task 8: Introduction wired into the inspector

**Files:**
- Modify: `component/redline-inspector.tsx`
- Test: `tests/intro-flow.spec.ts`, which runs on both projects

**Interfaces:**
- Consumes: Task 3's `RedlineIntro`, `introDismissed` and `dismissIntro`, Task 5's `?` buttons, and Task 7's `audience` and `shortcuts`.
- Produces:
  - State `introOpen`, set to `!introDismissed()` in the render-time activation block.
  - While it is open, the inspector shows only the introduction. There's no pill, bar, crosshair, hover or pick, and its keydown handler ignores every key.
  - Closing leaves Redline on, in the mode it was opened with.
  - `?` sets `introOpen` to true.
  - Deactivating closes the introduction.
  - The introduction gets `audience`, `touch = touchUi` and `shortcuts`.

- [ ] **Step 1: Write the failing tests**, using the fixture with `showIntro: true`.
  - `first activation shows the introduction; after Start the inspector is ready to pick`.
  - `Esc in the introduction closes it but leaves Redline on`: `__redlineClosed` stays unset and the pill is visible.
  - `opened in area mode, it lands in Area after closing`: `initialMode: 'area'`.
  - `the ? button reopens it after Don't show this again`.
  - `touch activation shows the two-page touch introduction`: on webkit-iphone, or chromium with touch.
  - `tester audience reaches the introduction`: the privacy line is visible.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Wire the introduction in.**
- [ ] **Step 4: Run them to see them pass on both projects**, then run `pnpm test:all`.
- [ ] **Step 5: Commit.** `feat: show the introduction on first activation; ? reopens it`

### Task 9: Install, update and docs

**Files:**
- Modify:
  - `AGENT-INSTALLATION.md`, step 6: add `redline-intro.tsx`, `redline-touch.ts` and `redline-shortcuts.ts` to the copy list. Add a step that wires the shortcut hook:
    - If the host has no Redline key listener, call `useRedlineShortcuts(activate)` where the inspector's on/off state lives.
    - If it has one, leave it, and say the hook exists. If its keys differ from r/u/e, pass `shortcuts={false}`.
  - `AGENT-INSTALLATION.md`, step 9: also pass `audience={redlineConfig.storage === 'supabase' ? 'tester' : 'developer'}` wherever the inspector renders.
  - `commands/redline/update.md`: add the three files to the comparison loop.
  - `README.md`:
    - Component API: add `audience` and `shortcuts`.
    - Keyboard Shortcuts: say the hook ships with Redline.
    - New "On phones" section: tap to pick, Smaller/Bigger/Comment, Area by drag with corner handles, Done.
    - "First-run introduction" note: when it shows, and that `?` reopens it.
  - `CHANGELOG.md`: a new `## 1.3.0 (unreleased)` entry at the top, with an "Upgrading from 1.2.x" note to re-run the install prompt and pass `audience`.
- Test: `tests/commands.spec.ts`. Extend the existing install-list test so every file in `component/` except the `*-example.ts` route templates appears in both AGENT-INSTALLATION step 6 and the update.md loop.

- [ ] **Step 1: Write the failing test** for the file-list consistency.
- [ ] **Step 2: Run it to see it fail.**
- [ ] **Step 3: Update the docs.**
- [ ] **Step 4: Run it to see it pass**, then run `pnpm -s typecheck && pnpm -s lint && pnpm test:all`.
- [ ] **Step 5: Commit.** `docs: 1.3.0 install, update and README for the introduction and touch capture`
