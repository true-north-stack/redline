'use client'

// First-run introduction: shown the first time someone turns Redline on in a browser,
// before they pick anything. Desktop gets three pages (the last one only when the host
// has Redline's keyboard shortcuts), touch gets two with no keyboard hints. Testers and
// developers get their own wording where it matters.

import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react'

export const INTRO_STORAGE_KEY = 'redline:intro:v1'

/** True only when this browser asked not to see the introduction again. False if storage is blocked. */
export function introDismissed(): boolean {
  try {
    return window.localStorage.getItem(INTRO_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/** Remembers "Don't show this again". Blocked storage means the introduction simply shows next time. */
export function dismissIntro(): void {
  try {
    window.localStorage.setItem(INTRO_STORAGE_KEY, '1')
  } catch {
    // Storage unavailable (private mode, blocked site data): nothing to remember with
  }
}

export interface RedlineIntroProps {
  audience: 'tester' | 'developer'
  touch: boolean
  shortcuts: boolean
  onClose(): void
}

type PageKey = 'point' | 'say' | 'keys'

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

function isMac(): boolean {
  if (typeof navigator === 'undefined') return false
  return /mac/i.test(navigator.platform || '') || /mac/i.test(navigator.userAgent || '')
}

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="rl-intro-keyset">
      {keys.map((k, i) => (
        <span key={i}>
          {i > 0 && ' '}
          <kbd className="rl-intro-kbd">{k}</kbd>
        </span>
      ))}
    </span>
  )
}

function Caption({ lead, children }: { lead: string; children: ReactNode }) {
  return (
    <div className="rl-intro-cap">
      <b>{lead}</b> {children}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Tiles. Each scene's resting styles are its final frame; motion is added   */
/* only under prefers-reduced-motion: no-preference.                         */
/* ------------------------------------------------------------------------ */

function DesktopElementTile() {
  return (
    <div className="rl-intro-card">
      <div aria-hidden="true">
        <div className="rl-intro-e" style={{ left: 12, top: 14, width: 110, height: 10 }} />
        <div className="rl-intro-e" style={{ left: 12, top: 34, width: 80, height: 8 }} />
        <div className="rl-intro-e" style={{ left: 12, top: 56, width: 70, height: 22, background: '#3a3a3a', borderRadius: 5 }} />
        <div className="rl-intro-hl" />
        <div className="rl-intro-cursor" />
      </div>
      <Caption lead="Element.">Hover, then click.</Caption>
    </div>
  )
}

function DesktopAreaTile() {
  return (
    <div className="rl-intro-card">
      <div aria-hidden="true">
        <div className="rl-intro-area" />
        <div className="rl-intro-cursor2" />
      </div>
      <Caption lead="Area.">Drag a box.</Caption>
    </div>
  )
}

function TouchElementTile() {
  return (
    <div className="rl-intro-card rl-intro-card-touch">
      <div className="rl-intro-scene" aria-hidden="true">
        <div className="rl-intro-tcard">
          <div className="rl-intro-e" style={{ left: 10, top: 10, width: 70, height: 8 }} />
          <div className="rl-intro-e" style={{ left: 10, top: 24, width: 112, height: 6, background: '#262626' }} />
          <div className="rl-intro-e" style={{ left: 10, top: 38, width: 56, height: 18, background: '#3a3a3a' }} />
        </div>
        <div className="rl-intro-tsel" />
        <div className="rl-intro-chip" style={{ left: 0, width: 48 }}>Smaller</div>
        <div className="rl-intro-chip rl-intro-chip-bigger" style={{ left: 54, width: 46 }}>Bigger</div>
        <div className="rl-intro-chip rl-intro-chip-comment" style={{ left: 106, width: 54 }}>Comment</div>
        <div className="rl-intro-finger rl-intro-finger-pick" />
      </div>
      <Caption lead="Element.">Tap it, then Bigger for the whole thing.</Caption>
    </div>
  )
}

function TouchAreaTile() {
  return (
    <div className="rl-intro-card rl-intro-card-touch">
      <div className="rl-intro-scene" aria-hidden="true">
        <div className="rl-intro-tarea" />
        <div className="rl-intro-seg">
          <span>Element</span>
          <span className="rl-intro-seg-area">Area</span>
        </div>
        <div className="rl-intro-finger rl-intro-finger-drag" />
      </div>
      <Caption lead="Area.">Switch to Area, then drag a box.</Caption>
    </div>
  )
}

function FeedbackPicture({ ticked }: { ticked: boolean }) {
  return (
    <div className="rl-intro-form" aria-hidden="true">
      <div className="rl-intro-ta">The total should include tax.</div>
      <div className="rl-intro-row">
        <span className={ticked ? 'rl-intro-box rl-intro-box-on' : 'rl-intro-box'} />
        <span>Include Screenshot</span>
        <span className="rl-intro-send">Submit</span>
      </div>
    </div>
  )
}

interface PageProps {
  page: PageKey
  titleId: string | undefined
  touch: boolean
  tester: boolean
  mod: string
}

function IntroPage({ page: k, titleId: id, touch, tester, mod }: PageProps) {
  if (k === 'point') {
    return (
      <>
        <h2 className="rl-intro-title" id={id}>Point at what you mean</h2>
        <p className="rl-intro-text">
          {touch ? 'Tap one thing on the page, or draw a box around a region.' : 'Pick one thing on the page, or a whole region.'}
        </p>
        <div className={touch ? 'rl-intro-vis rl-intro-vis-touch' : 'rl-intro-vis'}>
          {touch ? <TouchElementTile /> : <DesktopElementTile />}
          {touch ? <TouchAreaTile /> : <DesktopAreaTile />}
        </div>
        {!touch && (
          <p className="rl-intro-hint">
            Press <kbd className="rl-intro-kbd">S</kbd> to switch between them.
          </p>
        )}
      </>
    )
  }
  if (k === 'say') {
    return (
      <>
        <h2 className="rl-intro-title" id={id}>{"Say what's wrong"}</h2>
        <p className="rl-intro-text">
          {tester
            ? 'A box opens with a screenshot attached. Write what you expected to see.'
            : 'A box opens for your note. Tick Include Screenshot to attach what you picked.'}
        </p>
        <FeedbackPicture ticked={tester} />
        {tester && (
          <p className="rl-intro-note">
            {"Don't type client names or details. Anything private on screen is blacked out before it's sent."}
          </p>
        )}
        {!touch && (
          <p className="rl-intro-hint">
            <kbd className="rl-intro-kbd" suppressHydrationWarning>{mod}</kbd> <kbd className="rl-intro-kbd">Enter</kbd> sends.{' '}
            <kbd className="rl-intro-kbd">Esc</kbd> backs out.
          </p>
        )}
      </>
    )
  }
  return (
    <>
      <h2 className="rl-intro-title" id={id}>Next time, use the keyboard</h2>
      <p className="rl-intro-text">Tap a letter three times quickly, anywhere outside a text field.</p>
      <div className="rl-intro-keys">
        <Keys keys={['R', 'R', 'R']} />
        <span>Pick an element (or <Keys keys={['U', 'U', 'U']} /> with your left hand)</span>
        <Keys keys={['E', 'E', 'E']} />
        <span>Drag an area</span>
        <Keys keys={['Esc']} />
        <span>Turn Redline off</span>
      </div>
      <p className="rl-intro-hint">
        {tester ? (
          'Every note goes to the team, who read each one.'
        ) : (
          <>Then run <code className="rl-intro-code">/redline fix</code> in Claude Code and it works through them.</>
        )}
      </p>
    </>
  )
}

export function RedlineIntro({ audience, touch, shortcuts, onClose }: RedlineIntroProps) {
  const [page, setPage] = useState(0)
  const [dontShow, setDontShow] = useState(false)
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const nextRef = useRef<HTMLButtonElement>(null)

  const tester = audience === 'tester'
  const pages: PageKey[] = touch ? ['point', 'say'] : shortcuts ? ['point', 'say', 'keys'] : ['point', 'say']
  const current = Math.min(page, pages.length - 1)
  const last = current === pages.length - 1

  // Move focus into the dialog when it opens, onto the way forward (a ring on × reads as a
  // highlighted close), and hand it back when it closes
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    nextRef.current?.focus()
    return () => {
      if (previous && previous.isConnected) previous.focus()
    }
  }, [])

  function close() {
    if (dontShow) dismissIntro()
    onClose()
  }

  function goNext() {
    if (last) close()
    else setPage(current + 1)
  }

  function goBack() {
    const to = Math.max(0, current - 1)
    setPage(to)
    // Back hides itself on the first page; keep focus on something that stays
    if (to === 0) nextRef.current?.focus()
  }

  function handleKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      // Caught here so the inspector's own Esc (turn Redline off) never sees it
      e.preventDefault()
      e.stopPropagation()
      close()
      return
    }
    if (e.key !== 'Tab') return
    const root = dialogRef.current
    if (!root) return
    const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length > 0,
    )
    if (items.length === 0) return
    e.preventDefault()
    const at = items.indexOf(document.activeElement as HTMLElement)
    const to = at === -1
      ? (e.shiftKey ? items.length - 1 : 0)
      : (at + (e.shiftKey ? -1 : 1) + items.length) % items.length
    items[to].focus()
  }

  // A press on the backdrop would otherwise drop focus to the page, where Esc turns Redline off
  function holdFocus(e: ReactMouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) e.preventDefault()
  }

  const mod = isMac() ? '⌘' : 'Ctrl'

  return (
    <div
      data-redline-ui
      className={touch ? 'rl-intro-root rl-intro-touch' : 'rl-intro-root'}
      onMouseDown={holdFocus}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        backgroundColor: 'rgba(0,0,0,0.5)',
      }}
    >
      <style>{INTRO_CSS}</style>
      <div
        ref={dialogRef}
        data-redline-ui
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="rl-intro-modal"
        style={{
          width: 'min(440px, calc(100vw - 32px))',
          maxHeight: 'calc(100dvh - 32px)',
          overflowY: 'auto',
          overflowX: 'hidden',
        }}
      >
        <div className="rl-intro-head">
          <span className="rl-intro-dot" />
          <span className="rl-intro-brand">Redline</span>
          <button type="button" className="rl-intro-x" aria-label="Close" onClick={close}>
            ×
          </button>
        </div>

        <div className="rl-intro-body rl-intro-pages">
          {pages.map((k, i) => (
            <div
              key={k}
              className={i === current ? 'rl-intro-page' : 'rl-intro-page rl-intro-page-off'}
              aria-hidden={i === current ? undefined : true}
              inert={i !== current}
            >
              <IntroPage page={k} titleId={i === current ? titleId : undefined} touch={touch} tester={tester} mod={mod} />
            </div>
          ))}
        </div>

        <div className="rl-intro-foot">
          <label className="rl-intro-check">
            <input type="checkbox" checked={dontShow} onChange={(e) => setDontShow(e.target.checked)} />
            {"Don't show this again"}
          </label>
          <div className="rl-intro-nav">
            <div className="rl-intro-dots" aria-hidden="true">
              {pages.map((p, i) => (
                <span key={p} className={i === current ? 'rl-intro-on' : undefined} />
              ))}
            </div>
            <span className="rl-intro-sr" aria-live="polite">
              Page {current + 1} of {pages.length}
            </span>
            <button
              type="button"
              className="rl-intro-b rl-intro-ghost"
              onClick={goBack}
              disabled={current === 0}
              aria-hidden={current === 0 ? true : undefined}
              style={{ visibility: current === 0 ? 'hidden' : 'visible' }}
            >
              Back
            </button>
            <button ref={nextRef} type="button" className="rl-intro-b rl-intro-primary" onClick={goNext}>
              {last ? 'Start' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Styles. Every class is prefixed rl-intro- so nothing leaks into the host. */
/* ------------------------------------------------------------------------ */

const ARROW = 'polygon(0 0,0 100%,30% 72%,55% 100%,70% 92%,45% 65%,85% 65%)'

const INTRO_CSS = `
.rl-intro-root, .rl-intro-root *, .rl-intro-root *::before, .rl-intro-root *::after { box-sizing: border-box; }
.rl-intro-root, .rl-intro-root * { cursor: default !important; }
.rl-intro-root button, .rl-intro-root label, .rl-intro-root input { cursor: pointer !important; }
.rl-intro-root button:disabled { cursor: default !important; }
.rl-intro-root {
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #eee; text-align: left; letter-spacing: normal; text-transform: none;
  -webkit-font-smoothing: antialiased;
}
.rl-intro-modal {
  position: relative; background: #1a1a1a; border: 1px solid #333; border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0,0,0,.5); color: #eee; overscroll-behavior: contain; outline: none;
}
.rl-intro-root button:focus-visible, .rl-intro-root input:focus-visible {
  outline: 2px solid #ef4444; outline-offset: 2px;
}
.rl-intro-sr {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

.rl-intro-head { display: flex; align-items: center; gap: 8px; padding: 14px 16px 0; }
.rl-intro-dot { width: 6px; height: 6px; border-radius: 50%; background: #ef4444; flex: none; }
.rl-intro-brand { font-size: 12px; font-weight: 600; color: #aaa; letter-spacing: .02em; }
.rl-intro-x {
  margin: -4px -6px -4px auto; width: 28px; height: 28px; padding: 0; display: flex;
  align-items: center; justify-content: center; background: none; border: none; border-radius: 6px;
  color: #888; font-family: inherit; font-size: 20px; font-weight: 400; line-height: 1;
}
.rl-intro-x:hover { color: #eee; background: #222; }

.rl-intro-body { padding: 12px 20px 4px; }
/* On desktop every page sits in the same grid cell, so the dialog keeps the tallest page's
   height and Next stays under the pointer as you click through. Touch pages differ too much
   in height for that, and a finger has no pointer to keep in place, so they size to fit. */
.rl-intro-pages { display: grid; }
.rl-intro-page { grid-area: 1 / 1; min-width: 0; }
.rl-intro-page-off { visibility: hidden; }
.rl-intro-touch .rl-intro-page-off { display: none; }
.rl-intro-title { font-size: 18px; line-height: 1.35; font-weight: 650; margin: 0 0 4px; color: #fff; }
.rl-intro-text { color: #aaa; font-size: 13px; margin: 0 0 14px; }
.rl-intro-hint { font-size: 12px; color: #888; margin: 0 0 4px; }
.rl-intro-note {
  font-size: 12px; color: #f3c6c6; background: rgba(239,68,68,.08);
  border: 1px solid rgba(239,68,68,.25); border-radius: 6px; padding: 8px 10px; margin: 0 0 12px;
}
.rl-intro-kbd {
  display: inline-block; min-width: 18px; margin: 0; padding: 1px 6px; background: #222;
  border: 1px solid #333; border-bottom-width: 2px; border-radius: 4px;
  font: 600 11px/1.4 ui-monospace, Menlo, monospace; color: #ddd; text-align: center; vertical-align: 1px;
}
.rl-intro-code {
  padding: 1px 6px; background: #222; border: 1px solid #333; border-radius: 4px;
  font: 600 11px/1.4 ui-monospace, Menlo, monospace; color: #ddd; white-space: nowrap;
}
.rl-intro-keyset { white-space: nowrap; }

.rl-intro-vis { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 10px; margin-bottom: 12px; }
.rl-intro-card {
  background: #111; border: 1px solid #2a2a2a; border-radius: 8px; height: 150px;
  position: relative; overflow: hidden;
}
.rl-intro-card-touch { height: 168px; }
.rl-intro-cap { position: absolute; left: 10px; right: 10px; bottom: 8px; font-size: 12px; line-height: 1.4; color: #ddd; }
.rl-intro-cap b { color: #fff; font-weight: 650; }
.rl-intro-e { position: absolute; background: #2a2a2a; border-radius: 4px; }

/* Desktop element tile: resting style is the click (solid outline on the button) */
.rl-intro-hl {
  position: absolute; left: 8px; top: 52px; width: 74px; height: 26px;
  border: 2px solid #ef4444; border-radius: 6px; background: rgba(239,68,68,.30);
}
.rl-intro-cursor { position: absolute; left: 62px; top: 64px; width: 12px; height: 16px; }
.rl-intro-cursor::before, .rl-intro-cursor2::before {
  content: ""; position: absolute; inset: 0; background: #fff; clip-path: ${ARROW};
}

/* Desktop area tile: resting style is the finished box */
.rl-intro-area {
  position: absolute; left: 18px; top: 18px; width: 120px; height: 70px;
  border: 2px dashed #ef4444; background: rgba(239,68,68,.10); border-radius: 3px;
}
.rl-intro-cursor2 { position: absolute; left: 18px; top: 18px; width: 12px; height: 16px; transform: translate(120px,70px); }

/* Touch tiles share a fixed-size scene centred in the card */
.rl-intro-scene { position: absolute; top: 6px; left: 50%; width: 160px; height: 104px; margin-left: -80px; }
.rl-intro-tcard {
  position: absolute; left: 8px; top: 4px; width: 144px; height: 66px;
  background: #1c1c1c; border: 1px solid #2e2e2e; border-radius: 6px;
}
.rl-intro-tsel {
  position: absolute; left: 5px; top: 1px; width: 150px; height: 72px;
  border: 2px solid #ef4444; border-radius: 8px; background: rgba(239,68,68,.12);
}
.rl-intro-chip {
  position: absolute; top: 82px; height: 20px; border-radius: 6px; background: #222;
  border: 1px solid #333; color: #bbb; font: 600 10px/18px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  text-align: center; white-space: nowrap;
}
.rl-intro-chip-comment { background: #ef4444; border-color: #ef4444; color: #fff; }
.rl-intro-seg {
  position: absolute; left: 24px; top: 82px; width: 112px; height: 20px; display: flex;
  background: #1c1c1c; border: 1px solid #333; border-radius: 6px; overflow: hidden;
  font: 600 10px/18px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}
.rl-intro-seg span { flex: 1; text-align: center; color: #888; }
.rl-intro-seg .rl-intro-seg-area { background: #ef4444; color: #fff; }
.rl-intro-tarea {
  position: absolute; left: 18px; top: 8px; width: 120px; height: 62px;
  border: 2px dashed #ef4444; background: rgba(239,68,68,.10); border-radius: 3px;
}
.rl-intro-finger { position: absolute; width: 0; height: 0; }
.rl-intro-finger-pick { left: 158px; top: 110px; }
.rl-intro-finger-drag { left: 138px; top: 70px; }
.rl-intro-finger::before {
  content: ""; position: absolute; left: -9px; top: -9px; width: 18px; height: 18px; border-radius: 50%;
  background: rgba(255,255,255,.9); box-shadow: 0 0 0 4px rgba(255,255,255,.16), 0 2px 6px rgba(0,0,0,.5);
}
.rl-intro-finger::after {
  content: ""; position: absolute; left: -14px; top: -14px; width: 28px; height: 28px; border-radius: 50%;
  border: 2px solid rgba(255,255,255,.7); opacity: 0;
}

/* Footer */
.rl-intro-foot {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px;
  padding: 12px 20px 16px; border-top: 1px solid #262626; margin-top: 8px;
}
.rl-intro-check {
  display: flex; align-items: center; gap: 6px; font-size: 12px; color: #888; user-select: none;
  -webkit-user-select: none; margin: 0;
}
.rl-intro-check input { margin: 0; width: 14px; height: 14px; accent-color: #ef4444; }
.rl-intro-nav { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.rl-intro-dots { display: flex; gap: 5px; margin-right: 6px; }
.rl-intro-dots span { width: 6px; height: 6px; border-radius: 50%; background: #444; }
.rl-intro-dots span.rl-intro-on { background: #ef4444; }
.rl-intro-b {
  margin: 0; padding: 6px 14px; font-family: inherit; font-size: 12px; font-weight: 600; line-height: 1.5; border-radius: 6px;
}
.rl-intro-ghost { border: 1px solid #333; background: transparent; color: #aaa; }
.rl-intro-ghost:hover { color: #eee; border-color: #444; }
.rl-intro-primary { border: 1px solid #ef4444; background: #ef4444; color: #fff; min-width: 64px; }
.rl-intro-primary:hover { background: #dc2626; border-color: #dc2626; }

/* Page 2 picture of the feedback box */
.rl-intro-form { background: #111; border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px; margin-bottom: 12px; }
.rl-intro-ta { background: #1a1a1a; border: 1px solid #333; border-radius: 6px; padding: 8px; font-size: 13px; color: #ddd; min-height: 44px; }
.rl-intro-row { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 12px; color: #aaa; }
.rl-intro-box { position: relative; width: 13px; height: 13px; border: 1px solid #555; border-radius: 3px; background: #1a1a1a; flex: none; }
.rl-intro-box-on { background: #ef4444; border-color: #ef4444; }
.rl-intro-box-on::after {
  content: ""; position: absolute; left: 3.5px; top: 0.5px; width: 4px; height: 7px;
  border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg);
}
.rl-intro-send { margin-left: auto; background: #ef4444; color: #fff; border-radius: 6px; padding: 4px 10px; font-weight: 600; }

/* Page 3 key list */
.rl-intro-keys {
  display: grid; grid-template-columns: auto minmax(0,1fr); gap: 8px 14px; align-items: center;
  margin: 0 0 14px; font-size: 13px; color: #ccc;
}

/* Touch: 44px targets, a little less side padding, tiles stack on narrow screens */
.rl-intro-touch .rl-intro-x { width: 44px; height: 44px; margin: -12px -12px -12px auto; }
.rl-intro-touch .rl-intro-body { padding: 12px 16px 4px; }
.rl-intro-touch .rl-intro-foot { padding: 10px 16px 14px; }
.rl-intro-touch .rl-intro-check { min-height: 44px; font-size: 13px; gap: 8px; }
.rl-intro-touch .rl-intro-check input { width: 18px; height: 18px; }
.rl-intro-touch .rl-intro-b { min-height: 44px; padding: 0 18px; font-size: 14px; }
.rl-intro-touch .rl-intro-primary { min-width: 88px; }
@media (max-width: 399.98px) {
  .rl-intro-vis-touch { grid-template-columns: minmax(0,1fr); }
}

@media (prefers-reduced-motion: no-preference) {
  .rl-intro-hl { animation: rl-intro-hl 5s infinite; }
  .rl-intro-cursor { animation: rl-intro-cur 5s infinite; }
  .rl-intro-area { animation: rl-intro-area 3s infinite; }
  .rl-intro-cursor2 { animation: rl-intro-cur2 3s infinite; }

  .rl-intro-tsel { animation: rl-intro-tsel 6s infinite; }
  .rl-intro-chip-bigger { animation: rl-intro-bigger 6s infinite; }
  .rl-intro-chip-comment { animation: rl-intro-comment 6s infinite; }
  .rl-intro-finger-pick { animation: rl-intro-fpick 6s infinite; }
  .rl-intro-finger-pick::before { animation: rl-intro-press3 6s infinite; }
  .rl-intro-finger-pick::after { animation: rl-intro-ripple3 6s infinite; }

  .rl-intro-tarea { animation: rl-intro-tarea 5s infinite; }
  .rl-intro-seg .rl-intro-seg-area { animation: rl-intro-seg 5s infinite; }
  .rl-intro-finger-drag { animation: rl-intro-fdrag 5s infinite; }
  .rl-intro-finger-drag::before { animation: rl-intro-pressdrag 5s infinite; }
  .rl-intro-finger-drag::after { animation: rl-intro-rippledrag 5s infinite; }
}

/* Desktop, ported from the approved mockup (draft 4) */
@keyframes rl-intro-cur {
  0% { left: 160px; top: 120px; transform: scale(1); }
  10%, 28% { left: 96px; top: 16px; }
  36%, 52% { left: 74px; top: 35px; }
  60%, 70% { left: 62px; top: 64px; transform: scale(1); }
  73% { transform: scale(.8); }
  76%, 100% { left: 62px; top: 64px; transform: scale(1); }
}
@keyframes rl-intro-hl {
  0%, 8% { opacity: 0; left: 8px; top: 10px; width: 114px; height: 14px; border-style: dashed; background: rgba(239,68,68,.10); }
  10%, 30% { opacity: 1; left: 8px; top: 10px; width: 114px; height: 14px; background: rgba(239,68,68,.10); border-style: dashed; }
  36%, 54% { left: 8px; top: 30px; width: 84px; height: 12px; }
  60%, 72% { left: 8px; top: 52px; width: 74px; height: 26px; background: rgba(239,68,68,.10); border-style: dashed; }
  75%, 94% { opacity: 1; left: 8px; top: 52px; width: 74px; height: 26px; background: rgba(239,68,68,.30); border-style: solid; }
  100% { opacity: 0; left: 8px; top: 52px; width: 74px; height: 26px; }
}
@keyframes rl-intro-area { 0%, 10% { width: 0; height: 0; } 60%, 100% { width: 120px; height: 70px; } }
@keyframes rl-intro-cur2 { 0%, 10% { transform: translate(0,0); } 60%, 100% { transform: translate(120px,70px); } }

/* Touch element: tap the button, Bigger grows the outline to its card, then Comment */
@keyframes rl-intro-fpick {
  0% { opacity: 0; left: 130px; top: 110px; }
  6% { opacity: 1; left: 100px; top: 90px; }
  13%, 22% { opacity: 1; left: 47px; top: 52px; }
  32%, 41% { left: 77px; top: 92px; }
  47%, 50% { left: 94px; top: 104px; }
  58%, 67% { left: 133px; top: 92px; }
  /* After the tap the finger rests below and right of Comment, so its label stays readable */
  73%, 84% { opacity: 1; left: 158px; top: 110px; }
  90%, 100% { opacity: 0; left: 158px; top: 110px; }
}
@keyframes rl-intro-press3 {
  0%, 14%, 19%, 37%, 42%, 63%, 68%, 100% { transform: scale(1); }
  16%, 39%, 65% { transform: scale(.75); }
}
@keyframes rl-intro-ripple3 {
  0%, 15%, 38%, 64%, 100% { opacity: 0; transform: scale(.5); }
  16%, 39%, 65% { opacity: 1; transform: scale(.6); }
  24%, 47%, 73% { opacity: 0; transform: scale(1.6); }
}
@keyframes rl-intro-tsel {
  0%, 15% { opacity: 0; left: 16px; top: 40px; width: 62px; height: 24px; }
  17%, 39% { opacity: 1; left: 16px; top: 40px; width: 62px; height: 24px; }
  45%, 92% { opacity: 1; left: 5px; top: 1px; width: 150px; height: 72px; }
  97%, 100% { opacity: 0; left: 5px; top: 1px; width: 150px; height: 72px; }
}
@keyframes rl-intro-bigger {
  0%, 38%, 54%, 100% { background: #222; border-color: #333; color: #bbb; transform: scale(1); }
  40% { background: #ef4444; border-color: #ef4444; color: #fff; transform: scale(1.1); }
  46% { background: #ef4444; border-color: #ef4444; color: #fff; transform: scale(1); }
}
@keyframes rl-intro-comment {
  0%, 64% { background: #222; border-color: #333; color: #bbb; transform: scale(1); }
  66% { background: #ef4444; border-color: #ef4444; color: #fff; transform: scale(1.1); }
  72%, 94% { background: #ef4444; border-color: #ef4444; color: #fff; transform: scale(1); }
  100% { background: #222; border-color: #333; color: #bbb; transform: scale(1); }
}

/* Touch area: tap Area, then drag a dashed box out with a finger */
@keyframes rl-intro-fdrag {
  0% { opacity: 0; left: 140px; top: 100px; }
  6% { opacity: 1; left: 120px; top: 96px; }
  11%, 16% { opacity: 1; left: 108px; top: 92px; }
  26%, 30% { left: 18px; top: 8px; }
  66%, 84% { opacity: 1; left: 138px; top: 70px; }
  92%, 100% { opacity: 0; left: 138px; top: 70px; }
}
@keyframes rl-intro-pressdrag {
  0%, 12%, 16%, 28%, 70%, 100% { transform: scale(1); }
  14% { transform: scale(.75); }
  31%, 66% { transform: scale(.85); }
}
@keyframes rl-intro-rippledrag {
  0%, 13%, 100% { opacity: 0; transform: scale(.5); }
  14% { opacity: 1; transform: scale(.6); }
  22% { opacity: 0; transform: scale(1.6); }
}
@keyframes rl-intro-seg {
  0%, 13% { background: transparent; color: #888; }
  15%, 94% { background: #ef4444; color: #fff; }
  100% { background: transparent; color: #888; }
}
@keyframes rl-intro-tarea {
  0%, 30% { opacity: 1; width: 0; height: 0; border-width: 0; }
  31% { border-width: 2px; width: 0; height: 0; }
  66%, 92% { opacity: 1; width: 120px; height: 62px; border-width: 2px; }
  100% { opacity: 0; width: 120px; height: 62px; border-width: 2px; }
}
`
