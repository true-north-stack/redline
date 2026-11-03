// PHI masking for Redline captures. Runs in the browser before anything is sent:
// masked content is blacked out in the screenshot clone and replaced in captured
// text, so it never leaves the page.
//
// The screenshot library renders open shadow roots and same-origin iframes, so
// targets are found across both. Closed shadow roots and cross-origin iframes
// aren't rendered at all, so there's nothing in them to leak.

const MARK = 'data-redline-mask'
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
  const targets: Target[] = findTargets(root, selectors).map(({ mark, box }) => {
    const rect = box.getBoundingClientRect()
    return {
      el: mark,
      w: rect.width,
      h: rect.height,
      inline: mark === box && getComputedStyle(box).display === 'inline',
    }
  })
  const redacted = new Set<number>()

  // Mark the live elements so their clones can be recognized; the clone keeps attributes
  targets.forEach((t, i) => t.el.setAttribute(MARK, String(i)))
  try {
    const canvas = await domToCanvas(root, {
      ...options,
      onCloneEachNode: (cloned) => {
        if (cloned.nodeType !== Node.ELEMENT_NODE) return
        const el = cloned as HTMLElement
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

/** textContent of el with masked subtrees replaced by [redacted]. */
export function redactedText(el: HTMLElement, selectors: string[], maxLength: number): string | null {
  const targets = findTargets(el, selectors).map((t) => t.mark)
  if (targets.includes(el)) return REDACTED

  targets.forEach((t) => t.setAttribute(MARK, ''))
  let clone: HTMLElement
  try {
    clone = el.cloneNode(true) as HTMLElement
  } finally {
    targets.forEach((t) => t.removeAttribute(MARK))
  }
  clone.querySelectorAll(`[${MARK}]`).forEach((n) => n.replaceWith(REDACTED))
  return clone.textContent?.slice(0, maxLength) || null
}
