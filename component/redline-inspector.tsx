'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { maskSelectors, sanitizePageUrl } from './redline-config'
import { captureMasked, redactedText } from './redline-mask'

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

export function RedlineInspector({ active, onDeactivate, apiUrl = '/api/redlines', initialMode = 'element', phiSelectors }: RedlineInspectorProps) {
  const [hoveredEl, setHoveredEl] = useState<HTMLElement | null>(null)
  const [selectedEl, setSelectedEl] = useState<HTMLElement | null>(null)
  const [feedback, setFeedback] = useState('')
  const [includeScreenshot, setIncludeScreenshot] = useState(false)
  const [requestUxReview, setRequestUxReview] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const screenshotCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Area screenshot mode
  const [mode, setMode] = useState<InspectorMode>('element')
  const [dragging, setDragging] = useState(false)
  const [areaRect, setAreaRect] = useState<AreaRect | null>(null)
  const [areaComplete, setAreaComplete] = useState(false)
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null)

  // Refs for drag state — avoids re-attaching event listeners on every mousemove
  const draggingRef = useRef(false)
  const areaStartRef = useRef<{ x: number; y: number } | null>(null)

  // Apply initialMode when activated
  useEffect(() => {
    if (active) {
      setMode(initialMode)
    }
  }, [active, initialMode])

  // Reset state when deactivated
  useEffect(() => {
    if (!active) {
      setMode('element')
      setDragging(false)
      setAreaRect(null)
      setAreaComplete(false)
      setMousePos(null)
      setHoveredEl(null)
      setSelectedEl(null)
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
  useEffect(() => {
    if (!showingFeedback) setSubmitError(null)
  }, [showingFeedback])

  // ---------------------------------------------------------------------------
  // Element mode: hover tracking + click to select
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

    function handleMove(e: MouseEvent) {
      const target = findBestTarget(e.clientX, e.clientY)
      setHoveredEl(target)
    }

    function handleClick(e: MouseEvent) {
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

    document.addEventListener('mousemove', handleMove, true)
    document.addEventListener('click', handleClick, true)

    return () => {
      document.removeEventListener('mousemove', handleMove, true)
      document.removeEventListener('click', handleClick, true)
    }
  }, [active, mode, selectedEl])

  // Capture area screenshot
  const captureArea = useCallback(async (area: AreaRect) => {
    const { x, y, w, h } = normalizeArea(area)
    try {
      const dpr = window.devicePixelRatio || 1
      const scrollX = window.scrollX
      const scrollY = window.scrollY
      const fullCanvas = await captureMasked(document.documentElement, masksKey.split('\n'), {
        backgroundColor: '#1a1a1a',
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
      setIncludeScreenshot(true)
      setAreaComplete(true)
      console.log('[redline] area screenshot captured:', w, 'x', h)
      setTimeout(() => inputRef.current?.focus(), 50)
    } catch (err) {
      // Masking or capture failed: drop the screenshot rather than send it unmasked
      console.warn('[redline] area screenshot dropped:', err)
      screenshotCanvasRef.current = null
      setIncludeScreenshot(false)
      // Still show feedback modal even if capture fails
      setAreaComplete(true)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [masksKey])

  // ---------------------------------------------------------------------------
  // Area mode: drag to select region
  // Uses refs for drag state so the effect doesn't re-attach listeners on
  // every mousemove — only re-runs when mode/active/areaComplete changes.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!active || mode !== 'area' || areaComplete) return

    function handleMouseDown(e: MouseEvent) {
      const el = e.target as HTMLElement
      // The interaction overlay is Redline UI too, but dragging on it is the point
      if (el.closest('[data-redline-ui]') && !el.hasAttribute('data-redline-area-overlay')) return
      e.preventDefault()
      e.stopPropagation()
      draggingRef.current = true
      areaStartRef.current = { x: e.clientX, y: e.clientY }
      setDragging(true)
      setAreaRect({ startX: e.clientX, startY: e.clientY, endX: e.clientX, endY: e.clientY })
    }

    function handleMouseMove(e: MouseEvent) {
      setMousePos({ x: e.clientX, y: e.clientY })
      if (!draggingRef.current || !areaStartRef.current) return
      setAreaRect({
        startX: areaStartRef.current.x,
        startY: areaStartRef.current.y,
        endX: e.clientX,
        endY: e.clientY,
      })
    }

    function handleMouseUp(e: MouseEvent) {
      if (!draggingRef.current || !areaStartRef.current) return
      draggingRef.current = false
      setDragging(false)

      const finalRect: AreaRect = {
        startX: areaStartRef.current.x,
        startY: areaStartRef.current.y,
        endX: e.clientX,
        endY: e.clientY,
      }
      const { w, h } = normalizeArea(finalRect)

      if (w < 20 || h < 20) {
        // Too small — accidental click, reset
        setAreaRect(null)
        areaStartRef.current = null
        return
      }

      setAreaRect(finalRect)
      areaStartRef.current = null
      captureArea(finalRect)
    }

    document.addEventListener('mousedown', handleMouseDown, true)
    document.addEventListener('mousemove', handleMouseMove, true)
    document.addEventListener('mouseup', handleMouseUp, true)

    return () => {
      document.removeEventListener('mousedown', handleMouseDown, true)
      document.removeEventListener('mousemove', handleMouseMove, true)
      document.removeEventListener('mouseup', handleMouseUp, true)
    }
  }, [active, mode, areaComplete, captureArea])

  // Silently capture screenshot via html2canvas when element is selected
  useEffect(() => {
    if (!selectedEl) {
      if (!areaComplete) screenshotCanvasRef.current = null
      return
    }

    async function captureElement() {
      if (!selectedEl) return
      try {
        const canvas = await captureMasked(selectedEl, masksKey.split('\n'), {
          backgroundColor: '#1a1a1a',
          scale: 2,
        })
        screenshotCanvasRef.current = canvas
        console.log('[redline] screenshot captured:', canvas.width, 'x', canvas.height)
      } catch (err) {
        // Masking or capture failed: drop the screenshot rather than send it unmasked
        console.warn('[redline] screenshot dropped:', err)
        screenshotCanvasRef.current = null
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
        } else {
          onDeactivate()
        }
      }

      if (e.key === 's' && !showingFeedback) {
        e.preventDefault()
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
  }, [active, selectedEl, areaComplete, dragging, showingFeedback, onDeactivate])

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
        setSubmitError(
          res.status === 401
            ? 'Sign in to leave feedback.'
            : `Couldn't save your feedback (${res.status}). Try again.`,
        )
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

  return (
    <>
      {/* Cursor overlay */}
      <style>{`
        ${active && !showingFeedback ? '* { cursor: crosshair !important; }' : ''}
      `}</style>

      {/* Mode indicator pill */}
      {!showingFeedback && (
        <div
          data-redline-ui
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
        </div>
      )}

      {/* Pulse animation */}
      <style>{`
        @keyframes redline-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>

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
          {/* Interaction overlay — captures all mouse events so page elements
              (dropdowns, menus, etc.) don't receive mousedown/blur and stay open */}
          <div
            data-redline-ui
            data-redline-area-overlay
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
            {areaComplete && screenshotCanvasRef.current && (
              <div style={{ marginBottom: 12, borderRadius: 6, overflow: 'hidden', border: '1px solid #333' }}>
                <canvas
                  ref={(el) => {
                    if (el && screenshotCanvasRef.current) {
                      const ctx = el.getContext('2d')
                      const src = screenshotCanvasRef.current
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
                  checked={includeScreenshot}
                  onChange={(e) => setIncludeScreenshot(e.target.checked)}
                  style={{ accentColor: '#ef4444' }}
                />
                Include Screenshot
              </label>
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
