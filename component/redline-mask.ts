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

/** closest() that climbs out of shadow roots and iframes. */
function insideMasked(el: Element, selector: string): boolean {
  let node: Element | null = el
  while (node) {
    if (node.closest(selector)) return true
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
  const scrolled = scrolledInside(root)

  // Mark the live elements so their clones can be recognized; the clone keeps attributes
  targets.forEach((t, i) => t.el.setAttribute(MARK, String(i)))
  scrolled.forEach((s, i) => s.el.setAttribute(SCROLL, String(i)))
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
          const s = scrolled[Number(at)]
          if (s) shiftChildren(el, s.left, s.top)
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
    scrolled.forEach((s) => s.el.removeAttribute(SCROLL))
  }
}

interface Scrolled {
  el: Element
  left: number
  top: number
}

/**
 * Elements in root (root included) scrolled away from their top or left edge. The copy
 * the screenshot library draws always starts at scroll 0, so a drawer scrolled to its
 * lower half would be pictured from its top. The page's own scroll is left out: the
 * area crop already offsets the whole-page picture by it.
 */
function scrolledInside(root: Element): Scrolled[] {
  const page = root.ownerDocument.scrollingElement
  const out: Scrolled[] = []
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    if (el === page || el.closest(REDLINE_UI)) continue
    if (el.scrollTop || el.scrollLeft) out.push({ el, left: el.scrollLeft, top: el.scrollTop })
  }
  return out
}

/** Move a scrolled container's copied children by its scroll offset, as the browser does. */
function shiftChildren(el: HTMLElement, left: number, top: number) {
  for (const child of Array.from(el.children) as HTMLElement[]) {
    if (!child.style) continue
    // Translate in page space ahead of the child's own transform (rotate, scale…)
    const own = child.style.transform && child.style.transform !== 'none' ? child.style.transform : ''
    child.style.setProperty('transform', `translate(${-left}px, ${-top}px) ${own}`.trim(), 'important')
  }
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
// blockified by getComputedStyle, so a row of spans in a flex container counts too.
const BLOCK_DISPLAY = /^(block|flex|grid|flow-root|list-item|table|table-row|table-caption|table-row-group|table-header-group|table-footer-group)\b/
// Side-by-side boxes that still need a gap between them
const SPACED_DISPLAY = /^(inline-block|inline-flex|inline-grid|inline-table|table-cell)\b/

/**
 * The text of el as it reads on screen, with masked subtrees replaced by [redacted].
 * Separate boxes stay separate: a label over a value is two lines, not one run-on word,
 * so "$5,786.50" over "5 invoices" never reads as "$5,786.505". Hidden elements are
 * left out, whitespace is collapsed, and the result is cut to maxLength last.
 */
export function redactedText(el: HTMLElement, selectors: string[], maxLength: number): string | null {
  const targets = new Set(findTargets(el, selectors).map((t) => t.mark))
  if (targets.has(el)) return REDACTED

  let out = ''
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += (node as Text).data.replace(/\s+/g, ' ')
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const child = node as Element
    if (targets.has(child)) {
      out += ` ${REDACTED} `
      return
    }
    if (child.localName === 'br') {
      out += '\n'
      return
    }
    const display = child === el ? 'block' : getComputedStyle(child).display
    if (display === 'none' || child.localName === 'script' || child.localName === 'style') return
    const breaks = BLOCK_DISPLAY.test(display)
    const spaced = SPACED_DISPLAY.test(display)
    out += breaks ? '\n' : spaced ? ' ' : ''
    child.childNodes.forEach(walk)
    out += breaks ? '\n' : spaced ? ' ' : ''
  }
  walk(el)

  const text = out
    .split('\n')
    .map((line) => line.replace(/ +/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
  return cut(text, maxLength) || null
}

/** At most max UTF-16 units, never splitting an emoji or other surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text
  const end = /[\uD800-\uDBFF]/.test(text[max - 1]) ? max - 1 : max
  return text.slice(0, end)
}
