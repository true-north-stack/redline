// Touch area capture: in Area mode a one-finger drag draws a box, corner handles adjust
// it, and Comment captures it. Also the bar's dock toggle, and that nothing Redline locks
// for drawing outlives Area mode. Runs on Chromium with touch emulation (real touches
// through CDP) and on WebKit as an iPhone 13 (touch PointerEvents from page.evaluate,
// since Playwright WebKit has no touch-drag API).

import { test, expect, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { fileURLToPath } from 'url'

const ORIGIN = 'http://redline.test'
test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

let bundle = ''
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./fixture/app.tsx', import.meta.url))],
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  })
  bundle = result.outputFiles[0].text
})

const HOST_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'click']
const rows = Array.from({ length: 40 }, (_, i) => `<li>Session ${i + 1}</li>`).join('')

const pageHtml = () => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><style>
  body { margin: 0; font: 16px sans-serif; background: #ffffff; }
  #hero { margin: 24px; height: 220px; background: linear-gradient(135deg, #fde68a, #93c5fd); border-radius: 12px; padding: 16px; }
  #hero h1 { margin: 0; font-size: 24px; }
  #hero a { display: inline-block; margin-top: 12px; }
  #rows { margin: 24px; padding: 0; list-style: none; }
  #rows li { height: 56px; border-bottom: 1px solid #ccc; }
  #tabs { position: fixed; left: 0; right: 0; bottom: 0; height: 56px; display: flex; background: #e5e7eb; }
  #tabs button { flex: 1; font-size: 15px; border: 0; background: transparent; }
</style></head><body>
  <section id="hero" aria-label="This week"><h1>This week</h1><a id="link" href="/elsewhere">See all</a></section>
  <ul id="rows">${rows}</ul>
  <nav id="tabs" aria-label="Tabs"><button id="tab-home">Home</button><button id="tab-invoices">Invoices</button></nav>
  <div id="redline-root"></div>
  <script>
    window.__hostEvents = []
    for (const id of ['hero', 'link', 'rows', 'tabs', 'tab-home', 'tab-invoices']) {
      for (const type of ${JSON.stringify(HOST_EVENTS)}) {
        document.getElementById(id).addEventListener(type, () => window.__hostEvents.push(id + ':' + type))
      }
    }
    for (const type of ${JSON.stringify(HOST_EVENTS)}) {
      document.addEventListener(type, () => window.__hostEvents.push('document:' + type))
    }
    window.__REDLINE_PROPS__ = {}
  </script>
  <script>${bundle}</script>
</body></html>`

const bar = (page: Page) => page.getByTestId('redline-touch-bar')
const barButton = (page: Page, name: string) => bar(page).getByRole('button', { name, exact: true })
const draft = (page: Page) => page.getByTestId('redline-area-draft')
const handle = (page: Page, corner: string) => page.locator(`[data-redline-handle="${corner}"]`)
const overlay = (page: Page) => page.locator('[data-redline-area-overlay]')
const feedbackBox = (page: Page) => page.getByPlaceholder("What's wrong? What should change?")
const hostEvents = (page: Page) => page.evaluate(() => (window as any).__hostEvents as string[])
const scrollY = (page: Page) => page.evaluate(() => window.scrollY)
const bodyStyle = (page: Page) =>
  page.evaluate(() => ({ overflow: document.body.style.overflow, touchAction: document.body.style.touchAction }))
// Whether a touchmove anywhere on the page would be refused (Redline's drawing lock)
const touchMoveLocked = (page: Page) =>
  page.evaluate(() => {
    const e = new Event('touchmove', { bubbles: true, cancelable: true })
    document.body.dispatchEvent(e)
    return e.defaultPrevented
  })

async function open(page: Page) {
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: pageHtml() }),
  )
  await page.goto(ORIGIN + '/x')
  await expect(bar(page)).toBeVisible()
}

async function openArea(page: Page) {
  await open(page)
  await barButton(page, 'Area').tap()
  await expect(bar(page).getByText('Drag to draw a box.')).toBeVisible()
}

type Point = { x: number; y: number }

/**
 * One finger. Chromium sends real touches through CDP, so touch-action and native
 * scrolling are in play. WebKit sends touch PointerEvents to whatever was under the
 * finger at the start, as pointer capture would.
 */
async function finger(page: Page, browserName: string, pointerId = 11) {
  let last: Point = { x: 0, y: 0 }
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page)
    return {
      async down(p: Point) {
        last = p
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, id: pointerId }] })
      },
      async move(p: Point, steps = 8) {
        const from = last
        for (let i = 1; i <= steps; i++) {
          const x = from.x + ((p.x - from.x) * i) / steps
          const y = from.y + ((p.y - from.y) * i) / steps
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: pointerId }] })
        }
        last = p
      },
      async up() {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      },
    }
  }
  const fire = (type: string, p: Point, isPrimary = true) =>
    page.evaluate(
      ({ type, p, pointerId, isPrimary }) => {
        const w = window as any
        if (type === 'pointerdown') w.__fingerTargets = { ...w.__fingerTargets, [pointerId]: document.elementFromPoint(p.x, p.y) }
        const target: Element = w.__fingerTargets[pointerId]
        target.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true, cancelable: true, composed: true,
            pointerId, pointerType: 'touch', isPrimary, button: type === 'pointermove' ? -1 : 0,
            buttons: type === 'pointerup' ? 0 : 1, clientX: p.x, clientY: p.y,
          }),
        )
      },
      { type, p, pointerId, isPrimary },
    )
  return {
    async down(p: Point) {
      last = p
      await fire('pointerdown', p)
    },
    async move(p: Point, steps = 8) {
      const from = last
      for (let i = 1; i <= steps; i++) {
        await fire('pointermove', { x: from.x + ((p.x - from.x) * i) / steps, y: from.y + ((p.y - from.y) * i) / steps })
      }
      last = p
    },
    async up() {
      await fire('pointerup', last)
    },
  }
}

async function drag(page: Page, browserName: string, from: Point, to: Point) {
  const f = await finger(page, browserName)
  await f.down(from)
  await f.move(to)
  await f.up()
}

async function centerOf(page: Page, selector: string): Promise<Point> {
  const box = (await page.locator(selector).boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** A real one-finger swipe up (Chromium only): the page scrolls if nothing refuses it. */
async function swipeUp(page: Page, at: Point) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y }] })
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: at.x, y: at.y - 25 * i }] })
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

test('drag draws a box, Comment opens the box with a preview', async ({ page, browserName }) => {
  await openArea(page)
  await expect(overlay(page)).toHaveCSS('touch-action', 'none')

  await drag(page, browserName, { x: 60, y: 150 }, { x: 300, y: 400 })

  // A box with four handles, and nothing captured yet
  await expect(draft(page)).toBeVisible()
  const box = (await draft(page).boundingBox())!
  expect(Math.abs(box.x - 60)).toBeLessThanOrEqual(2)
  expect(Math.abs(box.y - 150)).toBeLessThanOrEqual(2)
  expect(Math.abs(box.width - 240)).toBeLessThanOrEqual(2)
  expect(Math.abs(box.height - 250)).toBeLessThanOrEqual(2)
  for (const corner of ['nw', 'ne', 'sw', 'se']) {
    const h = (await handle(page, corner).boundingBox())!
    expect(Math.round(h.width), corner).toBe(44)
    expect(Math.round(h.height), corner).toBe(44)
  }
  await expect(feedbackBox(page)).toHaveCount(0)
  await expect(bar(page).getByText('Adjust the corners, then Comment.')).toBeVisible()
  await expect(barButton(page, 'Cancel')).toBeVisible()
  await expect(barButton(page, 'Done')).toHaveCount(0)

  await barButton(page, 'Comment').tap()
  await expect(page.getByText('Area Feedback')).toBeVisible()
  await expect(page.getByText('area: 240 × 250px at (60, 150)')).toBeVisible()
  await expect(page.locator('[data-redline-ui] canvas')).toBeVisible()
  // The capture shows the page, not Redline's own box drawn over it
  const redEdge = await page.locator('[data-redline-ui] canvas').evaluate((c) => {
    const canvas = c as HTMLCanvasElement
    const ctx = canvas.getContext('2d')!
    let red = 0
    for (let y = 0; y < canvas.height; y += 4) {
      for (const x of [0, 1, canvas.width - 2, canvas.width - 1]) {
        const [r, g, b] = ctx.getImageData(x, y, 1, 1).data
        if (r > 200 && g < 110 && b < 110) red++
      }
    }
    return red
  })
  expect(redEdge, 'red selection border pixels in the capture').toBe(0)
  await expect(bar(page)).toHaveCount(0)
  await expect(handle(page, 'se')).toHaveCount(0)
  expect(await hostEvents(page)).toEqual([])
})

test('a handle drag resizes the box', async ({ page, browserName }) => {
  await openArea(page)
  await drag(page, browserName, { x: 60, y: 150 }, { x: 260, y: 350 })
  const before = (await draft(page).boundingBox())!

  // se: +40, +30 grows the box by 40x30 and keeps the top-left corner
  const se = await centerOf(page, '[data-redline-handle="se"]')
  await drag(page, browserName, se, { x: se.x + 40, y: se.y + 30 })
  const after = (await draft(page).boundingBox())!
  expect(Math.abs(after.width - before.width - 40)).toBeLessThanOrEqual(2)
  expect(Math.abs(after.height - before.height - 30)).toBeLessThanOrEqual(2)
  expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(2)
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(2)

  // nw: dragged past the far corner, the box stops at its smallest instead of flipping
  const nw = await centerOf(page, '[data-redline-handle="nw"]')
  await drag(page, browserName, nw, { x: nw.x + 400, y: nw.y + 400 })
  const smallest = (await draft(page).boundingBox())!
  expect(Math.round(smallest.width)).toBe(20)
  expect(Math.round(smallest.height)).toBe(20)
  expect(Math.abs(smallest.x + smallest.width - (after.x + after.width))).toBeLessThanOrEqual(2)

  // Cancel clears the box and brings Done back
  await barButton(page, 'Cancel').tap()
  await expect(draft(page)).toHaveCount(0)
  await expect(handle(page, 'se')).toHaveCount(0)
  await expect(bar(page).getByText('Drag to draw a box.')).toBeVisible()
  await expect(barButton(page, 'Done')).toBeVisible()
  expect(await hostEvents(page)).toEqual([])
})

test('a drag under 20px draws nothing', async ({ page, browserName }) => {
  await openArea(page)
  await drag(page, browserName, { x: 100, y: 200 }, { x: 112, y: 300 })
  await page.waitForTimeout(150)
  await expect(draft(page)).toHaveCount(0)
  await expect(handle(page, 'se')).toHaveCount(0)
  await expect(bar(page).getByText('Drag to draw a box.')).toBeVisible()

  // And a stray short drag after a box keeps the box
  await drag(page, browserName, { x: 60, y: 150 }, { x: 260, y: 350 })
  await expect(draft(page)).toBeVisible()
  await drag(page, browserName, { x: 320, y: 500 }, { x: 325, y: 505 })
  await expect(draft(page)).toBeVisible()
  expect(Math.round((await draft(page).boundingBox())!.width)).toBe(200)
})

test('the page does not scroll while drawing', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'Playwright WebKit has no touch-drag API, so native scrolling cannot be driven')
  await openArea(page)
  // A drag upward would scroll the page down if nothing refused it
  await drag(page, browserName, { x: 80, y: 600 }, { x: 300, y: 200 })
  await expect(draft(page)).toBeVisible()
  expect(await scrollY(page)).toBe(0)
  // Nor does a swipe on the bar
  const b = (await bar(page).boundingBox())!
  await swipeUp(page, { x: b.x + 20, y: b.y + 30 })
  await page.waitForTimeout(150)
  expect(await scrollY(page)).toBe(0)
})

test('every drawing surface refuses to pan or zoom', async ({ page, browserName }) => {
  await openArea(page)
  await expect(overlay(page)).toHaveCSS('touch-action', 'none')
  await expect(bar(page)).toHaveCSS('touch-action', 'none')
  expect(await touchMoveLocked(page)).toBe(true)
  await drag(page, browserName, { x: 60, y: 150 }, { x: 260, y: 350 })
  for (const corner of ['nw', 'ne', 'sw', 'se']) await expect(handle(page, corner)).toHaveCSS('touch-action', 'none')
})

test('Done mid-draw restores scrolling', async ({ page, browserName }) => {
  await openArea(page)
  const before = await bodyStyle(page)
  const f = await finger(page, browserName)
  await f.down({ x: 60, y: 150 })
  await f.move({ x: 200, y: 300 })
  // The bar still offers Done while the finger is down; a second hand presses it
  await barButton(page, 'Done').evaluate((b) => (b as HTMLButtonElement).click())
  await expect.poll(() => page.evaluate(() => (window as any).__redlineClosed === true)).toBe(true)
  await f.up()

  await expect(page.locator('[data-redline-ui]')).toHaveCount(0)
  expect(await bodyStyle(page)).toEqual(before)
  expect(await touchMoveLocked(page)).toBe(false)
  if (browserName !== 'webkit') {
    // Native scrolling can only be driven on Chromium (Playwright WebKit has no touch-drag API)
    await swipeUp(page, await centerOf(page, '#rows li:nth-child(6)'))
    await expect.poll(() => scrollY(page)).toBeGreaterThan(0)
  }
})

test('leaving Area any other way restores scrolling', async ({ page, browserName }) => {
  await openArea(page)
  const before = await bodyStyle(page)

  // Switching back to Element clears the box
  await drag(page, browserName, { x: 60, y: 150 }, { x: 260, y: 350 })
  await expect(draft(page)).toBeVisible()
  await barButton(page, 'Cancel').tap()
  await drag(page, browserName, { x: 60, y: 150 }, { x: 260, y: 350 })
  await expect(draft(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(draft(page)).toHaveCount(0)
  await barButton(page, 'Element').tap()
  await expect(overlay(page)).toHaveCount(0)
  expect(await touchMoveLocked(page)).toBe(false)
  expect(await bodyStyle(page)).toEqual(before)

  // Back in Area, a box, then S to Element: the box goes and the lock lifts
  await barButton(page, 'Area').tap()
  await drag(page, browserName, { x: 60, y: 150 }, { x: 260, y: 350 })
  await expect(draft(page)).toBeVisible()
  await page.keyboard.press('s')
  await expect(barButton(page, 'Element')).toHaveAttribute('aria-pressed', 'true')
  await expect(draft(page)).toHaveCount(0)
  expect(await touchMoveLocked(page)).toBe(false)
  await page.keyboard.press('s')
  await expect(barButton(page, 'Area')).toHaveAttribute('aria-pressed', 'true')
  await expect(draft(page)).toHaveCount(0)

  // The host turns Redline off mid-draw: nothing left, and back on starts clean
  const f = await finger(page, browserName)
  await f.down({ x: 60, y: 150 })
  await f.move({ x: 200, y: 300 })
  await page.evaluate(() => (window as any).__redlineSetActive(false))
  await f.up()
  await expect(page.locator('[data-redline-ui]')).toHaveCount(0)
  expect(await touchMoveLocked(page)).toBe(false)
  expect(await bodyStyle(page)).toEqual(before)
  await page.evaluate(() => (window as any).__redlineSetActive(true))
  await expect(bar(page).getByText('Tap what you want to comment on.')).toBeVisible()
  await expect(draft(page)).toHaveCount(0)

  // Esc in Area with nothing drawn turns Redline off and lifts the lock
  await barButton(page, 'Area').tap()
  expect(await touchMoveLocked(page)).toBe(true)
  await page.keyboard.press('Escape')
  await expect.poll(() => page.evaluate(() => (window as any).__redlineClosed === true)).toBe(true)
  expect(await touchMoveLocked(page)).toBe(false)
  if (browserName !== 'webkit') {
    // Native scrolling can only be driven on Chromium (Playwright WebKit has no touch-drag API)
    await swipeUp(page, await centerOf(page, '#rows li:nth-child(6)'))
    await expect.poll(() => scrollY(page)).toBeGreaterThan(0)
  }
})

test('turning Redline off while a box is captured reopens nothing later', async ({ page, browserName }) => {
  await openArea(page)
  await drag(page, browserName, { x: 60, y: 150 }, { x: 260, y: 350 })
  await expect(draft(page)).toBeVisible()
  // Comment starts the capture; the host turns Redline off before it finishes
  await barButton(page, 'Comment').evaluate((b) => {
    (b as HTMLButtonElement).click()
    ;(window as any).__redlineSetActive(false)
  })
  await page.evaluate(() => (window as any).__redlineSetActive(true))
  await page.waitForTimeout(1500)
  await expect(page.getByText('Area Feedback')).toHaveCount(0)
  await expect(bar(page).getByText('Tap what you want to comment on.')).toBeVisible()
})

test('a second finger cannot restart or end the drag', async ({ page }) => {
  await openArea(page)
  // Sent as touch PointerEvents on both engines, so the second finger is exact
  await page.evaluate(() => {
    const el = document.querySelector('[data-redline-area-overlay]')!
    const fire = (type: string, pointerId: number, isPrimary: boolean, x: number, y: number) =>
      el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        pointerId, pointerType: 'touch', isPrimary, button: type === 'pointermove' ? -1 : 0, clientX: x, clientY: y,
      }))
    fire('pointerdown', 21, true, 60, 150)
    fire('pointermove', 21, true, 160, 250)
    fire('pointerdown', 22, false, 330, 600)
    fire('pointermove', 22, false, 340, 610)
    fire('pointerup', 22, false, 340, 610)
    fire('pointermove', 21, true, 260, 350)
    fire('pointerup', 21, true, 260, 350)
  })
  const box = (await draft(page).boundingBox())!
  expect(Math.round(box.x)).toBe(60)
  expect(Math.round(box.y)).toBe(150)
  expect(Math.round(box.width)).toBe(200)
  expect(Math.round(box.height)).toBe(200)
})

test('S mid-drag leaves no drag behind', async ({ page }) => {
  await openArea(page)
  const fire = (type: string, x: number, y: number) =>
    page.evaluate(({ type, x, y }) => {
      document.querySelector('[data-redline-area-overlay]')!.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        pointerId: 31, pointerType: 'touch', isPrimary: true, button: type === 'pointermove' ? -1 : 0, clientX: x, clientY: y,
      }))
    }, { type, x, y })
  await fire('pointerdown', 60, 150)
  await fire('pointermove', 160, 250)
  await page.keyboard.press('s')
  await expect(barButton(page, 'Element')).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('s')
  await expect(barButton(page, 'Area')).toHaveAttribute('aria-pressed', 'true')
  // The old finger's move and lift belong to no drag any more
  await fire('pointermove', 260, 350)
  await fire('pointerup', 260, 350)
  await page.waitForTimeout(150)
  await expect(draft(page)).toHaveCount(0)
  await expect(bar(page).getByText('Drag to draw a box.')).toBeVisible()
})

test('Cancel never sits where Done was', async ({ page, browserName }) => {
  await open(page)
  const done = (await barButton(page, 'Done').boundingBox())!

  // A staged pick
  const link = await centerOf(page, '#link')
  await page.touchscreen.tap(link.x, link.y)
  await expect(page.getByTestId('redline-pick-name')).toHaveText('Link: See all')
  expect(overlaps((await barButton(page, 'Cancel').boundingBox())!, done)).toBe(false)
  await barButton(page, 'Cancel').tap()

  // A drawn box
  await barButton(page, 'Area').tap()
  await drag(page, browserName, { x: 60, y: 150 }, { x: 260, y: 350 })
  expect(overlaps((await barButton(page, 'Cancel').boundingBox())!, done)).toBe(false)
})

test('a long press cannot open a link preview or select text while Redline is on', async ({ page }) => {
  await open(page)
  const userSelect = () => page.locator('#link').evaluate((el) => {
    const s = getComputedStyle(el) as any
    return s.userSelect || s.webkitUserSelect
  })
  const styleHas = (text: string) => page.evaluate((t) => [...document.querySelectorAll('style')].some((s) => s.textContent?.includes(t)), text)
  expect(await styleHas('-webkit-touch-callout: none')).toBe(true)
  expect(await userSelect()).toBe('none')

  await barButton(page, 'Done').tap()
  await expect(bar(page)).toHaveCount(0)
  expect(await styleHas('-webkit-touch-callout')).toBe(false)
  expect(await userSelect()).not.toBe('none')
})

test('the bar docks to the top, so a fixed bottom navigation can be picked', async ({ page }) => {
  await open(page)
  const toTop = bar(page).getByRole('button', { name: 'Move bar to top' })
  await expect(toTop).toBeVisible()
  const t = (await toTop.boundingBox())!
  expect(t.width).toBeGreaterThanOrEqual(44)
  expect(t.height).toBeGreaterThanOrEqual(44)

  await toTop.tap()
  await expect.poll(async () => Math.round((await bar(page).boundingBox())!.y)).toBe(0)
  expect(await bar(page).getAttribute('style')).toContain('env(safe-area-inset-top)')
  await expect(bar(page).getByRole('button', { name: 'Move bar to bottom' })).toBeVisible()
  await expect(bar(page).getByRole('button', { name: 'Move bar to top' })).toHaveCount(0)

  // The host's tab bar is reachable now
  const tab = await centerOf(page, '#tab-invoices')
  await page.touchscreen.tap(tab.x, tab.y)
  await expect(page.getByTestId('redline-pick-name')).toHaveText('Button: Invoices')
  const outline = (await page.getByTestId('redline-pick-outline').boundingBox())!
  const tabBox = (await page.locator('#tab-invoices').boundingBox())!
  expect(Math.abs(outline.x + 2 - tabBox.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(outline.y + 2 - tabBox.y)).toBeLessThanOrEqual(1)
  await barButton(page, 'Cancel').tap()

  // The bar stays at the top for the rest of the session, through Done and back on
  await barButton(page, 'Done').tap()
  await page.evaluate(() => (window as any).__redlineSetActive(true))
  await expect.poll(async () => Math.round((await bar(page).boundingBox())!.y)).toBe(0)

  // And it goes back down
  await bar(page).getByRole('button', { name: 'Move bar to bottom' }).tap()
  await expect.poll(async () => {
    const b = (await bar(page).boundingBox())!
    return Math.round(b.y + b.height)
  }).toBe(844)
  expect(await hostEvents(page)).toEqual([])
})
