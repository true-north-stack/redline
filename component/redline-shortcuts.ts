'use client'

// The documented triple-tap keys. "r" or "u" three times = element mode, "e" three
// times = area mode. Hosts call this hook instead of writing their own listener.

import { useEffect, useLayoutEffect, useRef } from 'react'

export type RedlineShortcutMode = 'element' | 'area'

/** Three presses must land within this many ms of the first. */
const WINDOW_MS = 500
const PRESSES = 3

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

/**
 * While one of Redline's own dialogs (the introduction or the feedback box) is open, keys
 * belong to it, wherever focus is: this listener runs in the capture phase, so the dialog
 * can't stop keys reaching it.
 */
function redlineDialogOpen(): boolean {
  return !!document.querySelector('[role="dialog"][data-redline-ui]')
}

export function useRedlineShortcuts(
  onActivate: (mode: RedlineShortcutMode) => void,
  options?: { enabled?: boolean },
): void {
  const enabled = options?.enabled ?? true
  const latest = useRef(onActivate)
  useLayoutEffect(() => {
    latest.current = onActivate
  })

  useEffect(() => {
    if (!enabled) return
    let key = ''
    let times: number[] = []

    function onKeyDown(e: KeyboardEvent) {
      // Shift held or Caps Lock on still counts: "R" is the same key as "r"
      if (e.key === 'Shift' || e.key === 'CapsLock') return
      const pressed = e.key.toLowerCase()
      if (pressed !== 'r' && pressed !== 'u' && pressed !== 'e') {
        key = ''
        times = []
        return
      }
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target) || redlineDialogOpen()) return

      if (pressed !== key) {
        key = pressed
        times = []
      }
      const now = performance.now()
      times = [...times, now].filter((t) => now - t <= WINDOW_MS)
      if (times.length < PRESSES) return

      const mode: RedlineShortcutMode = key === 'e' ? 'area' : 'element'
      key = ''
      times = []
      e.preventDefault()
      latest.current(mode)
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [enabled])
}
