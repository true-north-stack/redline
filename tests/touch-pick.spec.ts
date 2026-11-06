// Touch picking: a tap stages a pick, Smaller and Bigger walk it, Comment opens the box,
// and the bottom bar replaces the desktop pill. Runs on Chromium with touch emulation
// and on WebKit as an iPhone 13.

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

const clients = Array.from({ length: 30 }, (_, i) => `<li>Client ${i + 1}</li>`).join('')

const pageHtml = () => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><style>
  body { margin: 0; font: 16px sans-serif; background: #ffffff; }
  #card { margin: 24px; padding: 16px; background: #dddddd; }
  #card h2 { margin: 0 0 12px; font-size: 18px; }
  #save { padding: 12px 20px; font-size: 16px; }
  #nav { display: inline-block; margin: 0 24px; padding: 8px 0; }
  #clients { margin: 24px; padding: 0; list-style: none; }
  #clients li { height: 56px; border-bottom: 1px solid #ccc; }
  #footer { position: fixed; left: 0; right: 0; bottom: 0; height: 160px; background: #cde; }
</style></head><body>
  <section id="card" aria-label="Invoice card">
    <h2>March invoice</h2>
    <button id="save"><span id="label">Save invoice</span></button>
  </section>
  <a id="nav" href="/elsewhere">Clients</a>
  <ul id="clients">${clients}</ul>
  <div id="footer">Host footer</div>
  <div id="redline-root"></div>
  <script>
    window.__hostEvents = []
    for (const id of ['card', 'save', 'label', 'nav', 'clients', 'footer']) {
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
const pickName = (page: Page) => page.getByTestId('redline-pick-name')
const outline = (page: Page) => page.getByTestId('redline-pick-outline')
const barButton = (page: Page, name: string) => bar(page).getByRole('button', { name, exact: true })
const feedbackBox = (page: Page) => page.getByPlaceholder("What's wrong? What should change?")
const hostEvents = (page: Page) => page.evaluate(() => (window as any).__hostEvents as string[])

async function open(page: Page) {
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: pageHtml() }),
  )
  await page.goto(ORIGIN + '/x')
  // Both projects report a coarse pointer, so the bar shows as soon as Redline is on
  await expect(bar(page)).toBeVisible()
}

async function center(page: Page, selector: string) {
  const box = (await page.locator(selector).boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function tapAt(page: Page, selector: string) {
  const { x, y } = await center(page, selector)
  await page.touchscreen.tap(x, y)
}

/** A one-finger press that travels, sent as touch PointerEvents (works on both engines). */
async function pointerDrag(page: Page, selector: string, dy: number, cancel = false) {
  await page.evaluate(
    ({ selector, dy, cancel }) => {
      const el = document.querySelector(selector)!
      const r = el.getBoundingClientRect()
      const x = r.left + r.width / 2
      const y = r.top + r.height / 2
      const fire = (type: string, cy: number) =>
        el.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true, cancelable: true, composed: true,
            pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, clientX: x, clientY: cy,
          }),
        )
      fire('pointerdown', y)
      for (let i = 1; i <= 5; i++) fire('pointermove', y + (dy * i) / 5)
      if (cancel) fire('pointercancel', y + dy)
      fire('pointerup', y + dy)
    },
    { selector, dy, cancel },
  )
}

test('tap on the label stages the button and names it', async ({ page }) => {
  await open(page)
  await tapAt(page, '#label')
  await expect(pickName(page)).toHaveText('Button: Save invoice')

  // The outline sits on the button's box
  const btn = (await page.locator('#save').boundingBox())!
  await expect(outline(page)).toBeVisible()
  await expect(outline(page)).toHaveCSS('border-top-style', 'solid')
  await expect(outline(page)).toHaveCSS('border-top-color', 'rgb(239, 68, 68)')
  await expect.poll(async () => {
    const o = (await outline(page).boundingBox())!
    return Math.abs(o.x + 2 - btn.x) <= 1 && Math.abs(o.width - 4 - btn.width) <= 1
  }).toBe(true)

  // Tapping elsewhere moves the pick
  await tapAt(page, '#clients li:nth-child(2)')
  await expect(pickName(page)).toHaveText('List item: Client 2')
  expect(await hostEvents(page)).toEqual([])
})

test('Bigger grows to the card, Smaller comes back, both disable at the ends', async ({ page }) => {
  await open(page)
  await tapAt(page, '#label')
  await expect(pickName(page)).toHaveText('Button: Save invoice')
  await expect(barButton(page, 'Smaller')).toBeEnabled()
  await expect(barButton(page, 'Bigger')).toBeEnabled()

  await barButton(page, 'Bigger').tap()
  await expect(pickName(page)).toHaveText('Section: Invoice card')
  await expect(barButton(page, 'Bigger')).toBeDisabled()
  const card = (await page.locator('#card').boundingBox())!
  await expect.poll(async () => Math.round((await outline(page).boundingBox())!.height - 4)).toBe(Math.round(card.height))

  await barButton(page, 'Smaller').tap()
  await expect(pickName(page)).toHaveText('Button: Save invoice')
  await barButton(page, 'Smaller').tap()
  await expect(pickName(page)).toHaveText('Section: Save invoice')
  await expect(barButton(page, 'Smaller')).toBeDisabled()
  await expect(barButton(page, 'Bigger')).toBeEnabled()
  expect(await hostEvents(page)).toEqual([])
})

test('Comment opens the feedback box for the staged element', async ({ page }) => {
  await open(page)
  await tapAt(page, '#label')
  await expect(pickName(page)).toHaveText('Button: Save invoice')
  await barButton(page, 'Bigger').tap()
  await barButton(page, 'Comment').tap()

  await expect(feedbackBox(page)).toBeVisible()
  await expect(page.getByText('#card', { exact: true })).toBeVisible()
  await expect(bar(page)).toBeHidden()

  // Cancelling the box returns to the bar with nothing staged
  await page.getByRole('button', { name: 'Cancel' }).tap()
  await expect(feedbackBox(page)).toBeHidden()
  await expect(bar(page)).toBeVisible()
  await expect(pickName(page)).toHaveCount(0)
  expect(await hostEvents(page)).toEqual([])
})

test('a scroll gesture selects nothing', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'Playwright WebKit has no touch-drag API')
  await open(page)
  const { x, y } = await center(page, '#clients li:nth-child(8)')
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - 20 * i }] })
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })

  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
  await page.waitForTimeout(200)
  await expect(pickName(page)).toHaveCount(0)
  await expect(barButton(page, 'Done')).toBeVisible()
})

test('a press that travels or is cancelled selects nothing', async ({ page }) => {
  await open(page)
  // Lifting two rows down: a tap there would stage Client 5
  await pointerDrag(page, '#clients li:nth-child(3)', 120)
  await pointerDrag(page, '#clients li:nth-child(3)', 0, true)
  await page.waitForTimeout(200)
  await expect(pickName(page)).toHaveCount(0)

  // A finger that drifts less than the slop is still a tap
  await pointerDrag(page, '#clients li:nth-child(3)', 6)
  await expect(pickName(page)).toHaveText('List item: Client 3')
})

test('tapping a link stages it and does not navigate', async ({ page }) => {
  await open(page)
  const before = page.url()
  await tapAt(page, '#nav')
  await expect(pickName(page)).toHaveText('Link: Clients')
  await page.waitForTimeout(300)
  expect(page.url()).toBe(before)
  expect(await hostEvents(page)).toEqual([])
})

test("tapping Redline's own bar never reaches the page", async ({ page }) => {
  await open(page)
  // The host footer sits right under the bar: a tap that fell through would land on it
  await barButton(page, 'Done').tap()
  await expect.poll(() => page.evaluate(() => (window as any).__redlineClosed === true)).toBe(true)
  await expect(bar(page)).toHaveCount(0)
  expect(await hostEvents(page)).toEqual([])
})

test('Done mid-pick leaves nothing behind', async ({ page }) => {
  await open(page)
  const bodyStyle = () => page.evaluate(() => ({ overflow: document.body.style.overflow, touchAction: document.body.style.touchAction }))
  const before = await bodyStyle()
  async function expectNothingLeft() {
    await expect(page.locator('[data-redline-ui]')).toHaveCount(0)
    expect(await bodyStyle()).toEqual(before)
    expect(await page.evaluate(() => [...document.querySelectorAll('style')].some((s) => s.textContent?.includes('crosshair')))).toBe(false)
  }

  // While a pick is staged, Cancel takes Done's place
  await tapAt(page, '#label')
  await expect(outline(page)).toBeVisible()
  await expect(barButton(page, 'Done')).toHaveCount(0)

  // The host's toggle turns Redline off mid-pick: nothing stays behind, and turning it
  // back on starts clean
  await page.evaluate(() => (window as any).__redlineSetActive(false))
  await expectNothingLeft()
  await page.evaluate(() => (window as any).__redlineSetActive(true))
  await expect(barButton(page, 'Done')).toBeVisible()
  await expect(pickName(page)).toHaveCount(0)
  await expect(outline(page)).toHaveCount(0)

  // Esc mid-pick drops the pick first, then turns Redline off
  await tapAt(page, '#label')
  await expect(pickName(page)).toHaveText('Button: Save invoice')
  await page.keyboard.press('Escape')
  await expect(pickName(page)).toHaveCount(0)
  await expect(page.evaluate(() => (window as any).__redlineClosed === true)).resolves.toBe(false)

  // Cancel, then Done
  await tapAt(page, '#label')
  await barButton(page, 'Cancel').tap()
  await expect(outline(page)).toHaveCount(0)
  await barButton(page, 'Done').tap()
  await expect.poll(() => page.evaluate(() => (window as any).__redlineClosed === true)).toBe(true)
  await expectNothingLeft()
  expect(await hostEvents(page)).toEqual([])
})

test('a mouse after a touch brings back the pill and hover', async ({ page }) => {
  await open(page)
  await expect(page.getByText('Select Element')).toHaveCount(0)
  await tapAt(page, '#label')
  await expect(pickName(page)).toHaveText('Button: Save invoice')
  await barButton(page, 'Cancel').tap()

  const { x, y } = await center(page, '#save')
  await page.mouse.move(x - 5, y)
  await page.mouse.move(x, y)
  await expect(page.getByText('Select Element')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Show introduction' })).toBeVisible()
  await expect(bar(page)).toHaveCount(0)
  await expect(page.locator('[data-redline-ui][style*="dashed"]')).toBeVisible()

  // And a touch brings the bar back
  await tapAt(page, '#nav')
  await expect(pickName(page)).toHaveText('Link: Clients')
  await expect(page.getByText('Select Element')).toHaveCount(0)
})

test('every touch control is at least 44px tall', async ({ page }) => {
  await open(page)

  async function checkAll() {
    const buttons = bar(page).getByRole('button')
    const count = await buttons.count()
    expect(count).toBeGreaterThan(0)
    for (let i = 0; i < count; i++) {
      const box = (await buttons.nth(i).boundingBox())!
      expect(box.height, await buttons.nth(i).innerText()).toBeGreaterThanOrEqual(44)
      expect(box.width).toBeGreaterThanOrEqual(44)
    }
  }

  // Nothing staged: Element, Area, ? and Done
  await expect(barButton(page, 'Element')).toHaveAttribute('aria-pressed', 'true')
  await expect(barButton(page, 'Area')).toHaveAttribute('aria-pressed', 'false')
  await expect(barButton(page, 'Show introduction')).toBeVisible()
  await checkAll()

  // A pick staged: Smaller, Bigger, Comment and Cancel
  await tapAt(page, '#label')
  await expect(barButton(page, 'Comment')).toBeVisible()
  await checkAll()

  // The bar sits on the bottom edge, full width, and stays inside the viewport
  const box = (await bar(page).boundingBox())!
  expect(Math.round(box.x)).toBe(0)
  expect(Math.round(box.width)).toBe(390)
  expect(Math.round(box.y + box.height)).toBe(844)
})

test('the Area switch changes mode and back', async ({ page }) => {
  await open(page)
  await barButton(page, 'Area').tap()
  await expect(barButton(page, 'Area')).toHaveAttribute('aria-pressed', 'true')
  await expect(barButton(page, 'Element')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('[data-redline-area-overlay]')).toHaveCount(1)
  await barButton(page, 'Element').tap()
  await expect(barButton(page, 'Element')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-redline-area-overlay]')).toHaveCount(0)
  await tapAt(page, '#label')
  await expect(pickName(page)).toHaveText('Button: Save invoice')
  expect(await hostEvents(page)).toEqual([])
})
