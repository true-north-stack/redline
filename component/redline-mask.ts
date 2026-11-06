// PHI masking for Redline captures. Runs in the browser before anything is sent:
// masked content is blacked out in the screenshot clone and replaced in captured
// text, so it never leaves the page.
//
// The screenshot library renders open shadow roots and same-origin iframes, so
// targets are found across both. Closed shadow roots and cross-origin iframes
// aren't rendered at all, so there's nothing in them to leak.

const MARK = 'data-redline-mask'
const SCROLL = 'data-redline-scroll'
const REDACTED = '[redacted]'

interface Target {
  el: Element
  w: number
  h: number
  inline: boolean
}

/** A live element to mark, and the element whose box the mask should cover. */
interface Match {
  mark: Element
  box: Element
}

// Realm-independent checks: elements inside an iframe come from that frame's own
// window, so `instanceof HTMLIFrameElement` / `instanceof ShadowRoot` miss them.
const isIframe = (el: Element): el is HTMLIFrameElement => el.localName === 'iframe'
const isShadowRoot = (n: Node): n is ShadowRoot => n.nodeType === Node.DOCUMENT_FRAGMENT_NODE && 'host' in n

function frameDocument(el: HTMLIFrameElement): Document | null {
  try {
    return el.contentDocument
  } catch {
    return null // cross-origin: not rendered by the screenshot library
  }
}

/**
 * True when a selector depends on ancestors or siblings (combinators, or :host and
 * friends). Those can't be evaluated across a shadow or frame boundary. Quoted
 * strings and attribute brackets are ignored; anything else ambiguous counts.
 */
function isContextual(selector: string): boolean {
  const bare = selector.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '').replace(/\[[^\]]*\]/g, '[]')
  return /[\s>+~]|:host|::slotted|::part/.test(bare.trim())
}

// Everything Redline renders carries this attribute
const REDLINE_UI = '[data-redline-ui]'

/**
 * Masked elements inside (or containing) root, across open shadow roots and
 * same-origin iframes (both are rendered by the screenshot library). Throws when
 * content behind a boundary can't be checked reliably, so the capture is dropped.
 */
function findTargets(root: Element, selectors: string[]): Match[] {
  const selector = selectors.join(',')
  if (insideMasked(root, selector)) return [{ mark: root, box: root }]
  const contextual = selectors.some(isContextual)
  const out: Match[] = []
  collect(root, selector, contextual, out, true)
  return out
}

function collect(scope: Element | ShadowRoot | Document, selector: string, contextual: boolean, out: Match[], includeSelf = false) {
  const els = Array.from(scope.querySelectorAll('*'))
  if (includeSelf && scope.nodeType === Node.ELEMENT_NODE) els.unshift(scope as Element)
  for (const el of els) {
    const matched = el.matches(selector)
    if (isIframe(el)) {
      const doc = frameDocument(el)
      // The library renders a frame as a clone of its body, so that's what gets marked
      if (matched) out.push({ mark: doc?.body ?? el, box: el })
      else if (doc) descend(doc, selector, contextual, out)
      continue
    }
    if (matched) out.push({ mark: el, box: el })
    if (el.shadowRoot && !matched) descend(el.shadowRoot, selector, contextual, out)
  }
}

function descend(scope: ShadowRoot | Document, selector: string, contextual: boolean, out: Match[]) {
  const content = scope.nodeType === Node.DOCUMENT_NODE ? (scope as Document).body : scope
  if (contextual && content?.querySelector('*')) {
    throw new Error('[redline] a PHI selector with combinators can\'t be checked inside shadow roots or iframes')
  }
  collect(scope, selector, contextual, out)
}

/**
 * closest() along the rendered tree: through the slot an element is shown in, then out
 * of shadow roots and iframes. A name slotted into a masked part of a component is
 * masked, even though its light-tree parents aren't.
 */
function insideMasked(el: Element, selector: string): boolean {
  let node: Element | null = el
  while (node) {
    if (node.matches(selector)) return true
    const next: Element | null = node.assignedSlot ?? node.parentElement
    if (next) {
      node = next
      continue
    }
    const root = node.getRootNode()
    node = isShadowRoot(root) ? root.host : (node.ownerDocument.defaultView?.frameElement ?? null)
  }
  return false
}

let probe: CanvasRenderingContext2D | null | undefined

/**
 * How opaque a CSS color is, 0 to 1, as the browser paints it. Asking a 1x1 canvas
 * handles every syntax (rgb, hsl, oklab, oklch, color(), color-mix) without parsing.
 */
function opacityOf(color: string): number {
  if (!color || color === 'transparent') return 0
  if (probe === undefined) {
    probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  }
  if (!probe) return 1
  probe.clearRect(0, 0, 1, 1)
  // An unparseable color leaves fillStyle unchanged, so reset it first
  probe.fillStyle = 'rgba(0, 0, 0, 0)'
  probe.fillStyle = color
  probe.fillRect(0, 0, 1, 1)
  return probe.getImageData(0, 0, 1, 1).data[3] / 255
}

/**
 * The background an element is seen against: the nearest fully opaque background
 * on it or an ancestor, or white. A transparent heading on a white page is captured
 * on white, and on a dark page on its dark background. Translucent layers in between
 * (a faint card tint) are skipped rather than blended. For the whole document, the
 * page color usually sits on body, so body is checked after html.
 */
export function backgroundBehind(el: Element): string {
  const chain: Element[] = []
  if (el === el.ownerDocument.documentElement) {
    chain.push(el)
    if (el.ownerDocument.body) chain.push(el.ownerDocument.body)
  } else {
    for (let node: Element | null = el; node; node = node.parentElement) chain.push(node)
  }
  for (const node of chain) {
    const color = getComputedStyle(node).backgroundColor
    if (opacityOf(color) >= 1) return color
  }
  return '#ffffff'
}

/**
 * Render root to a canvas with every masked element replaced by a solid black box
 * of the same size. Throws if any masked element wasn't redacted, so callers drop
 * the screenshot instead of sending it unmasked.
 */
export async function captureMasked(
  root: HTMLElement,
  selectors: string[],
  options: { backgroundColor?: string; scale?: number } = {},
): Promise<HTMLCanvasElement> {
  const { domToCanvas } = await import('modern-screenshot')
  // Redline's own overlays (the area box, its handles, the bar) are left out of the
  // picture, so masked matches inside them have nothing to redact
  const targets: Target[] = findTargets(root, selectors).filter(({ box }) => !box.closest(REDLINE_UI)).map(({ mark, box }) => {
    const rect = box.getBoundingClientRect()
    return {
      el: mark,
      w: rect.width,
      h: rect.height,
      inline: mark === box && getComputedStyle(box).display === 'inline',
    }
  })
  const redacted = new Set<number>()
  const shifts = scrollShifts(root)

  // Mark the live elements so their clones can be recognized; the clone keeps attributes
  targets.forEach((t, i) => t.el.setAttribute(MARK, String(i)))
  shifts.forEach((s, i) => s.el.setAttribute(SCROLL, String(i)))
  try {
    const canvas = await domToCanvas(root, {
      backgroundColor: backgroundBehind(root),
      ...options,
      filter: (node) => node.nodeType !== Node.ELEMENT_NODE || !(node as Element).matches(REDLINE_UI),
      // modern-screenshot drops the root's own margins, and the copy it draws then
      // falls back to the browser's defaults for that tag (h1, p, ul…), pushing the
      // content down and clipping it. Pin the root copy's margins to zero. A positioned
      // root (a fixed drawer, an absolute card) keeps its left/top offsets in the copy and
      // draws itself off the canvas, so it is pinned to the canvas origin too. It stays
      // positioned, so its absolute children keep the same containing block.
      onCloneNode: (cloned) => {
        if (cloned.nodeType !== Node.ELEMENT_NODE) return
        const s = (cloned as HTMLElement).style
        s.setProperty('margin', '0', 'important')
        if (root !== root.ownerDocument.documentElement && getComputedStyle(root).position !== 'static') {
          s.setProperty('position', 'relative', 'important')
          s.setProperty('inset', 'auto', 'important')
        }
      },
      onCloneEachNode: (cloned) => {
        if (cloned.nodeType !== Node.ELEMENT_NODE) return
        const el = cloned as HTMLElement
        const at = el.getAttribute(SCROLL)
        if (at !== null) {
          el.removeAttribute(SCROLL)
          const s = shifts[Number(at)]
          if (s) applyShift(el, s)
        }
        const idx = el.getAttribute(MARK)
        if (idx === null) return
        const t = targets[Number(idx)]
        if (!t) return
        redactClone(el, t)
        redacted.add(Number(idx))
      },
    })
    if (redacted.size !== targets.length) {
      throw new Error(`[redline] masking incomplete: ${redacted.size}/${targets.length} elements redacted`)
    }
    return canvas
  } finally {
    targets.forEach((t) => t.el.removeAttribute(MARK))
    shifts.forEach((s) => s.el.removeAttribute(SCROLL))
  }
}

/** How one copied element is moved to match its live scroll position. */
interface Shift {
  /** The live element; its copy carries the SCROLL mark */
  el: Element
  /** Open the copy with a spacer pulling its content this far up (block, flex column) */
  spacerTop?: number
  /** Open the copy with a spacer pulling its content this far left (flex row) */
  spacerLeft?: number
  /** Replace the copy's margins with these, moving it without a transform */
  margins?: Partial<Record<'top' | 'right' | 'bottom' | 'left', number>>
  /** Move the copy by this much with translate, where margins can't do it */
  x?: number
  y?: number
}

/**
 * What to move so scrolled containers in root (root included) are pictured where they
 * are scrolled to. The copy the screenshot library draws always starts at scroll 0, so a
 * drawer scrolled to its lower half would show its top. (The library's own
 * restoreScrollPosition feature stays off: it also shifts the page's scroller, which the
 * area crop already offsets by.)
 *
 * Content is moved by layout wherever it can be, never by transform, because a transform
 * would make the moved element the reference for fixed and sticky parts inside it. Along
 * the direction a container stacks its content (down for block and flex column, across
 * for flex row), a spacer with a negative margin opens the copy and pulls everything after
 * it, text included. Across the other direction, each block-level child is moved by its
 * margins. Sticky parts then settle where the browser shows them, since the copy sits at
 * scroll 0. Grid and reversed flex scrollers, inline-block children and absolute children
 * placed against the scroller are moved with translate instead. Fixed and sticky children,
 * and absolute ones placed against something outside the scroller, don't scroll, so they
 * aren't moved.
 */
function scrollShifts(root: Element): Shift[] {
  const page = root.ownerDocument.scrollingElement
  const shifts = new Map<Element, Shift>()
  const entry = (el: Element) => {
    let s = shifts.get(el)
    if (!s) shifts.set(el, (s = { el }))
    return s
  }
  for (const scroller of [root, ...Array.from(root.querySelectorAll('*'))]) {
    const top = scroller.scrollTop
    const left = scroller.scrollLeft
    if ((!top && !left) || scroller === page || scroller.closest(REDLINE_UI)) continue
    const cs = getComputedStyle(scroller)
    const flex = /flex$/.test(cs.display)
    const column = flex && cs.flexDirection === 'column'
    const row = flex && cs.flexDirection === 'row'
    const block = /^(block|flow-root|list-item)$/.test(cs.display)
    // A flex gap after the spacer would push the content back. Centered flex content that
    // overflows spills over both ends, so a spacer there only moves it half as far.
    const twice = flex && cs.justifyContent === 'center' ? 2 : 1
    if (top && (block || column)) entry(scroller).spacerTop = top * (column ? twice : 1) + (column ? parseFloat(cs.rowGap) || 0 : 0)
    if (left && row) entry(scroller).spacerLeft = left * twice + (parseFloat(cs.columnGap) || 0)
    // What the spacer doesn't carry, each child has to move itself
    const across = { x: row ? 0 : left, y: block || column ? 0 : top }
    for (const child of Array.from(scroller.children)) {
      const style = getComputedStyle(child)
      const position = style.position
      if (position === 'fixed' || position === 'sticky') continue
      if (position === 'absolute') {
        if (!(child instanceof HTMLElement) || child.offsetParent !== scroller) continue
        const s = entry(child)
        s.x = (s.x ?? 0) - left
        s.y = (s.y ?? 0) - top
        continue
      }
      if (!across.x && !across.y) continue
      const s = entry(child)
      if ((block || column || row) && !style.display.startsWith('inline')) {
        const m = (s.margins ??= {})
        if (across.x) {
          m.left = parseFloat(style.marginLeft) - across.x
          m.right = parseFloat(style.marginRight) + across.x // keeps an auto width the same
        }
        if (across.y) {
          m.top = parseFloat(style.marginTop) - across.y
          m.bottom = parseFloat(style.marginBottom) + across.y
        }
      } else {
        s.x = (s.x ?? 0) - across.x
        s.y = (s.y ?? 0) - across.y
      }
    }
  }
  return Array.from(shifts.values())
}

function applyShift(el: HTMLElement, s: Shift) {
  const doc = el.ownerDocument
  // A 1px spacer, so its margin can't collapse through it into a negative child margin
  if (s.spacerTop) {
    const spacer = doc.createElement('div')
    spacer.style.cssText = `display:block;flex:none;height:1px;padding:0;border:0;margin:-${s.spacerTop + 1}px 0 0 0`
    el.prepend(spacer)
  }
  if (s.spacerLeft) {
    const spacer = doc.createElement('div')
    spacer.style.cssText = `display:block;flex:none;width:1px;padding:0;border:0;margin:0 0 0 -${s.spacerLeft + 1}px`
    el.prepend(spacer)
  }
  const style = el.style
  for (const [side, px] of Object.entries(s.margins ?? {})) style.setProperty(`margin-${side}`, `${px}px`, 'important')
  if (!s.x && !s.y) return
  // translate applies outside rotate, scale and transform, so the move stays in page space.
  // An existing translate is kept and added to; one written with calc() can't be split
  // into its parts, so the move goes ahead of the transform instead.
  const own = !style.translate || style.translate === 'none' ? '' : style.translate
  if (own.includes('(')) {
    const transform = style.transform && style.transform !== 'none' ? style.transform : ''
    style.setProperty('transform', `translate(${s.x ?? 0}px, ${s.y ?? 0}px) ${transform}`.trim(), 'important')
    return
  }
  const [x = '0px', y = '0px', z = ''] = own ? own.split(/\s+/) : []
  style.setProperty('translate', `calc(${x} + ${s.x ?? 0}px) calc(${y} + ${s.y ?? 0}px) ${z}`.trim(), 'important')
}

function redactClone(el: HTMLElement, t: Target) {
  el.removeAttribute(MARK)
  // Drop all content, including ::before/::after rules attached through generated classes
  el.replaceChildren()
  el.removeAttribute('class')
  for (const attr of ['src', 'srcset', 'poster', 'value', 'placeholder', 'alt', 'title']) {
    el.removeAttribute(attr)
  }
  if ('value' in el) (el as HTMLInputElement).value = ''

  const s = el.style
  const set = (prop: string, value: string) => s.setProperty(prop, value, 'important')
  if (t.inline) set('display', 'inline-block')
  set('box-sizing', 'border-box')
  set('width', `${t.w}px`)
  set('height', `${t.h}px`)
  set('min-width', `${t.w}px`)
  set('min-height', `${t.h}px`)
  set('background', '#000')
  set('color', 'transparent')
  set('text-shadow', 'none')
  set('filter', 'none')
  set('opacity', '1')
}

// Boxes that start a new line in what the reader sees. Flex and grid items are reported
// blockified by getComputedStyle, so their parent decides instead (see Row below).
const BLOCK_DISPLAY = /^(block|flex|grid|flow-root|list-item|table|table-row|table-caption|table-row-group|table-header-group|table-footer-group)\b/
// Side-by-side boxes that still need a gap between them
const SPACED_DISPLAY = /^(inline-block|inline-flex|inline-grid|inline-table|table-cell)\b/

/**
 * The text of el as it reads on screen, with masked subtrees replaced by [redacted].
 * Separate boxes stay separate: a label over a value is two lines, not one run-on word,
 * so "$5,786.50" over "5 invoices" never reads as "$5,786.505". Hidden elements and
 * Redline's own UI are left out, whitespace is collapsed (line breaks kept where the page
 * keeps them, as in pre), and the walk stops once there is more than maxLength to keep.
 */
export function redactedText(el: HTMLElement, selectors: string[], maxLength: number): string | null {
  const targets = findTargets(el, selectors).map((t) => t.mark)
  if (targets.includes(el)) return REDACTED
  // Light-tree nodes shown through a slot inside a masked part of a component are masked
  // too: the walk reaches them as children of the host, not of the masked part
  const masked = new Set<Node>(targets)
  for (const t of targets) {
    const slots = t.localName === 'slot' ? [t] : Array.from(t.querySelectorAll('slot'))
    for (const slot of slots) (slot as HTMLSlotElement).assignedNodes({ flatten: true }).forEach((n) => masked.add(n))
  }

  let out = ''
  let visible = 0 // characters that survive collapsing, so the walk knows when it has enough
  const walk = (node: Node, keepBreaks: boolean, row: Row | null = null): boolean => {
    if (visible > maxLength) return false
    if (masked.has(node)) {
      out += ` ${REDACTED} `
      visible += REDACTED.length
      return true
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const data = (node as Text).data
      out += keepBreaks ? data.replace(/[^\S\n]+/g, ' ') : data.replace(/\s+/g, ' ')
      visible += data.replace(/\s+/g, '').length
      return true
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return true
    const child = node as Element
    if (child.localName === 'br') {
      out += '\n'
      return true
    }
    if (child.localName === 'script' || child.localName === 'style' || child.matches(REDLINE_UI)) return true
    const style = child === el ? null : getComputedStyle(child)
    const display = style?.display ?? 'block'
    if (display === 'none') return true
    const keep = style ? /^(pre|break-spaces)/.test(style.whiteSpace) : keepBreaks
    // display: contents leaves no box: its children belong to the row this element is in
    if (display === 'contents') {
      for (const c of Array.from(child.childNodes)) if (!walk(c, keep, row)) return false
      return true
    }
    // An item of a flex row or grid sits beside the one before it unless it starts a new
    // row on screen; anything else follows its own display
    const before = row ? (row.sameLine(child) ? ' ' : '\n') : BLOCK_DISPLAY.test(display) ? '\n' : SPACED_DISPLAY.test(display) ? ' ' : ''
    const after = row ? ' ' : before
    const inner = style ? rowOf(child, style) : null
    out += before
    for (const c of Array.from(child.childNodes)) if (!walk(c, keep, inner)) return false
    out += after
    return true
  }
  walk(el, /^(pre|break-spaces)/.test(getComputedStyle(el).whiteSpace))

  const text = out
    .split('\n')
    .map((line) => line.replace(/ +/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
  return cut(text, maxLength) || null
}

/** The items of one flex row or grid, read left to right and row by row. */
interface Row {
  /** Whether this item sits on the same line as the item before it */
  sameLine(item: Element): boolean
}

/**
 * A flex row or grid's own reading of its items, or null for any other container. A
 * single-line flex row is one line, whatever its items are. A wrapping row or a grid
 * starts a new line where an item no longer overlaps the previous one vertically.
 */
function rowOf(el: Element, style: CSSStyleDeclaration): Row | null {
  const flex = /flex$/.test(style.display)
  if (flex && !style.flexDirection.startsWith('row')) return null
  if (!flex && !/grid$/.test(style.display)) return null
  if (flex && style.flexWrap === 'nowrap') return { sameLine: () => true }
  let last: DOMRect | null = null
  return {
    sameLine(item) {
      const box = item.getBoundingClientRect()
      const same = !!last && box.top < last.bottom - 1 && box.bottom > last.top + 1
      last = box
      return same
    },
  }
}

/** At most max UTF-16 units, never splitting an emoji or other surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text
  const end = /[\uD800-\uDBFF]/.test(text[max - 1]) ? max - 1 : max
  return text.slice(0, end)
}
