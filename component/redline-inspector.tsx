'use client'

import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from 'react'
import { LIMITS, maskSelectors, sanitizePageUrl } from './redline-config'
import { captureMasked, redactedText } from './redline-mask'
import { TAP_SLOP_PX, defaultPickIndex, describeElement, pickPath } from './redline-touch'
import { RedlineIntro, introDismissed } from './redline-intro'

interface RedlineInspectorProps {
  active: boolean
  onDeactivate: () => void
  apiUrl?: string
  initialMode?: InspectorMode
  /** Extra selectors to mask in screenshots and captured text, on top of [data-phi] */
  phiSelectors?: string[]
  /**
   * Who leaves the feedback. Testers get plain wording (no selector, no UX review option, no
   * keyboard hints) and an element screenshot ticked by default. Defaults to 'developer'.
   */
  audience?: 'tester' | 'developer'
  /** Whether the host has Redline's keyboard shortcuts, so the introduction can teach them. Defaults to true. */
  shortcuts?: boolean
}

type InspectorMode = 'element' | 'area'

interface AreaRect {
  startX: number
  startY: number
  endX: number
  endY: number
}

/** A corner of a drawn box, named by compass point. */
type Corner = 'nw' | 'ne' | 'sw' | 'se'
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se']

/** A box must be at least this wide and tall to count; smaller is an accidental touch. */
const MIN_AREA_PX = 20
/** How far a touch box keeps from the bar, so the handles on that side stay in reach. */
const BAR_CLEARANCE_PX = 12
/** A press this soon after the feedback box opens is the second half of a double tap. */
const DOUBLE_TAP_MS = 500

/** A touch pick waiting for Comment: candidates innermost first, and the one outlined. */
interface StagedPick {
  path: HTMLElement[]
  index: number
}

function generateSelector(el: HTMLElement): string {
  // Prefer data-testid
  const testId = el.getAttribute('data-testid')
  if (testId) return `[data-testid="${testId}"]`

  // Try id
  if (el.id) return `#${el.id}`

  // Build a CSS path
  const parts: string[] = []
  let current: HTMLElement | null = el
  while (current && current !== document.body) {
    let selector = current.tagName.toLowerCase()
    if (current.id) {
      selector = `#${current.id}`
      parts.unshift(selector)
      break
    }
    if (current.className && typeof current.className === 'string') {
      const classes = current.className.trim().split(/\s+/).filter(c => !c.startsWith('hover:') && !c.includes(':') && c.length < 30).slice(0, 2)
      if (classes.length) selector += `.${classes.join('.')}`
    }
    const parent = current.parentElement
    if (parent) {
      const siblings = Array.from(parent.children).filter(c => c.tagName === current!.tagName)
      if (siblings.length > 1) {
        const idx = siblings.indexOf(current) + 1
        selector += `:nth-child(${idx})`
      }
    }
    parts.unshift(selector)
    current = current.parentElement
  }
  return parts.join(' > ')
}

/** Normalize an AreaRect so top-left is always start */
function normalizeArea(area: AreaRect): { x: number; y: number; w: number; h: number } {
  const x = Math.min(area.startX, area.endX)
  const y = Math.min(area.startY, area.endY)
  const w = Math.abs(area.endX - area.startX)
  const h = Math.abs(area.endY - area.startY)
  return { x, y, w, h }
}

/** Whether the device's main pointer is a finger. False outside the browser. */
function coarsePointer(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
}

// Presses on Redline's own controls stop at Redline's root, so a host's "tap outside to
// close" listener never closes the menu the tester is about to comment on
const stopAtRedline = (e: SyntheticEvent) => e.stopPropagation()
const KEEP_FROM_PAGE = {
  onPointerDown: stopAtRedline,
  onPointerUp: stopAtRedline,
  onMouseDown: stopAtRedline,
  onMouseUp: stopAtRedline,
  onTouchStart: stopAtRedline,
  onTouchEnd: stopAtRedline,
  onClick: stopAtRedline,
}

// Bottom bar controls: thumb-sized, in the inspector's dark style
const BAR_BUTTON: CSSProperties = {
  minHeight: 44,
  minWidth: 44,
  padding: '0 16px',
  borderRadius: 10,
  border: '1px solid #333',
  backgroundColor: 'transparent',
  color: '#eee',
  fontSize: 15,
  fontWeight: 600,
  fontFamily: 'inherit',
  cursor: 'pointer',
  flexShrink: 0,
}
const BAR_BUTTON_DISABLED: CSSProperties = { ...BAR_BUTTON, color: '#555', cursor: 'default' }
const BAR_COMMENT: CSSProperties = {
  ...BAR_BUTTON,
  flex: 1,
  minHeight: 52,
  border: 'none',
  backgroundColor: '#ef4444',
  color: 'white',
  fontSize: 17,
  fontWeight: 700,
}
const BAR_ROW: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 }

// The feedback box's Cancel and Submit on touch: thumb-sized, sharing the row
const TOUCH_BOX_BUTTON: CSSProperties = { flex: 1, minHeight: 48, fontSize: 16, borderRadius: 10, fontFamily: 'inherit' }

/** The largest an element screenshot is shown in the feedback box, in CSS pixels. */
const ELEMENT_PREVIEW_MAX_W = 360
/** Element screenshots are captured at twice their CSS size. */
const ELEMENT_CAPTURE_SCALE = 2
const ELEMENT_PREVIEW_MAX_H = 160

/**
 * Draws an element capture (made at `srcScale` times its CSS size) into a preview canvas no
 * bigger than the box allows, at its natural size when it's smaller, never upscaled.
 */
function drawElementPreview(el: HTMLCanvasElement | null, src: HTMLCanvasElement, srcScale: number) {
  if (!el) return
  const w = src.width / srcScale
  const h = src.height / srcScale
  const fit = Math.min(1, ELEMENT_PREVIEW_MAX_W / w, ELEMENT_PREVIEW_MAX_H / h)
  const dpr = window.devicePixelRatio || 1
  el.width = Math.max(1, Math.round(w * fit * dpr))
  el.height = Math.max(1, Math.round(h * fit * dpr))
  // A fixed width with automatic height keeps the shape when maxWidth narrows it
  el.style.width = `${w * fit}px`
  el.style.maxWidth = '100%'
  el.style.height = 'auto'
  el.style.display = 'block'
  el.getContext('2d')?.drawImage(src, 0, 0, el.width, el.height)
}

/** What to tell the person when a save is refused. Says "try again" only when that can work. */
async function submitErrorMessage(res: Response, sentScreenshot: boolean): Promise<string> {
  if (res.status === 401) return 'Sign in to leave feedback.'
  if (res.status === 429) return 'Too many notes in a row. Wait a few minutes, then send it again.'
  if (res.status === 413) {
    let field: unknown = null
    try {
      field = (await res.json())?.field
    } catch {
      // Hosts and platforms can answer 413 without a JSON body
    }
    if (field === 'feedback') return 'Your note is too long. Shorten it and try again.'
    if (sentScreenshot) return 'Too large to send. Untick Include Screenshot and try again.'
    return 'Too large to send. Shorten your note and try again.'
  }
  return `Couldn't save your feedback (${res.status}). Try again.`
}

export function RedlineInspector({ active, onDeactivate, apiUrl = '/api/redlines', initialMode = 'element', phiSelectors, audience = 'developer', shortcuts = true }: RedlineInspectorProps) {
  const tester = audience === 'tester'
  const [hoveredEl, setHoveredEl] = useState<HTMLElement | null>(null)
  const [selectedEl, setSelectedEl] = useState<HTMLElement | null>(null)
  const [feedback, setFeedback] = useState('')
  const [includeScreenshot, setIncludeScreenshot] = useState(false)
  // Masking or capture failed for the current selection: no screenshot can be attached
  const [screenshotDropped, setScreenshotDropped] = useState(false)
  // The tester ticked or unticked Include Screenshot for this pick, so a capture finishing
  // afterwards leaves their choice alone
  const screenshotChosenRef = useRef(false)
  // The element capture, kept in state with the element it belongs to so the box can show it
  // and a capture for an earlier pick is never shown for the next one
  const [elementShot, setElementShot] = useState<{ el: HTMLElement; canvas: HTMLCanvasElement } | null>(null)
  const [requestUxReview, setRequestUxReview] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const screenshotCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // The current press went down, and was let go, on the feedback box's backdrop itself;
  // and when the box last opened
  const backdropPressRef = useRef(false)
  const backdropReleaseRef = useRef(false)
  const feedbackOpenedAtRef = useRef(0)

  // Area screenshot mode
  const [mode, setMode] = useState<InspectorMode>(active ? initialMode : 'element')
  const [dragging, setDragging] = useState(false)
  const [areaRect, setAreaRect] = useState<AreaRect | null>(null)
  const [areaComplete, setAreaComplete] = useState(false)
  // The cropped area capture, kept in state so the modal can preview it
  const [areaPreview, setAreaPreview] = useState<HTMLCanvasElement | null>(null)
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null)

  // Refs for drag state, read by the overlay's pointer handlers without re-rendering
  const draggingRef = useRef(false)
  const areaStartRef = useRef<{ x: number; y: number } | null>(null)
  // The one finger or button drawing, so a second finger can't restart or end the drag
  const areaPointerRef = useRef<number | null>(null)
  // A corner handle being dragged: the pointer, the corner that stays put, which way the
  // moving corner faces, and where the finger sits relative to that corner
  const cornerDragRef = useRef<{ id: number; fixedX: number; fixedY: number; dirX: 1 | -1; dirY: 1 | -1; offX: number; offY: number } | null>(null)
  // Bumped on every activation change, so a capture still running when Redline turns off
  // doesn't reopen the feedback box later
  const sessionRef = useRef(0)

  // Touch area: a drawn box waiting for its corners to be adjusted and Comment. Mouse
  // drags still capture on release.
  const [areaDraft, setAreaDraft] = useState<AreaRect | null>(null)
  const [capturingDraft, setCapturingDraft] = useState(false)
  // The touch bar sits at the bottom, or at the top so a host's bottom navigation can be
  // picked. Kept for the session only.
  const [barAtTop, setBarAtTop] = useState(false)
  const barRef = useRef<HTMLDivElement>(null)

  // Touch controls or desktop controls: starts from the device's main pointer, then
  // follows whatever pressed last, so a touchscreen laptop works with both
  const [touchUi, setTouchUi] = useState(() => active && coarsePointer())

  // Touch picking: a tap stages a pick, Smaller and Bigger walk it, Comment selects it
  const [staged, setStaged] = useState<StagedPick | null>(null)
  // The outline glides to its next box on a step, and jumps when the page scrolls under it
  const [outlineGlides, setOutlineGlides] = useState(false)
  const [, setLayoutTick] = useState(0)

  // The introduction: opens the first time Redline turns on in this browser (until "Don't
  // show this again"), and from ?. While open it's all the inspector shows.
  const [introOpen, setIntroOpen] = useState(() => active && !introDismissed())
  // Where focus goes back to when it closes: what was focused when it opened
  const introReturnRef = useRef<Element | null>(null)
  // The ? on screen (pill or bar), which takes focus when that element is gone
  const helpRef = useRef<HTMLButtonElement>(null)

  // On activation, start in initialMode; on deactivation, clear everything. Adjusted while
  // rendering (React's pattern for state that follows a prop), not in an effect.
  const [seen, setSeen] = useState({ active, initialMode })
  if (seen.active !== active || seen.initialMode !== initialMode) {
    setSeen({ active, initialMode })
    if (active) {
      setMode(initialMode)
      if (!seen.active) {
        setTouchUi(coarsePointer())
        setIntroOpen(!introDismissed())
      }
    } else {
      setMode('element')
      setDragging(false)
      setAreaRect(null)
      setAreaComplete(false)
      setAreaPreview(null)
      setMousePos(null)
      setHoveredEl(null)
      setSelectedEl(null)
      setStaged(null)
      setAreaDraft(null)
      setCapturingDraft(false)
      setIntroOpen(false)
    }
  }
  // A pick the page has since removed has nothing left to comment on
  if (staged && !staged.path[staged.index].isConnected) setStaged(null)
  useEffect(() => {
    sessionRef.current += 1
    if (!active) {
      draggingRef.current = false
      areaStartRef.current = null
      areaPointerRef.current = null
      cornerDragRef.current = null
    }
  }, [active])

  // Selectors to mask; joined so effects only re-run when the list actually changes
  const masksKey = maskSelectors(phiSelectors).join('\n')

  // Element text as it will be saved (masked), shown in the modal
  const selectedText = useMemo(() => {
    if (!selectedEl) return null
    try {
      return redactedText(selectedEl, masksKey.split('\n'), 80)
    } catch {
      return null
    }
  }, [selectedEl, masksKey])

  // Whether the feedback modal is showing
  const showingFeedback = !!(selectedEl || areaComplete)

  useEffect(() => {
    if (showingFeedback) feedbackOpenedAtRef.current = performance.now()
  }, [showingFeedback])

  // Clear a stale submit error whenever the modal closes
  const [wasShowing, setWasShowing] = useState(showingFeedback)
  if (wasShowing !== showingFeedback) {
    setWasShowing(showingFeedback)
    if (!showingFeedback) setSubmitError(null)
  }

  // Opening from ?: focus comes back to the ? on screen once it closes
  const openIntro = useCallback(() => {
    introReturnRef.current = helpRef.current
    setHoveredEl(null)
    setIntroOpen(true)
  }, [])

  const closeIntro = useCallback(() => setIntroOpen(false), [])

  // Note what was focused as the introduction opens on activation, before it takes focus
  useLayoutEffect(() => {
    if (introOpen && !introReturnRef.current) introReturnRef.current = document.activeElement
  }, [introOpen])

  // Once it closes, focus goes back where it was, or to the ? if that element is gone. A
  // host button that removes itself on click has already left focus on the body by the
  // time Redline renders, so the body counts as gone.
  useEffect(() => {
    if (introOpen) return
    const back = introReturnRef.current
    introReturnRef.current = null
    if (!back || !active) return
    if (back instanceof HTMLElement && back !== document.body && back.isConnected) back.focus()
    else helpRef.current?.focus()
  }, [introOpen, active])

  // ---------------------------------------------------------------------------
  // While on, the page never sees a press: pointerdown/up, mousedown/up, touchstart/end
  // and click are stopped in the capture phase before host handlers (menus that open on
  // pointerdown, links, buttons) react. Redline's own UI is left alone. Touch events are
  // passive and only stopped, so the page can still scroll under a finger.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!active) return

    function isRedlineUi(e: Event): boolean {
      return e.target instanceof Element && !!e.target.closest('[data-redline-ui]')
    }

    // Touch controls follow the finger, desktop controls follow a mouse or pen. The
    // introduction keeps the version it opened with, so a tap on it can't reshape it.
    function followPointer(e: PointerEvent) {
      if (introOpen) return
      const touch = e.pointerType === 'touch'
      setTouchUi(touch)
      if (touch) setHoveredEl(null)
      else {
        // Touch picks and boxes have no controls without the bar
        setStaged(null)
        setAreaDraft(null)
      }
    }

    function handlePress(e: Event) {
      if (e.type === 'pointerdown') {
        const p = e as PointerEvent
        followPointer(p)
        // A finger on the pill's ? swaps the pill for the bar before the ? could be
        // clicked, so the press itself opens the introduction (in its touch version)
        if (p.pointerType === 'touch' && p.target instanceof Element && p.target.closest('[data-redline-help="pill"]')) {
          openIntro()
        }
      }
      if (isRedlineUi(e)) return
      e.preventDefault()
      e.stopPropagation()
    }

    function handleTouch(e: TouchEvent) {
      if (isRedlineUi(e)) return
      e.stopPropagation()
    }

    // A mouse moving after a touch brings the pill and hover back
    function handleMove(e: PointerEvent) {
      if (e.pointerType !== 'touch') followPointer(e)
    }

    document.addEventListener('pointerdown', handlePress, true)
    document.addEventListener('pointerup', handlePress, true)
    document.addEventListener('mousedown', handlePress, true)
    document.addEventListener('mouseup', handlePress, true)
    document.addEventListener('click', handlePress, true)
    document.addEventListener('touchstart', handleTouch, { capture: true, passive: true })
    document.addEventListener('touchend', handleTouch, { capture: true, passive: true })
    document.addEventListener('pointermove', handleMove, true)

    return () => {
      document.removeEventListener('pointerdown', handlePress, true)
      document.removeEventListener('pointerup', handlePress, true)
      document.removeEventListener('mousedown', handlePress, true)
      document.removeEventListener('mouseup', handlePress, true)
      document.removeEventListener('click', handlePress, true)
      document.removeEventListener('touchstart', handleTouch, true)
      document.removeEventListener('touchend', handleTouch, true)
      document.removeEventListener('pointermove', handleMove, true)
    }
  }, [active, introOpen, openIntro])

  // ---------------------------------------------------------------------------
  // Element mode. Mouse and pen: hover tracking + release to select. Touch: only a
  // true tap stages a pick; a finger that travels is a scroll and picks nothing.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!active || mode !== 'element' || selectedEl || introOpen) return

    function isInteresting(el: HTMLElement): boolean {
      if (el === document.body || el === document.documentElement) return false
      if (el.closest('[data-redline-ui]')) return false
      const rect = el.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      if (rect.width > vw * 0.9 && rect.height > vh * 0.9) return false
      return true
    }

    function findBestTarget(x: number, y: number): HTMLElement | null {
      const el = document.elementFromPoint(x, y) as HTMLElement | null
      if (!el) return null
      if (isInteresting(el)) return el
      let current = el.parentElement
      while (current) {
        if (isInteresting(current)) return current
        current = current.parentElement
      }
      return null
    }

    // Where the current touch went down, until it travels too far or is cancelled
    let tap: { id: number; x: number; y: number } | null = null
    const travelled = (e: PointerEvent, from: { x: number; y: number }) =>
      Math.hypot(e.clientX - from.x, e.clientY - from.y) > TAP_SLOP_PX

    function handleDown(e: PointerEvent) {
      if (e.pointerType !== 'touch' || !e.isPrimary) return
      const onRedline = e.target instanceof Element && !!e.target.closest('[data-redline-ui]')
      tap = onRedline ? null : { id: e.pointerId, x: e.clientX, y: e.clientY }
    }

    function handleMove(e: PointerEvent) {
      if (e.pointerType === 'touch') {
        if (tap && e.pointerId === tap.id && travelled(e, tap)) tap = null
        return
      }
      const target = findBestTarget(e.clientX, e.clientY)
      setHoveredEl(target)
    }

    function handleCancel(e: PointerEvent) {
      if (tap && e.pointerId === tap.id) tap = null
    }

    function handleTapUp(e: PointerEvent) {
      const start = tap
      tap = null
      if (!start || e.pointerId !== start.id || travelled(e, start)) return
      const hit = document.elementFromPoint(e.clientX, e.clientY)
      if (!hit || hit.closest('[data-redline-ui]')) return
      // Tapping elsewhere moves the pick; tapping bare page drops it
      const path = pickPath(hit)
      setOutlineGlides(true)
      setStaged(path.length ? { path, index: defaultPickIndex(path) } : null)
    }

    function handleUp(e: PointerEvent) {
      if (e.pointerType === 'touch') {
        handleTapUp(e)
        return
      }
      // A primary-button release, as a click would be; the click itself is stopped above
      if (!e.isPrimary || e.button !== 0) return
      const el = e.target as HTMLElement
      if (el.closest('[data-redline-ui]')) return

      e.preventDefault()
      e.stopPropagation()

      const target = findBestTarget(e.clientX, e.clientY)
      if (target) {
        setSelectedEl(target)
        setHoveredEl(null)
      }
    }

    document.addEventListener('pointerdown', handleDown, true)
    document.addEventListener('pointermove', handleMove, true)
    document.addEventListener('pointercancel', handleCancel, true)
    document.addEventListener('pointerup', handleUp, true)

    return () => {
      document.removeEventListener('pointerdown', handleDown, true)
      document.removeEventListener('pointermove', handleMove, true)
      document.removeEventListener('pointercancel', handleCancel, true)
      document.removeEventListener('pointerup', handleUp, true)
    }
  }, [active, mode, selectedEl, introOpen])

  // Keep the pick outline on its element while the page scrolls or resizes under it
  const hasStaged = !!staged
  useEffect(() => {
    if (!hasStaged) return
    function follow() {
      setOutlineGlides(false)
      setLayoutTick((n) => n + 1)
    }
    window.addEventListener('scroll', follow, { capture: true, passive: true })
    window.addEventListener('resize', follow)
    return () => {
      window.removeEventListener('scroll', follow, true)
      window.removeEventListener('resize', follow)
    }
  }, [hasStaged])

  // The staged pick in plain words for the bar; masked text never appears
  const stagedEl = staged ? staged.path[staged.index] : null
  const stagedName = useMemo(() => {
    if (!stagedEl) return null
    try {
      return describeElement(stagedEl, masksKey.split('\n'))
    } catch {
      return 'This part of the page'
    }
  }, [stagedEl, masksKey])

  // Capture area screenshot
  const captureArea = useCallback(async (area: AreaRect) => {
    const { x, y, w, h } = normalizeArea(area)
    const session = sessionRef.current
    setScreenshotDropped(false)
    try {
      const dpr = window.devicePixelRatio || 1
      const scrollX = window.scrollX
      const scrollY = window.scrollY
      const fullCanvas = await captureMasked(document.documentElement, masksKey.split('\n'), {
        scale: dpr,
      })
      // Redline was turned off while the page was drawn: nothing to show any more
      if (session !== sessionRef.current) return

      // Crop to selected area — clientX/Y are viewport-relative, so add scroll
      // offset to map to the correct position in the full-document canvas
      const cropCanvas = document.createElement('canvas')
      cropCanvas.width = w * dpr
      cropCanvas.height = h * dpr
      const ctx = cropCanvas.getContext('2d')
      if (ctx) {
        ctx.drawImage(
          fullCanvas,
          (x + scrollX) * dpr, (y + scrollY) * dpr, w * dpr, h * dpr,
          0, 0, w * dpr, h * dpr,
        )
      }
      screenshotCanvasRef.current = cropCanvas
      setAreaPreview(cropCanvas)
      setIncludeScreenshot(true)
      setAreaComplete(true)
      console.log('[redline] area screenshot captured:', w, 'x', h)
      setTimeout(() => inputRef.current?.focus(), 50)
    } catch (err) {
      if (session !== sessionRef.current) return
      // Masking or capture failed: drop the screenshot rather than send it unmasked
      console.warn('[redline] area screenshot dropped:', err)
      screenshotCanvasRef.current = null
      setAreaPreview(null)
      setIncludeScreenshot(false)
      setScreenshotDropped(true)
      // Still show feedback modal even if capture fails
      setAreaComplete(true)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [masksKey])

  // ---------------------------------------------------------------------------
  // Area mode: drag on the interaction overlay to select a region. The overlay
  // captures the pointer, so the drag keeps tracking outside it and the release
  // always arrives. Drag state lives in refs; the handlers below read them.
  // A mouse release captures straight away. A finger leaves a box with corner
  // handles to adjust, captured when the tester presses Comment.
  // ---------------------------------------------------------------------------
  const resetAreaDrag = useCallback(() => {
    draggingRef.current = false
    areaStartRef.current = null
    areaPointerRef.current = null
    cornerDragRef.current = null
    setDragging(false)
    setAreaRect(null)
  }, [])

  // Keeps a touch point where the tester can see it and reach its handle: on screen,
  // and clear of the bar by enough that a handle's dot isn't hidden under it
  const clampToFree = useCallback((x: number, y: number) => {
    const bar = barRef.current?.getBoundingClientRect()
    const top = bar && barAtTop ? bar.bottom + BAR_CLEARANCE_PX : 0
    const bottom = bar && !barAtTop ? bar.top - BAR_CLEARANCE_PX : window.innerHeight
    return {
      x: Math.min(window.innerWidth, Math.max(0, x)),
      y: Math.min(bottom, Math.max(top, y)),
    }
  }, [barAtTop])

  const handleAreaPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    // Keep the press from the page: no compatibility mousedown, no blur of open menus
    e.preventDefault()
    e.stopPropagation()
    // One finger or the main button draws; a second finger can't restart the drag
    if (!e.isPrimary || e.button !== 0 || capturingDraft) return
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // The pointer is already gone; the drag still works while it stays over the overlay
    }
    const { x, y } = e.pointerType === 'touch' ? clampToFree(e.clientX, e.clientY) : { x: e.clientX, y: e.clientY }
    draggingRef.current = true
    areaPointerRef.current = e.pointerId
    areaStartRef.current = { x, y }
    setDragging(true)
    setAreaRect({ startX: x, startY: y, endX: x, endY: y })
  }, [capturingDraft, clampToFree])

  const handleAreaPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'touch') setMousePos({ x: e.clientX, y: e.clientY })
    if (!draggingRef.current || !areaStartRef.current || e.pointerId !== areaPointerRef.current) return
    const { x, y } = e.pointerType === 'touch' ? clampToFree(e.clientX, e.clientY) : { x: e.clientX, y: e.clientY }
    setAreaRect({ startX: areaStartRef.current.x, startY: areaStartRef.current.y, endX: x, endY: y })
  }, [clampToFree])

  const handleAreaPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    if (!draggingRef.current || !areaStartRef.current || e.pointerId !== areaPointerRef.current) return
    const touch = e.pointerType === 'touch'
    const end = touch ? clampToFree(e.clientX, e.clientY) : { x: e.clientX, y: e.clientY }
    const finalRect: AreaRect = { startX: areaStartRef.current.x, startY: areaStartRef.current.y, endX: end.x, endY: end.y }
    draggingRef.current = false
    areaStartRef.current = null
    areaPointerRef.current = null
    setDragging(false)
    setAreaRect(null)

    // Too small: an accidental touch or click. A box already drawn stays.
    const { w, h } = normalizeArea(finalRect)
    if (w < MIN_AREA_PX || h < MIN_AREA_PX) return

    if (touch) {
      // A finger: leave the box to adjust; Comment captures it
      setAreaDraft(finalRect)
      return
    }
    // Released: capture straight away
    setAreaRect(finalRect)
    captureArea(finalRect)
  }, [captureArea, clampToFree])

  const handleAreaPointerCancel = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerId === areaPointerRef.current) resetAreaDrag()
  }, [resetAreaDrag])

  // A corner handle moves its corner; the opposite corner stays put, and the box never
  // shrinks below the smallest size or turns inside out
  const handleCornerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>, corner: Corner) => {
    e.preventDefault()
    e.stopPropagation()
    if (!e.isPrimary || e.button !== 0 || !areaDraft || capturingDraft) return
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // The pointer is already gone; the drag still works while it stays over the handle
    }
    const { x, y, w, h } = normalizeArea(areaDraft)
    const dirX = corner === 'ne' || corner === 'se' ? 1 : -1
    const dirY = corner === 'sw' || corner === 'se' ? 1 : -1
    const movingX = dirX === 1 ? x + w : x
    const movingY = dirY === 1 ? y + h : y
    cornerDragRef.current = {
      id: e.pointerId,
      fixedX: dirX === 1 ? x : x + w,
      fixedY: dirY === 1 ? y : y + h,
      dirX,
      dirY,
      offX: movingX - e.clientX,
      offY: movingY - e.clientY,
    }
  }, [areaDraft, capturingDraft])

  const handleCornerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = cornerDragRef.current
    if (!drag || e.pointerId !== drag.id) return
    const p = clampToFree(e.clientX + drag.offX, e.clientY + drag.offY)
    const endX = drag.dirX === 1 ? Math.max(p.x, drag.fixedX + MIN_AREA_PX) : Math.min(p.x, drag.fixedX - MIN_AREA_PX)
    const endY = drag.dirY === 1 ? Math.max(p.y, drag.fixedY + MIN_AREA_PX) : Math.min(p.y, drag.fixedY - MIN_AREA_PX)
    setAreaDraft({ startX: drag.fixedX, startY: drag.fixedY, endX, endY })
  }, [clampToFree])

  const handleCornerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    if (cornerDragRef.current?.id === e.pointerId) cornerDragRef.current = null
  }, [])

  // Comment on a drawn box: capture it, then the feedback box takes over
  const commentOnArea = useCallback(async () => {
    if (!areaDraft || capturingDraft) return
    const session = sessionRef.current
    setCapturingDraft(true)
    setAreaRect(areaDraft)
    await captureArea(areaDraft)
    // Turned off meanwhile: deactivation already cleared all of this
    if (session !== sessionRef.current) return
    setCapturingDraft(false)
    setAreaDraft(null)
  }, [areaDraft, capturingDraft, captureArea])

  // While drawing by touch nothing on the page may scroll or zoom. The overlay, handles
  // and bar refuse panning with touch-action; this catches what touch-action misses
  // (older iOS Safari). Lifted the moment Area mode ends, however it ends, and while the
  // introduction is open so it can scroll on a small phone.
  const drawing = active && mode === 'area' && !showingFeedback && !introOpen
  useEffect(() => {
    if (!drawing) return
    const refuse = (e: Event) => e.preventDefault()
    document.addEventListener('touchmove', refuse, { capture: true, passive: false })
    return () => document.removeEventListener('touchmove', refuse, true)
  }, [drawing])

  // Silently capture screenshot via html2canvas when element is selected
  useEffect(() => {
    if (!selectedEl) {
      if (!areaComplete) screenshotCanvasRef.current = null
      return
    }

    // A capture for a pick that has since closed or changed must not touch the next one
    let stale = false
    screenshotChosenRef.current = false

    async function captureElement() {
      if (!selectedEl) return
      setScreenshotDropped(false)
      try {
        const canvas = await captureMasked(selectedEl, masksKey.split('\n'), {
          scale: ELEMENT_CAPTURE_SCALE,
        })
        if (stale) return
        screenshotCanvasRef.current = canvas
        setElementShot({ el: selectedEl, canvas })
        // Testers send the screenshot unless they say otherwise
        if (tester && !screenshotChosenRef.current) setIncludeScreenshot(true)
        console.log('[redline] screenshot captured:', canvas.width, 'x', canvas.height)
      } catch (err) {
        if (stale) return
        // Masking or capture failed: drop the screenshot rather than send it unmasked
        console.warn('[redline] screenshot dropped:', err)
        screenshotCanvasRef.current = null
        // Uncheck, even if the tester ticked it while the capture ran, so the form never
        // claims a screenshot that will not be sent
        setIncludeScreenshot(false)
        setScreenshotDropped(true)
      }
    }

    captureElement()
    setTimeout(() => inputRef.current?.focus(), 50)
    return () => {
      stale = true
    }
  }, [selectedEl, areaComplete, masksKey, tester])

  // Keyboard: Escape to cancel, 's' to toggle mode
  useEffect(() => {
    if (!active) return
    function handleKey(e: KeyboardEvent) {
      // The introduction has the keyboard while it's open; its own Esc never reaches here
      if (introOpen) return
      // Don't intercept keys when typing in the feedback textarea
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'TEXTAREA' || tag === 'INPUT') return

      if (e.key === 'Escape') {
        if (areaComplete) {
          // Cancel area feedback
          setAreaComplete(false)
          setAreaRect(null)
          setFeedback('')
          setIncludeScreenshot(false)
          screenshotCanvasRef.current = null
        } else if (selectedEl) {
          setSelectedEl(null)
          setFeedback('')
        } else if (dragging) {
          resetAreaDrag()
        } else if (areaDraft && !capturingDraft) {
          setAreaDraft(null)
          cornerDragRef.current = null
        } else if (staged) {
          setStaged(null)
        } else {
          onDeactivate()
        }
      }

      if (e.key === 's' && !showingFeedback && !capturingDraft) {
        e.preventDefault()
        // Clear state from the other mode, drag refs included
        resetAreaDrag()
        setAreaDraft(null)
        setStaged(null)
        setHoveredEl(null)
        setMousePos(null)
        setMode((prev: InspectorMode) => (prev === 'element' ? 'area' : 'element'))
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [active, introOpen, selectedEl, areaComplete, dragging, areaDraft, capturingDraft, staged, showingFeedback, onDeactivate, resetAreaDrag])

  // The bar's Element / Area switch
  const chooseMode = useCallback((next: InspectorMode) => {
    resetAreaDrag()
    setAreaDraft(null)
    setStaged(null)
    setHoveredEl(null)
    setMousePos(null)
    setMode(next)
  }, [resetAreaDrag])

  // Smaller walks the pick inward, Bigger outward; both stop at the ends of the path
  const stepPick = useCallback((by: 1 | -1) => {
    setOutlineGlides(true)
    setStaged((prev) => {
      if (!prev) return prev
      const index = Math.min(prev.path.length - 1, Math.max(0, prev.index + by))
      return index === prev.index ? prev : { ...prev, index }
    })
  }, [])

  // Comment hands the pick to the usual flow: screenshot, then the feedback box
  const commentOnPick = useCallback(() => {
    if (!stagedEl) return
    setSelectedEl(stagedEl)
    setStaged(null)
  }, [stagedEl])

  // Submit handler — works for both element and area modes
  const handleSubmit = useCallback(async () => {
    if (!feedback.trim()) return
    if (!selectedEl && !areaComplete) return
    setSubmitting(true)
    setSubmitError(null)

    const isArea = !selectedEl && areaComplete
    const selectorStr = isArea
      ? `area-screenshot:${areaRect ? (() => { const { x, y, w, h } = normalizeArea(areaRect); return `${x},${y},${w},${h}` })() : 'unknown'}`
      : generateSelector(selectedEl!)
    let elementText: string | null = null
    if (!isArea) {
      try {
        elementText = redactedText(selectedEl!, masksKey.split('\n'), 200)
      } catch (err) {
        console.warn('[redline] element text dropped:', err)
      }
    }
    const pageUrl = sanitizePageUrl(window.location.pathname + window.location.search + window.location.hash)

    try {
      console.log('[redline] submit: includeScreenshot=', includeScreenshot, 'canvasRef=', !!screenshotCanvasRef.current)
      let screenshotBlob: Blob | null = null
      if (includeScreenshot && screenshotCanvasRef.current) {
        screenshotBlob = await new Promise<Blob | null>((resolve) => {
          screenshotCanvasRef.current!.toBlob((blob: Blob | null) => resolve(blob), 'image/png')
        })
      }

      let res: Response
      if (screenshotBlob) {
        const formData = new FormData()
        formData.append('page_url', pageUrl)
        formData.append('element_selector', selectorStr)
        formData.append('element_text', elementText || '')
        formData.append('feedback', feedback.trim())
        formData.append('ux_review_requested', String(requestUxReview))
        formData.append('screenshot', screenshotBlob, 'screenshot.png')
        res = await fetch(apiUrl, { method: 'POST', body: formData })
      } else {
        res = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            page_url: pageUrl,
            element_selector: selectorStr,
            element_text: elementText,
            feedback: feedback.trim(),
            ux_review_requested: requestUxReview,
          }),
        })
      }
      if (!res.ok) {
        setSubmitError(await submitErrorMessage(res, includeScreenshot && !!screenshotCanvasRef.current))
        return
      }
      window.dispatchEvent(new CustomEvent('redline:submitted'))
      setSelectedEl(null)
      setAreaComplete(false)
      setAreaRect(null)
      setFeedback('')
      setIncludeScreenshot(false)
      onDeactivate()
    } catch {
      setSubmitError("Couldn't reach the server. Try again.")
    } finally {
      setSubmitting(false)
    }
  }, [selectedEl, areaComplete, areaRect, feedback, includeScreenshot, requestUxReview, apiUrl, onDeactivate, masksKey])

  if (!active) return null

  // Picking controls and overlays show only while neither the feedback box nor the
  // introduction is up
  const picking = !showingFeedback && !introOpen

  // Compute element highlight rect
  const targetEl = selectedEl || hoveredEl
  const elRect = targetEl?.getBoundingClientRect()

  // Compute area selection rect for rendering
  const areaNorm = areaRect ? normalizeArea(areaRect) : null

  // Current page URL — shown in the feedback modal and saved with every redline
  const pageUrl =
    typeof window !== 'undefined'
      ? sanitizePageUrl(window.location.pathname + window.location.search + window.location.hash)
      : ''

  // The box's checkboxes: as on desktop, or a full 44px row a thumb can hit
  const checkLabel: CSSProperties = touchUi
    ? { display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, fontSize: 15, color: '#aaa', cursor: 'pointer', userSelect: 'none' }
    : { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#aaa', cursor: 'pointer', userSelect: 'none' }
  const checkBox: CSSProperties = touchUi ? { accentColor: '#ef4444', width: 20, height: 20, margin: 0 } : { accentColor: '#ef4444' }

  // Dimensions tooltip for a mouse drag (a finger would cover it)
  const dimLabel = areaNorm && dragging && !touchUi ? `${areaNorm.w} × ${areaNorm.h}` : null

  // The box on screen in Area mode: the one being dragged, else the touch box to adjust
  const boxNorm = areaNorm ?? (areaDraft ? normalizeArea(areaDraft) : null)
  const showDraft = !!areaDraft && !dragging
  const showHandles = showDraft && !capturingDraft

  // The staged pick's box, read fresh each render (a step, a scroll, a resize)
  const stagedRect = mode === 'element' && !selectedEl && !introOpen ? stagedEl?.getBoundingClientRect() : undefined
  const pickCount = staged?.path.length ?? 0
  const canShrink = !!staged && staged.index > 0
  const canGrow = !!staged && staged.index < pickCount - 1

  return (
    <>
      {/* Cursor overlay. While picking, a long press can't open the browser's link
          preview or start a text selection on the page. */}
      <style>{`
        ${picking ? '* { cursor: crosshair !important; -webkit-touch-callout: none !important; -webkit-user-select: none !important; user-select: none !important; } [data-redline-ui] button { cursor: pointer !important; }' : ''}
      `}</style>

      {/* Mode indicator pill (mouse and pen) */}
      {picking && !touchUi && (
        <div
          data-redline-ui
          {...KEEP_FROM_PAGE}
          style={{
            position: 'fixed',
            top: 12,
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            backgroundColor: '#1a1a1a',
            border: '1px solid #333',
            borderRadius: 8,
            padding: '6px 14px',
            zIndex: 99999,
            fontFamily: 'system-ui, sans-serif',
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
          }}
        >
          <span style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            backgroundColor: '#ef4444',
            animation: 'redline-pulse 2s ease-in-out infinite',
          }} />
          <span style={{ color: '#eee', fontSize: 12, fontWeight: 600 }}>
            {mode === 'element' ? 'Select Element' : 'Area Screenshot'}
          </span>
          <span style={{
            color: '#666',
            fontSize: 10,
            marginLeft: 4,
            padding: '1px 6px',
            backgroundColor: '#222',
            borderRadius: 4,
            border: '1px solid #333',
          }}>
            S
          </span>
          <span style={{ color: '#555', fontSize: 10 }}>
            to switch
          </span>
          <button
            ref={helpRef}
            type="button"
            data-redline-ui
            data-redline-help="pill"
            aria-label="Show introduction"
            title="Show introduction"
            onClick={openIntro}
            style={{
              marginLeft: 2,
              width: 18,
              height: 18,
              padding: 0,
              borderRadius: '50%',
              border: '1px solid #333',
              backgroundColor: '#222',
              color: '#888',
              fontSize: 11,
              fontWeight: 700,
              fontFamily: 'inherit',
              lineHeight: '16px',
              cursor: 'pointer',
            }}
          >
            ?
          </button>
        </div>
      )}

      {/* Touch bar, in place of the pill, in the thumb zone (or docked at the top) */}
      {picking && touchUi && (
        <div
          ref={barRef}
          data-redline-ui
          data-testid="redline-touch-bar"
          {...KEEP_FROM_PAGE}
          style={{
            position: 'fixed',
            left: 0,
            right: 0,
            ...(barAtTop ? { top: 0 } : { bottom: 0 }),
            zIndex: 99999,
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            padding: barAtTop
              ? 'calc(12px + env(safe-area-inset-top)) 12px 12px'
              : '12px 12px calc(12px + env(safe-area-inset-bottom))',
            backgroundColor: '#1a1a1a',
            ...(barAtTop
              ? { borderBottom: '1px solid #333', boxShadow: '0 8px 24px rgba(0,0,0,0.35)' }
              : { borderTop: '1px solid #333', boxShadow: '0 -8px 24px rgba(0,0,0,0.35)' }),
            fontFamily: 'system-ui, -apple-system, sans-serif',
            // While drawing, a swipe on the bar mustn't scroll the page under the box
            touchAction: mode === 'area' ? 'none' : 'manipulation',
            userSelect: 'none',
            WebkitUserSelect: 'none',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          {/* Cancel sits on the left, never where Done sits, so a double tap on it
              can't land on Done and turn Redline off */}
          {staged ? (
            <>
              <div style={BAR_ROW}>
                <button type="button" data-redline-ui onClick={() => setStaged(null)} style={BAR_BUTTON}>
                  Cancel
                </button>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span aria-hidden style={{ width: 12, height: 12, flexShrink: 0, boxSizing: 'border-box', border: '2px solid #ef4444', borderRadius: 3 }} />
                  <span
                    data-testid="redline-pick-name"
                    aria-live="polite"
                    style={{ color: '#eee', fontSize: 16, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {stagedName}
                  </span>
                </div>
              </div>
              <div style={BAR_ROW}>
                <button
                  type="button"
                  data-redline-ui
                  disabled={!canShrink}
                  onClick={() => stepPick(-1)}
                  style={{ ...(canShrink ? BAR_BUTTON : BAR_BUTTON_DISABLED), minHeight: 52 }}
                >
                  Smaller
                </button>
                <button
                  type="button"
                  data-redline-ui
                  disabled={!canGrow}
                  onClick={() => stepPick(1)}
                  style={{ ...(canGrow ? BAR_BUTTON : BAR_BUTTON_DISABLED), minHeight: 52 }}
                >
                  Bigger
                </button>
                <button type="button" data-redline-ui onClick={commentOnPick} style={BAR_COMMENT}>
                  Comment
                </button>
              </div>
            </>
          ) : areaDraft && mode === 'area' ? (
            <>
              <div style={BAR_ROW}>
                <button
                  type="button"
                  data-redline-ui
                  disabled={capturingDraft}
                  onClick={() => setAreaDraft(null)}
                  style={capturingDraft ? BAR_BUTTON_DISABLED : BAR_BUTTON}
                >
                  Cancel
                </button>
                <span style={{ flex: 1, minWidth: 0, color: '#aaa', fontSize: 15 }}>
                  Adjust the corners, then Comment.
                </span>
              </div>
              <div style={BAR_ROW}>
                <button
                  type="button"
                  data-redline-ui
                  disabled={capturingDraft}
                  onClick={commentOnArea}
                  style={{ ...BAR_COMMENT, ...(capturingDraft ? { opacity: 0.6, cursor: 'default' } : null) }}
                >
                  {capturingDraft ? 'Capturing\u2026' : 'Comment'}
                </button>
              </div>
            </>
          ) : (
            <>
              <div style={BAR_ROW}>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span
                    aria-hidden
                    style={{ width: 8, height: 8, flexShrink: 0, borderRadius: '50%', backgroundColor: '#ef4444', animation: 'redline-pulse 2s ease-in-out infinite' }}
                  />
                  <span style={{ color: '#aaa', fontSize: 15 }}>
                    {mode === 'element' ? 'Tap what you want to comment on.' : 'Drag to draw a box.'}
                  </span>
                </div>
                <button type="button" data-redline-ui onClick={() => onDeactivate()} style={BAR_BUTTON}>
                  Done
                </button>
              </div>
              <div style={BAR_ROW}>
                <div
                  role="group"
                  aria-label="What to pick"
                  style={{ flex: 1, minWidth: 0, display: 'flex', gap: 3, padding: 3, backgroundColor: '#111', border: '1px solid #333', borderRadius: 12 }}
                >
                  {(['element', 'area'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      data-redline-ui
                      aria-pressed={mode === m}
                      onClick={() => chooseMode(m)}
                      style={{
                        ...BAR_BUTTON,
                        flex: 1,
                        padding: '0 8px',
                        border: 'none',
                        borderRadius: 9,
                        backgroundColor: mode === m ? '#333' : 'transparent',
                        color: mode === m ? '#eee' : '#888',
                      }}
                    >
                      {m === 'element' ? 'Element' : 'Area'}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  data-redline-ui
                  aria-label={barAtTop ? 'Move bar to bottom' : 'Move bar to top'}
                  title={barAtTop ? 'Move bar to bottom' : 'Move bar to top'}
                  onClick={() => setBarAtTop((top) => !top)}
                  style={{ ...BAR_BUTTON, width: 44, minHeight: 52, padding: 0, border: 'none', color: '#888', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  {/* An arrow to the edge the bar will move to */}
                  <svg
                    aria-hidden
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ transform: barAtTop ? 'rotate(180deg)' : undefined }}
                  >
                    <path d="M5 3h14" />
                    <path d="M12 21V8" />
                    <path d="m6 13 6-6 6 6" />
                  </svg>
                </button>
                <button
                  ref={helpRef}
                  type="button"
                  data-redline-ui
                  aria-label="Show introduction"
                  onClick={openIntro}
                  style={{ ...BAR_BUTTON, width: 52, minHeight: 52, padding: 0, borderRadius: '50%', color: '#aaa', fontSize: 18 }}
                >
                  ?
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Pulse animation */}
      <style>{`
        @keyframes redline-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>

      {/* Touch pick outline: glides between Smaller and Bigger steps */}
      {stagedRect && (
        <div
          data-redline-ui
          data-testid="redline-pick-outline"
          style={{
            position: 'fixed',
            top: stagedRect.top - 2,
            left: stagedRect.left - 2,
            width: stagedRect.width + 4,
            height: stagedRect.height + 4,
            boxSizing: 'border-box',
            border: '2px solid #ef4444',
            backgroundColor: 'rgba(239, 68, 68, 0.08)',
            borderRadius: 4,
            pointerEvents: 'none',
            zIndex: 99998,
            transition: outlineGlides ? 'top 150ms ease-out, left 150ms ease-out, width 150ms ease-out, height 150ms ease-out' : 'none',
          }}
        />
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Element mode overlays                                               */}
      {/* ------------------------------------------------------------------ */}
      {mode === 'element' && !introOpen && elRect && targetEl && (
        <>
          {/* Highlight overlay */}
          <div
            data-redline-ui
            ref={overlayRef}
            style={{
              position: 'fixed',
              top: elRect.top - 2,
              left: elRect.left - 2,
              width: elRect.width + 4,
              height: elRect.height + 4,
              border: selectedEl ? '2px solid #ef4444' : '2px dashed #ef4444',
              backgroundColor: selectedEl ? 'rgba(239, 68, 68, 0.08)' : 'rgba(239, 68, 68, 0.05)',
              borderRadius: 4,
              pointerEvents: 'none',
              zIndex: 99998,
              transition: 'all 0.1s ease-out',
            }}
          />

          {/* Element label */}
          {!selectedEl && (
            <div
              data-redline-ui
              style={{
                position: 'fixed',
                top: Math.max(4, elRect.top - 24),
                left: elRect.left,
                backgroundColor: '#ef4444',
                color: 'white',
                fontSize: 10,
                fontFamily: 'monospace',
                padding: '2px 6px',
                borderRadius: 3,
                zIndex: 99999,
                pointerEvents: 'none',
                whiteSpace: 'nowrap',
              }}
            >
              {targetEl.tagName.toLowerCase()}
              {targetEl.getAttribute('data-testid') ? `[${targetEl.getAttribute('data-testid')}]` : ''}
            </div>
          )}
        </>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Area mode overlays                                                  */}
      {/* ------------------------------------------------------------------ */}
      {mode === 'area' && !areaComplete && !introOpen && (
        <>
          {/* Interaction overlay — captures all pointer events so page elements
              (dropdowns, menus, etc.) don't receive pointerdown/blur and stay open.
              touch-action: none keeps a finger drawing instead of scrolling. */}
          <div
            data-redline-ui
            data-redline-area-overlay
            {...KEEP_FROM_PAGE}
            onPointerDown={handleAreaPointerDown}
            onPointerMove={handleAreaPointerMove}
            onPointerUp={handleAreaPointerUp}
            onPointerCancel={handleAreaPointerCancel}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 99996,
              cursor: 'crosshair',
              touchAction: 'none',
            }}
          />

          {/* Dimming overlay — covers full viewport, area selection punches through */}
          {dragging && areaNorm && (
            <div
              data-redline-ui
              style={{
                position: 'fixed',
                inset: 0,
                backgroundColor: 'rgba(0, 0, 0, 0.4)',
                zIndex: 99997,
                pointerEvents: 'none',
              }}
            />
          )}

          {/* Selection rectangle: the drag in progress, or the touch box to adjust */}
          {boxNorm && boxNorm.w > 0 && boxNorm.h > 0 && (
            <div
              data-redline-ui
              data-testid={showDraft ? 'redline-area-draft' : undefined}
              style={{
                position: 'fixed',
                top: boxNorm.y,
                left: boxNorm.x,
                width: boxNorm.w,
                height: boxNorm.h,
                boxSizing: 'border-box',
                border: '2px solid #ef4444',
                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                zIndex: 99998,
                pointerEvents: 'none',
                boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.4)',
              }}
            />
          )}

          {/* Corner handles: a 44px target around each corner, a dot to see */}
          {showHandles && boxNorm && CORNERS.map((corner) => (
            <div
              key={corner}
              data-redline-ui
              data-redline-handle={corner}
              {...KEEP_FROM_PAGE}
              onPointerDown={(e) => handleCornerDown(e, corner)}
              onPointerMove={handleCornerMove}
              onPointerUp={handleCornerUp}
              onPointerCancel={handleCornerUp}
              style={{
                position: 'fixed',
                left: (corner === 'nw' || corner === 'sw' ? boxNorm.x : boxNorm.x + boxNorm.w) - 22,
                top: (corner === 'nw' || corner === 'ne' ? boxNorm.y : boxNorm.y + boxNorm.h) - 22,
                width: 44,
                height: 44,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 99998,
                touchAction: 'none',
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 18,
                  height: 18,
                  boxSizing: 'border-box',
                  borderRadius: '50%',
                  backgroundColor: 'white',
                  border: '3px solid #ef4444',
                  boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
                  pointerEvents: 'none',
                }}
              />
            </div>
          ))}

          {/* Dimensions tooltip */}
          {dimLabel && mousePos && (
            <div
              data-redline-ui
              style={{
                position: 'fixed',
                top: mousePos.y + 20,
                left: mousePos.x + 14,
                backgroundColor: '#ef4444',
                color: 'white',
                fontSize: 11,
                fontFamily: 'monospace',
                fontWeight: 600,
                padding: '3px 8px',
                borderRadius: 4,
                zIndex: 99999,
                pointerEvents: 'none',
                whiteSpace: 'nowrap',
              }}
            >
              {dimLabel}
            </div>
          )}
        </>
      )}

      {introOpen && (
        <RedlineIntro audience={audience} touch={touchUi} shortcuts={shortcuts} onClose={closeIntro} />
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Feedback modal (shared between element + area modes)                */}
      {/* ------------------------------------------------------------------ */}
      {showingFeedback && (
        <div
          data-redline-ui
          {...KEEP_FROM_PAGE}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 99999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(0,0,0,0.5)',
          }}
          onPointerDown={(e) => {
            e.stopPropagation()
            // The second tap of a double tap on Comment lands here; it isn't a request to close
            backdropPressRef.current = e.target === e.currentTarget && performance.now() - feedbackOpenedAtRef.current > DOUBLE_TAP_MS
          }}
          onPointerUp={(e) => {
            e.stopPropagation()
            backdropReleaseRef.current = e.target === e.currentTarget
          }}
          onClick={(e) => {
            e.stopPropagation()
            // Closes only when the backdrop got both the press and the release, so a press
            // that began on the bar or in the box (a text selection dragged out of it), or a
            // press on the backdrop let go inside the box, doesn't throw the note away
            const onBackdrop = backdropPressRef.current && backdropReleaseRef.current
            backdropPressRef.current = false
            backdropReleaseRef.current = false
            if (onBackdrop && e.target === e.currentTarget) {
              setSelectedEl(null)
              setAreaComplete(false)
              setAreaRect(null)
              setFeedback('')
              setIncludeScreenshot(false)
            }
          }}
        >
          <div
            data-redline-ui
            style={{
              backgroundColor: '#1a1a1a',
              border: '1px solid #333',
              borderRadius: 12,
              padding: 20,
              // 400px of content on desktop, as always; on a phone it keeps a 16px gutter
              boxSizing: 'border-box',
              width: 442,
              maxWidth: 'calc(100vw - 32px)',
              // A tall area preview scrolls inside the box instead of running off screen
              maxHeight: 'calc(100% - 32px)',
              overflowY: 'auto',
              boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <span style={tester ? { color: '#eee', fontSize: touchUi ? 18 : 15, fontWeight: 600 } : { color: '#ef4444', fontSize: 13, fontWeight: 600 }}>
                {tester ? "What's wrong here?" : areaComplete ? 'Area Feedback' : 'Redline Feedback'}
              </span>
              <button
                data-redline-ui
                aria-label="Close"
                onClick={() => {
                  setSelectedEl(null)
                  setAreaComplete(false)
                  setAreaRect(null)
                  setFeedback('')
                  setIncludeScreenshot(false)
                }}
                style={{
                  color: '#666',
                  fontSize: 18,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  lineHeight: 1,
                  // A thumb-sized target on touch, without pushing the title down
                  ...(touchUi ? { width: 44, height: 44, margin: '-12px -12px -12px 0', fontSize: 26, color: '#888' } : null),
                }}
              >
                &times;
              </button>
            </div>

            {/* Page URL — saved with every redline */}
            <div
              data-redline-ui
              title={pageUrl}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11,
                color: '#888',
                marginBottom: 8,
                fontFamily: 'monospace',
                padding: '6px 8px',
                backgroundColor: '#111',
                borderRadius: 6,
              }}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#ef4444"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: 0 }}
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M2 12h20" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {pageUrl}
              </span>
            </div>

            {/* Element selector (element mode, developers); testers see only its text */}
            {selectedEl && (
              <>
                {!tester && (
                  <div style={{ fontSize: 11, color: '#888', marginBottom: 8, fontFamily: 'monospace', padding: '6px 8px', backgroundColor: '#111', borderRadius: 6, wordBreak: 'break-all' }}>
                    {generateSelector(selectedEl)}
                  </div>
                )}
                {selectedText && (
                  <div style={{ fontSize: tester && touchUi ? 14 : 11, color: '#aaa', marginBottom: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    &ldquo;{selectedText}&rdquo;
                  </div>
                )}
              </>
            )}

            {/* Screenshot preview (element mode): exactly what will be sent, while ticked */}
            {selectedEl && elementShot?.el === selectedEl && includeScreenshot && !screenshotDropped && (
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12, borderRadius: 6, overflow: 'hidden', border: '1px solid #333', backgroundColor: '#111' }}>
                <canvas
                  data-redline-ui
                  data-testid="redline-element-preview"
                  ref={(el) => drawElementPreview(el, elementShot.canvas, ELEMENT_CAPTURE_SCALE)}
                />
              </div>
            )}

            {/* Area info (area mode, developers) */}
            {!tester && areaComplete && areaNorm && (
              <div style={{ fontSize: 11, color: '#888', marginBottom: 8, fontFamily: 'monospace', padding: '6px 8px', backgroundColor: '#111', borderRadius: 6 }}>
                area: {areaNorm.w} &times; {areaNorm.h}px at ({areaNorm.x}, {areaNorm.y})
              </div>
            )}

            {/* Screenshot preview (area mode) */}
            {areaComplete && areaPreview && (
              <div style={{ marginBottom: 12, borderRadius: 6, overflow: 'hidden', border: '1px solid #333' }}>
                <canvas
                  ref={(el) => {
                    if (el) {
                      const ctx = el.getContext('2d')
                      const src = areaPreview
                      // Scale down to fit modal width (~360px)
                      const maxW = 360
                      const scale = Math.min(1, maxW / (src.width / (window.devicePixelRatio || 1)))
                      el.width = src.width * scale
                      el.height = src.height * scale
                      el.style.width = '100%'
                      el.style.height = 'auto'
                      // A block, so no strip of line-box space shows under the picture
                      el.style.display = 'block'
                      if (ctx) {
                        ctx.drawImage(src, 0, 0, el.width, el.height)
                      }
                    }
                  }}
                  data-redline-ui
                />
              </div>
            )}

            <textarea
              ref={inputRef}
              data-redline-ui
              value={feedback}
              onChange={(e) => { setFeedback(e.target.value); setSubmitError(null) }}
              placeholder="What's wrong? What should change?"
              maxLength={LIMITS.feedback}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit() }}
              style={{
                boxSizing: 'border-box',
                width: '100%',
                minHeight: 80,
                backgroundColor: '#111',
                border: '1px solid #333',
                borderRadius: 8,
                color: '#eee',
                // iOS zooms the page into a field whose type is under 16px
                fontSize: touchUi ? 16 : 13,
                padding: '10px 12px',
                resize: 'vertical',
                outline: 'none',
                fontFamily: 'inherit',
              }}
            />
            <div style={{ fontSize: touchUi ? 12 : 10, color: touchUi ? '#888' : '#666', marginTop: touchUi ? 6 : 4 }}>
              Masked fields are blacked out in screenshots. Don&rsquo;t type patient or personal details here.
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: touchUi ? 0 : 6, marginTop: touchUi ? 4 : 10 }}>
              <label
                data-redline-ui
                style={checkLabel}
              >
                <input
                  type="checkbox"
                  data-redline-ui
                  checked={includeScreenshot && !screenshotDropped}
                  disabled={screenshotDropped}
                  onChange={(e) => {
                    screenshotChosenRef.current = true
                    setIncludeScreenshot(e.target.checked)
                  }}
                  style={checkBox}
                />
                Include Screenshot
              </label>
              {screenshotDropped && (
                <div data-redline-ui style={{ fontSize: touchUi ? 13 : 10, color: '#f87171', marginTop: -2 }}>
                  Screenshot dropped: masking failed.
                </div>
              )}
              {!tester && (
                <label
                  data-redline-ui
                  style={checkLabel}
                >
                  <input
                    type="checkbox"
                    data-redline-ui
                    checked={requestUxReview}
                    onChange={(e) => setRequestUxReview(e.target.checked)}
                    style={checkBox}
                  />
                  Request UX Review
                </label>
              )}
            </div>

            {submitError && (
              <div role="alert" style={{ fontSize: 12, color: '#f87171', marginTop: 10 }}>
                {submitError}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: touchUi ? 10 : 8, marginTop: 12 }}>
              <button
                data-redline-ui
                onClick={() => {
                  setSelectedEl(null)
                  setAreaComplete(false)
                  setAreaRect(null)
                  setFeedback('')
                  setIncludeScreenshot(false)
                }}
                style={{
                  padding: '6px 14px',
                  fontSize: 12,
                  borderRadius: 6,
                  border: '1px solid #333',
                  backgroundColor: 'transparent',
                  color: '#aaa',
                  cursor: 'pointer',
                  ...(touchUi ? TOUCH_BOX_BUTTON : null),
                }}
              >
                Cancel
              </button>
              <button
                data-redline-ui
                onClick={handleSubmit}
                disabled={submitting || !feedback.trim()}
                style={{
                  padding: '6px 14px',
                  fontSize: 12,
                  borderRadius: 6,
                  border: 'none',
                  backgroundColor: submitting || !feedback.trim() ? '#333' : '#ef4444',
                  color: submitting || !feedback.trim() ? '#666' : 'white',
                  cursor: submitting || !feedback.trim() ? 'default' : 'pointer',
                  fontWeight: 600,
                  ...(touchUi ? TOUCH_BOX_BUTTON : null),
                }}
              >
                {submitting ? 'Submitting...' : 'Submit'}
              </button>
            </div>

            {!tester && (
              <div style={{ fontSize: 10, color: '#555', marginTop: 8, textAlign: 'right' }}>
                Cmd+Enter to submit &middot; Esc to cancel
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
