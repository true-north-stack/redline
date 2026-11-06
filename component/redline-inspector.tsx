'use client'

import { useState, useEffect, useCallback, useMemo, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from 'react'
import { LIMITS, maskSelectors, sanitizePageUrl } from './redline-config'
import { captureMasked, redactedText } from './redline-mask'
import { TAP_SLOP_PX, defaultPickIndex, describeElement, pickPath } from './redline-touch'

interface RedlineInspectorProps {
  active: boolean
  onDeactivate: () => void
  apiUrl?: string
  initialMode?: InspectorMode
  /** Extra selectors to mask in screenshots and captured text, on top of [data-phi] */
  phiSelectors?: string[]
}

type InspectorMode = 'element' | 'area'

interface AreaRect {
  startX: number
  startY: number
  endX: number
  endY: number
}

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
const BAR_ROW: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 }

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

export function RedlineInspector({ active, onDeactivate, apiUrl = '/api/redlines', initialMode = 'element', phiSelectors }: RedlineInspectorProps) {
  const [hoveredEl, setHoveredEl] = useState<HTMLElement | null>(null)
  const [selectedEl, setSelectedEl] = useState<HTMLElement | null>(null)
  const [feedback, setFeedback] = useState('')
  const [includeScreenshot, setIncludeScreenshot] = useState(false)
  // Masking or capture failed for the current selection: no screenshot can be attached
  const [screenshotDropped, setScreenshotDropped] = useState(false)
  const [requestUxReview, setRequestUxReview] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const screenshotCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

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

  // Touch controls or desktop controls: starts from the device's main pointer, then
  // follows whatever pressed last, so a touchscreen laptop works with both
  const [touchUi, setTouchUi] = useState(() => active && coarsePointer())

  // Touch picking: a tap stages a pick, Smaller and Bigger walk it, Comment selects it
  const [staged, setStaged] = useState<StagedPick | null>(null)
  // The outline glides to its next box on a step, and jumps when the page scrolls under it
  const [outlineGlides, setOutlineGlides] = useState(false)
  const [, setLayoutTick] = useState(0)

  // On activation, start in initialMode; on deactivation, clear everything. Adjusted while
  // rendering (React's pattern for state that follows a prop), not in an effect.
  const [seen, setSeen] = useState({ active, initialMode })
  if (seen.active !== active || seen.initialMode !== initialMode) {
    setSeen({ active, initialMode })
    if (active) {
      setMode(initialMode)
      if (!seen.active) setTouchUi(coarsePointer())
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
    }
  }
  // A pick the page has since removed has nothing left to comment on
  if (staged && !staged.path[staged.index].isConnected) setStaged(null)
  useEffect(() => {
    if (!active) {
      draggingRef.current = false
      areaStartRef.current = null
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

  // Clear a stale submit error whenever the modal closes
  const [wasShowing, setWasShowing] = useState(showingFeedback)
  if (wasShowing !== showingFeedback) {
    setWasShowing(showingFeedback)
    if (!showingFeedback) setSubmitError(null)
  }

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

    // Touch controls follow the finger, desktop controls follow a mouse or pen
    function followPointer(e: PointerEvent) {
      const touch = e.pointerType === 'touch'
      setTouchUi(touch)
      if (touch) setHoveredEl(null)
      else setStaged(null)
    }

    function handlePress(e: Event) {
      if (e.type === 'pointerdown') followPointer(e as PointerEvent)
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
  }, [active])

  // ---------------------------------------------------------------------------
  // Element mode. Mouse and pen: hover tracking + release to select. Touch: only a
  // true tap stages a pick; a finger that travels is a scroll and picks nothing.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!active || mode !== 'element' || selectedEl) return

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
  }, [active, mode, selectedEl])

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
    setScreenshotDropped(false)
    try {
      const dpr = window.devicePixelRatio || 1
      const scrollX = window.scrollX
      const scrollY = window.scrollY
      const fullCanvas = await captureMasked(document.documentElement, masksKey.split('\n'), {
        scale: dpr,
      })

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
  // ---------------------------------------------------------------------------
  const resetAreaDrag = useCallback(() => {
    draggingRef.current = false
    areaStartRef.current = null
    setDragging(false)
    setAreaRect(null)
  }, [])

  const handleAreaPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    // Keep the press from the page: no compatibility mousedown, no blur of open menus
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    draggingRef.current = true
    areaStartRef.current = { x: e.clientX, y: e.clientY }
    setDragging(true)
    setAreaRect({ startX: e.clientX, startY: e.clientY, endX: e.clientX, endY: e.clientY })
  }, [])

  const handleAreaPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    setMousePos({ x: e.clientX, y: e.clientY })
    if (!draggingRef.current || !areaStartRef.current) return
    setAreaRect({
      startX: areaStartRef.current.x,
      startY: areaStartRef.current.y,
      endX: e.clientX,
      endY: e.clientY,
    })
  }, [])

  const handleAreaPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current || !areaStartRef.current) return
    draggingRef.current = false
    setDragging(false)

    const finalRect: AreaRect = {
      startX: areaStartRef.current.x,
      startY: areaStartRef.current.y,
      endX: e.clientX,
      endY: e.clientY,
    }
    areaStartRef.current = null
    const { w, h } = normalizeArea(finalRect)

    if (w < 20 || h < 20) {
      // Too small: an accidental click, reset
      setAreaRect(null)
      return
    }

    // Released: capture straight away
    setAreaRect(finalRect)
    captureArea(finalRect)
  }, [captureArea])

  // Silently capture screenshot via html2canvas when element is selected
  useEffect(() => {
    if (!selectedEl) {
      if (!areaComplete) screenshotCanvasRef.current = null
      return
    }

    async function captureElement() {
      if (!selectedEl) return
      setScreenshotDropped(false)
      try {
        const canvas = await captureMasked(selectedEl, masksKey.split('\n'), {
          scale: 2,
        })
        screenshotCanvasRef.current = canvas
        console.log('[redline] screenshot captured:', canvas.width, 'x', canvas.height)
      } catch (err) {
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
  }, [selectedEl, areaComplete, masksKey])

  // Keyboard: Escape to cancel, 's' to toggle mode
  useEffect(() => {
    if (!active) return
    function handleKey(e: KeyboardEvent) {
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
          setDragging(false)
          setAreaRect(null)
          draggingRef.current = false
          areaStartRef.current = null
        } else if (staged) {
          setStaged(null)
        } else {
          onDeactivate()
        }
      }

      if (e.key === 's' && !showingFeedback) {
        e.preventDefault()
        setStaged(null)
        setMode((prev: InspectorMode) => {
          const next: InspectorMode = prev === 'element' ? 'area' : 'element'
          // Clear state from the other mode
          setHoveredEl(null)
          setAreaRect(null)
          setDragging(false)
          setMousePos(null)
          return next
        })
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [active, selectedEl, areaComplete, dragging, staged, showingFeedback, onDeactivate])

  // The bar's Element / Area switch
  const chooseMode = useCallback((next: InspectorMode) => {
    resetAreaDrag()
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

  // Shows the introduction again (Task 8 wires this to it)
  const openIntro = () => {}

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

  // Dimensions tooltip for area drag
  const dimLabel = areaNorm && dragging ? `${areaNorm.w} × ${areaNorm.h}` : null

  // The staged pick's box, read fresh each render (a step, a scroll, a resize)
  const stagedRect = mode === 'element' && !selectedEl ? stagedEl?.getBoundingClientRect() : undefined
  const pickCount = staged?.path.length ?? 0
  const canShrink = !!staged && staged.index > 0
  const canGrow = !!staged && staged.index < pickCount - 1

  return (
    <>
      {/* Cursor overlay */}
      <style>{`
        ${active && !showingFeedback ? '* { cursor: crosshair !important; } [data-redline-ui] button { cursor: pointer !important; }' : ''}
      `}</style>

      {/* Mode indicator pill (mouse and pen) */}
      {!showingFeedback && !touchUi && (
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
            type="button"
            data-redline-ui
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

      {/* Touch bottom bar, in place of the pill, in the thumb zone */}
      {!showingFeedback && touchUi && (
        <div
          data-redline-ui
          data-testid="redline-touch-bar"
          {...KEEP_FROM_PAGE}
          style={{
            position: 'fixed',
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 99999,
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            padding: '12px 12px calc(12px + env(safe-area-inset-bottom))',
            backgroundColor: '#1a1a1a',
            borderTop: '1px solid #333',
            boxShadow: '0 -8px 24px rgba(0,0,0,0.35)',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            touchAction: 'manipulation',
            userSelect: 'none',
            WebkitUserSelect: 'none',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          {staged ? (
            <>
              <div style={BAR_ROW}>
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
                <button type="button" data-redline-ui onClick={() => setStaged(null)} style={BAR_BUTTON}>
                  Cancel
                </button>
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
                <button
                  type="button"
                  data-redline-ui
                  onClick={commentOnPick}
                  style={{ ...BAR_BUTTON, flex: 1, minHeight: 52, border: 'none', backgroundColor: '#ef4444', color: 'white', fontSize: 17, fontWeight: 700 }}
                >
                  Comment
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
                  style={{ flex: 1, display: 'flex', gap: 3, padding: 3, backgroundColor: '#111', border: '1px solid #333', borderRadius: 12 }}
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
      {mode === 'element' && elRect && targetEl && (
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
      {mode === 'area' && !areaComplete && (
        <>
          {/* Interaction overlay — captures all pointer events so page elements
              (dropdowns, menus, etc.) don't receive pointerdown/blur and stay open */}
          <div
            data-redline-ui
            data-redline-area-overlay
            onPointerDown={handleAreaPointerDown}
            onPointerMove={handleAreaPointerMove}
            onPointerUp={handleAreaPointerUp}
            onPointerCancel={resetAreaDrag}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 99996,
              cursor: 'crosshair',
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

          {/* Selection rectangle */}
          {areaNorm && areaNorm.w > 0 && areaNorm.h > 0 && (
            <div
              data-redline-ui
              style={{
                position: 'fixed',
                top: areaNorm.y,
                left: areaNorm.x,
                width: areaNorm.w,
                height: areaNorm.h,
                border: '2px solid #ef4444',
                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                zIndex: 99998,
                pointerEvents: 'none',
                boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.4)',
              }}
            />
          )}

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
          onClick={(e) => {
            e.stopPropagation()
            if (e.target === e.currentTarget) {
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
              width: 400,
              maxWidth: '90vw',
              boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <span style={{ color: '#ef4444', fontSize: 13, fontWeight: 600 }}>
                {areaComplete ? 'Area Feedback' : 'Redline Feedback'}
              </span>
              <button
                data-redline-ui
                onClick={() => {
                  setSelectedEl(null)
                  setAreaComplete(false)
                  setAreaRect(null)
                  setFeedback('')
                  setIncludeScreenshot(false)
                }}
                style={{ color: '#666', fontSize: 18, background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1 }}
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

            {/* Element selector (element mode) */}
            {selectedEl && (
              <>
                <div style={{ fontSize: 11, color: '#888', marginBottom: 8, fontFamily: 'monospace', padding: '6px 8px', backgroundColor: '#111', borderRadius: 6, wordBreak: 'break-all' }}>
                  {generateSelector(selectedEl)}
                </div>
                {selectedText && (
                  <div style={{ fontSize: 11, color: '#aaa', marginBottom: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    &ldquo;{selectedText}&rdquo;
                  </div>
                )}
              </>
            )}

            {/* Area info (area mode) */}
            {areaComplete && areaNorm && (
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
              onKeyDown={(e) => { if (e.key === 'Enter' && e.metaKey) handleSubmit() }}
              style={{
                width: '100%',
                minHeight: 80,
                backgroundColor: '#111',
                border: '1px solid #333',
                borderRadius: 8,
                color: '#eee',
                fontSize: 13,
                padding: '10px 12px',
                resize: 'vertical',
                outline: 'none',
                fontFamily: 'inherit',
              }}
            />
            <div style={{ fontSize: 10, color: '#666', marginTop: 4 }}>
              Masked fields are blacked out in screenshots. Don&rsquo;t type patient or personal details here.
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
              <label
                data-redline-ui
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#aaa', cursor: 'pointer', userSelect: 'none' }}
              >
                <input
                  type="checkbox"
                  data-redline-ui
                  checked={includeScreenshot && !screenshotDropped}
                  disabled={screenshotDropped}
                  onChange={(e) => setIncludeScreenshot(e.target.checked)}
                  style={{ accentColor: '#ef4444' }}
                />
                Include Screenshot
              </label>
              {screenshotDropped && (
                <div data-redline-ui style={{ fontSize: 10, color: '#f87171', marginTop: -2 }}>
                  Screenshot dropped: masking failed.
                </div>
              )}
              <label
                data-redline-ui
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#aaa', cursor: 'pointer', userSelect: 'none' }}
              >
                <input
                  type="checkbox"
                  data-redline-ui
                  checked={requestUxReview}
                  onChange={(e) => setRequestUxReview(e.target.checked)}
                  style={{ accentColor: '#ef4444' }}
                />
                Request UX Review
              </label>
            </div>

            {submitError && (
              <div role="alert" style={{ fontSize: 12, color: '#f87171', marginTop: 10 }}>
                {submitError}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
              <button
                data-redline-ui
                onClick={() => {
                  setSelectedEl(null)
                  setAreaComplete(false)
                  setAreaRect(null)
                  setFeedback('')
                  setIncludeScreenshot(false)
                }}
                style={{ padding: '6px 14px', fontSize: 12, borderRadius: 6, border: '1px solid #333', backgroundColor: 'transparent', color: '#aaa', cursor: 'pointer' }}
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
                }}
              >
                {submitting ? 'Submitting...' : 'Submit'}
              </button>
            </div>

            <div style={{ fontSize: 10, color: '#555', marginTop: 8, textAlign: 'right' }}>
              Cmd+Enter to submit &middot; Esc to cancel
            </div>
          </div>
        </div>
      )}
    </>
  )
}
