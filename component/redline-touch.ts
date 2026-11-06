// Pure DOM helpers for picking elements by touch. No React, no state.

import { redactedText } from './redline-mask'

/** How far a finger can drift and still count as a tap. */
export const TAP_SLOP_PX = 10

const MEANINGFUL = 'button, a[href], input, select, textarea, label, li, summary, img'
const NAME_MAX = 40

/** Something a person would name when pointing at it. */
export function isMeaningful(el: Element): boolean {
  if (el.matches(MEANINGFUL)) return true
  const role = el.getAttribute('role')
  return !!role && role !== 'presentation' && role !== 'none'
}

function sameBox(a: DOMRect, b: DOMRect): boolean {
  return (
    Math.abs(a.left - b.left) <= 1 &&
    Math.abs(a.top - b.top) <= 1 &&
    Math.abs(a.right - b.right) <= 1 &&
    Math.abs(a.bottom - b.bottom) <= 1
  )
}

/**
 * Candidates from the touched element up to (not including) body, innermost first.
 * Page-sized containers are skipped, and runs of same-box wrappers collapse to one
 * step: the outermost meaningful element of the run, else its innermost.
 */
export function pickPath(touched: Element): HTMLElement[] {
  if (touched.closest('[data-redline-ui]')) return []
  const win = touched.ownerDocument.defaultView
  if (!win) return []

  const candidates: { el: HTMLElement; rect: DOMRect }[] = []
  for (let node: Element | null = touched; node; node = node.parentElement) {
    const tag = node.localName
    if (tag === 'body') break
    if (tag === 'html' || !(node instanceof win.HTMLElement)) continue
    const rect = node.getBoundingClientRect()
    if (rect.width >= win.innerWidth * 0.9 && rect.height >= win.innerHeight * 0.9) continue
    candidates.push({ el: node, rect })
  }

  const path: HTMLElement[] = []
  for (let i = 0; i < candidates.length; ) {
    let end = i + 1
    while (end < candidates.length && sameBox(candidates[i].rect, candidates[end].rect)) end++
    const run = candidates.slice(i, end).map((c) => c.el)
    path.push([...run].reverse().find(isMeaningful) ?? run[0])
    i = end
  }
  return path
}

/** Index of the first meaningful element in a path, or 0. */
export function defaultPickIndex(path: HTMLElement[]): number {
  const i = path.findIndex(isMeaningful)
  return i === -1 ? 0 : i
}

function kindOf(el: HTMLElement): string {
  const tag = el.localName
  const role = el.getAttribute('role')
  if (tag === 'button' || role === 'button') return 'Button'
  if (tag === 'a') return 'Link'
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return 'Field'
  if (tag === 'label') return 'Label'
  if (tag === 'li') return 'List item'
  if (tag === 'img') return 'Image'
  if (/^h[1-6]$/.test(tag)) return 'Heading'
  if (tag === 'p') return 'Text'
  if (role && role !== 'presentation' && role !== 'none') return role.charAt(0).toUpperCase() + role.slice(1)
  return 'Section'
}

function nameOf(el: HTMLElement, masks: string[]): string {
  const label = el.getAttribute('aria-label')?.trim()
  if (label) return label
  if (el.localName === 'img') {
    const alt = el.getAttribute('alt')?.trim()
    if (alt) return alt
  }
  // Read well past the cap so collapsing whitespace can't eat the budget
  return redactedText(el, masks, 200)?.replace(/\s+/g, ' ').trim() ?? ''
}

/** "<Kind>: <name>" in plain words, or just "<Kind>" when there is no name. Masked text never appears. */
export function describeElement(el: HTMLElement, masks: string[]): string {
  const kind = kindOf(el)
  let name = nameOf(el, masks)
  if (name.length > NAME_MAX) name = `${name.slice(0, NAME_MAX - 1)}…`
  return name ? `${kind}: ${name}` : kind
}
