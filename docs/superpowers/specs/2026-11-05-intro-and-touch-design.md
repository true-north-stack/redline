# First-run introduction and touch capture

Status: design, awaiting Chad's approval of the full document. Date: 2026-11-05.

## Why

Redline 1.2.0 put the inspector in front of testers on deployed builds, and nothing teaches them how to use it. The only ways to start it are a host button or a triple-tap shortcut nobody would guess, and the inspector itself assumes a mouse and a keyboard. FLT's end-to-end test confirmed it: element picking works by tap on a phone, area capture doesn't work at all, and the feedback box shows a CSS selector, a "Redline Feedback" title and a "Cmd+Enter to submit" hint to non-technical interpreters, one of whom is a Deaf interpreter on a phone.

Success: a first-time tester on a phone or a computer turns Redline on, learns in under a minute how to point at something, and sends a useful note on the first try. A developer gets the same introduction in developer wording.

## Goals

1. A first-run introduction modal, for testers and developers alike.
2. Real touch support in the inspector: picking an element and drawing an area by finger, with on-screen controls in place of the keyboard.
3. A tester-facing feedback box without developer noise.

## Non-goals

- Changing how the host turns Redline on (its button or menu item stays the host's).
- Touch support in the admin inbox (it already works on phones).
- The 1.2.1 fixes (input length caps, the element screenshot rendered dark and clipped, the "Screenshot no longer available" copy, the 413/429 messages, the lint errors). They ship separately, first.

## Anti-goals

- An introduction that teaches something that doesn't work on the device in front of the reader. Phones never see keyboard shortcuts; area dragging is taught on phones only because this project makes it work.
- An introduction that interrupts a normal page load.
- A desktop experience that gets worse. Hover, click, S, Esc and Cmd+Enter keep working exactly as today.

## Decided

### When the introduction appears (Chad)

The first time someone turns Redline on in a browser, by the host button or a shortcut, before they pick anything. Never on page load. A "Don't show this again" checkbox stops it for that browser. Closing without the checkbox means it appears again next time Redline is turned on.

### Desktop introduction (Chad approved the mockup, draft 4)

A modal in Redline's existing dark style (`#1a1a1a` panel, `#333` borders, `#ef4444` accent), three pages, page dots, Back, Next (Start on the last page), × to close, and the checkbox in the footer.

1. **Point at what you mean.** Two animated tiles side by side. Element: a cursor moves across a heading, a line of text and a button; a dashed red outline follows it onto each, then it clicks the button and the outline turns solid, matching the real inspector. Area: a dashed box is dragged out. Line below: "Press S to switch between them."
2. **Say what's wrong.** A picture of the feedback box with the screenshot attached. "⌘ Enter sends. Esc backs out." Testers also see: "Don't type client names or details. Anything private on screen is blacked out before it's sent."
3. **Next time, use the keyboard.** RRR (or UUU) picks an element, EEE drags an area, Esc turns Redline off. Developers: "Then run /redline fix in Claude Code and it works through them." Testers: "Every note goes to the team, who read each one."

The mockup is at `docs/superpowers/specs/assets/2026-11-05-intro-mockup.html` (a fragment written for the brainstorm viewer; open it in a browser to click through) and is the visual reference for spacing, animation timing and copy.

### Touch interaction (senior product designer's ruling, Chad agreed)

- **First tap stages a pick.** The pick climbs from the touched node to the nearest meaningful ancestor: button, link, input, select, textarea, label, list item, or anything with a `role`. It is outlined solid.
- **Bottom action bar** while a pick is staged: a plain-words name of the pick (from `aria-label`, then visible text, then the element type, e.g. "Button: Save invoice"), and three controls: **Smaller**, **Bigger**, and a large red **Comment**. Smaller and Bigger walk down and up the DOM, skipping elements with the same box as their neighbour; each step animates the outline and updates the name. Tapping elsewhere moves the pick. Comment opens the feedback box.
- **Only a true tap selects.** A touch that moves more than a small threshold is a scroll and selects nothing, so the page scrolls normally in Element mode.
- **Intercept earlier.** Capture `pointerdown` (and `touchstart`) as well as `click` while the inspector is on, so host menus that open on pointerdown don't react first. This applies on desktop too.
- **Area by touch.** Switching to Area stops the page from scrolling (`touch-action: none` on the overlay) and shows "Drag to draw a box." A one-finger drag draws it; corner handles adjust it; Comment opens the feedback box. To capture something further down, the tester scrolls in Element mode first.
- **Bottom bar in place of the keyboard.** On touch, the top pill is replaced by a bottom bar with an Element / Area switch, a "?" that reopens the introduction, and a clearly labelled **Done** that turns Redline off. While a pick is staged, **Cancel** replaces Done and drops the pick. All controls sit in the bottom thumb zone and are at least 44px tall.

### Phone introduction

Two pages instead of three, same modal style, sized for a 390px screen:

1. **Point at what you mean.** Three short animated frames: a finger taps an element, Bigger grows the outline to the whole card, Comment. A second tile shows a finger dragging an area.
2. **Say what's wrong.** As on desktop, without keyboard hints. Testers see the privacy line.

### Tester mode for the feedback box

In tester wording the feedback box hides the CSS selector, the "Request UX review" option and every keyboard hint, and the title reads "What's wrong here?" instead of "Redline Feedback". Developer wording keeps today's box.

### Screenshots on element picks (Chad)

In tester wording, an element pick includes its screenshot by default, masked as always, with "Include screenshot" ticked so the tester can untick it. Developer wording keeps today's default (unticked). Area captures already include theirs. If masking or capture fails, the screenshot is dropped and the box says so, as today. This depends on the 1.2.1 fix for dark, clipped element screenshots: a default-on screenshot that renders as a black bar would be worse than none.

### Reopening the introduction

A "?" reopens it at any time: next to "S to switch" in the desktop pill, and in the bottom bar on touch.

## Calls I made (check these)

- **Who gets which wording.** A new inspector prop, `audience: 'tester' | 'developer'`. Hosts pass `audience={redlineConfig.storage === 'supabase' ? 'tester' : 'developer'}`, and the install prompt wires it that way. Default `developer`, so existing hosts don't change.
- **Touch detection.** Decided per interaction from `PointerEvent.pointerType`, not from screen size, so a touchscreen laptop works with both. The introduction picks its phone or desktop version from `matchMedia('(hover: none) and (pointer: coarse)')` when it opens.
- **"Don't show again" storage.** `localStorage` key `redline:intro:v1` (versioned, so a future introduction can show once more), wrapped in try/catch; if storage is unavailable the introduction shows each time and still closes normally.
- **Shortcuts ship with Redline.** Today the triple-tap listener lives in each host (FLT wrote its own). Redline exports a `useRedlineShortcuts(onActivate)` hook with the documented keys, so the keyboard page is true wherever Redline is installed; the install prompt wires it, and hosts with their own listener can keep it.
- **Which controls show on activation.** The inspector shows the touch bottom bar when Redline turns on if `matchMedia('(pointer: coarse)')` matches, and the desktop pill otherwise. After that it follows the last `pointerType` it saw, so a touchscreen laptop swaps live between pill and bottom bar as the user switches between mouse and finger.
- **Closing the introduction.** Start, ×, and Esc all close the introduction and leave Redline on, ready to pick in the mode it was opened in (so EEE shows the introduction, then lands in Area). Esc inside the introduction is caught there and doesn't also turn the inspector off. Turning Redline off stays with Done, Esc in the inspector, or the host's own toggle.
- **Upgrading hosts with their own shortcut listener.** The install prompt wires `useRedlineShortcuts` only when the host has no Redline key listener. If one exists (FLT has one, with the same keys), it is left alone and the developer is told the hook is available. The intro takes a `shortcuts` prop (default `true`); a host whose keys differ passes `false` and the keyboard page is skipped.
- **Order of work.** 1.2.1 ships first: it changes the same feedback box (length caps, element screenshots, error copy). This project is built on top of 1.2.1, not alongside it. (1.2.0 is pushed and released, as of a149e26.)
- **Motion.** Under `prefers-reduced-motion`, the animations show their final frame with a short caption instead of moving.
- **Accessibility.** The modal is a real dialog: focus moves into it, Tab is trapped, Esc closes it (desktop), and it has an accessible name. Animations have text equivalents.

## Left to the builder

File layout (the introduction likely belongs in its own `redline-intro.tsx`, added to the installer's file list and to `/redline:update`'s comparison list), how to refactor the inspector's mouse handlers onto pointer events, the exact tap threshold, the heuristics for skipping same-box wrappers, and test structure. Tests must cover: tap picks the meaningful ancestor; Bigger and Smaller walk the tree; a scroll gesture selects nothing; touch drag draws an area and opens the box; pointerdown is intercepted; the introduction's first-run, don't-show-again, reopen and both audiences; reduced motion; and desktop behaviour unchanged. Run them in Playwright on Chromium and on WebKit with iPhone emulation.

## Before release

Chad tries it on a real phone, and ideally five real interpreters try it, since emulation can't prove touch behaviour. Release as 1.3.0 with a CHANGELOG entry and the install prompt updated.
