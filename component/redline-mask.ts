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

/** Masked elements inside (or containing) root. If root sits inside a masked element, root itself is the target. */
function findTargets(root: Element, selectors: string[]): Element[] {
  const selector = selectors.join(',')
  if (insideMasked(root, selector)) return [root]
  const found: Element[] = []
  collect(root, selector, found, true)
  return found
}

/** Matches in scope, descending into open shadow roots and same-origin iframes. */
function collect(scope: Element | ShadowRoot | Document, selector: string, out: Element[], includeSelf = false) {
  const els = Array.from(scope.querySelectorAll('*'))
  if (includeSelf && scope instanceof Element) els.unshift(scope)
  for (const el of els) {
    if (el !== scope && el.matches(selector)) out.push(el)
    if (el.shadowRoot) collect(el.shadowRoot, selector, out)
    if (el instanceof HTMLIFrameElement) {
      let doc: Document | null = null
      try {
        doc = el.contentDocument
      } catch {
        // cross-origin: not rendered by the screenshot library
      }
      if (doc) collect(doc, selector, out)
    }
  }
}

/** closest() that climbs out of shadow roots and iframes. */
function insideMasked(el: Element, selector: string): boolean {
  let node: Element | null = el
  while (node) {
    if (node.closest(selector)) return true
    const root = node.getRootNode()
    node = root instanceof ShadowRoot ? root.host : (node.ownerDocument.defaultView?.frameElement ?? null)
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
  const targets: Target[] = findTargets(root, selectors).map((el) => {
    const rect = el.getBoundingClientRect()
    return {
      el,
      w: rect.width,
      h: rect.height,
      inline: getComputedStyle(el).display === 'inline',
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
  const targets = findTargets(el, selectors)
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
