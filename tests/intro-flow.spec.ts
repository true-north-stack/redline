// The introduction inside the real inspector: it opens the first time Redline turns on
// (never on page load), shows alone while open, and closing it leaves Redline on, ready to
// pick in the mode it was turned on in. Desktop tests run on Chromium; touch tests run on
// Chromium with touch emulation and on WebKit as an iPhone 13.

import { test, expect, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { fileURLToPath } from 'url'

const ORIGIN = 'http://redline.test'

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

// #toggle is the host's own "turn Redline on" button; #vanish turns it on and removes itself
const pageHtml = (props: object) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><style>
  body { margin: 0; font: 16px sans-serif; background: #ffffff; }
  #card { margin: 120px 24px 0; max-width: 420px; padding: 24px; background: #dddddd; }
  #save { padding: 8px 16px; font-size: 16px; }
  #host { margin: 24px; display: flex; gap: 12px; }
</style></head><body>
  <div id="card"><button id="save">Save invoice</button><p>Totals</p></div>
  <div id="host">
    <button id="toggle" onclick="window.__redlineSetActive(true)">Feedback</button>
    <button id="vanish" onclick="window.__redlineSetActive(true); this.remove()">Feedback once</button>
  </div>
  <div id="redline-root"></div>
  <script>window.__REDLINE_PROPS__ = ${JSON.stringify(props)}</script>
  <script>${bundle}</script>
</body></html>`

async function open(page: Page, props: object = {}) {
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: pageHtml({ showIntro: true, ...props }) }),
  )
  await page.goto(ORIGIN + '/x')
  await page.waitForFunction(() => typeof (window as any).__redlineSetActive === 'function')
}

const intro = (page: Page) => page.getByRole('dialog')
const introTitle = (page: Page) => intro(page).locator('h2').filter({ visible: true })
const primary = (page: Page) => intro(page).getByRole('button', { name: /^(Next|Start)$/ })
const pill = (page: Page) => page.getByText(/^(Select Element|Area Screenshot)$/)
const help = (page: Page) => page.getByRole('button', { name: 'Show introduction' })
const bar = (page: Page) => page.getByTestId('redline-touch-bar')
const feedbackBox = (page: Page) => page.getByPlaceholder("What's wrong? What should change?")
const closed = (page: Page) => page.evaluate(() => (window as any).__redlineClosed === true)
const setActive = (page: Page, on: boolean) => page.evaluate((on) => (window as any).__redlineSetActive(on), on)
// The host's toggle off, waited out so a toggle back on is a separate activation
async function turnOff(page: Page) {
  await setActive(page, false)
  await expect(page.locator('[data-redline-ui]')).toHaveCount(0)
}
// Everything Redline renders that isn't the introduction: pill, bar, outlines, overlays
const otherRedlineUi = (page: Page) => page.locator('[data-redline-ui]:not(.rl-intro-root, .rl-intro-root *)')
const bodyCursor = (page: Page) => page.evaluate(() => getComputedStyle(document.body).cursor)
// Whether a touchmove on this element would be refused (Area mode's drawing lock)
const touchMoveRefused = (page: Page, selector: string) =>
  page.evaluate((selector) => {
    const e = new Event('touchmove', { bubbles: true, cancelable: true })
    document.querySelector(selector)!.dispatchEvent(e)
    return e.defaultPrevented
  }, selector)

async function startThrough(page: Page) {
  while ((await primary(page).textContent()) === 'Next') await primary(page).click()
  await primary(page).click()
  await expect(intro(page)).toBeHidden()
}

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop flow: the iPhone project has no mouse')
  test.use({ viewport: { width: 1000, height: 700 } })

  test('first activation shows the introduction; after Start the inspector is ready to pick', async ({ page }) => {
    await open(page)
    await expect(intro(page)).toBeVisible()
    await expect(introTitle(page)).toHaveText('Point at what you mean')
    // Only the introduction: no pill, no crosshair, and the page under it can't be hovered
    await expect(otherRedlineUi(page)).toHaveCount(0)
    expect(await bodyCursor(page)).not.toBe('crosshair')
    const save = (await page.locator('#save').boundingBox())!
    await page.mouse.move(save.x + 10, save.y + 10)
    await expect(otherRedlineUi(page)).toHaveCount(0)

    await startThrough(page)
    await expect(pill(page)).toHaveText('Select Element')
    expect(await bodyCursor(page)).toBe('crosshair')
    expect(await closed(page)).toBe(false)
    await page.locator('#save').click()
    await expect(feedbackBox(page)).toBeVisible()
  })

  test('appears when Redline turns on, never on page load, and again next time', async ({ page }) => {
    await open(page, { startActive: false })
    await expect(page.locator('#save')).toBeVisible()
    await page.waitForTimeout(200)
    await expect(intro(page)).toHaveCount(0)

    await setActive(page, true)
    await expect(intro(page)).toBeVisible()
    await intro(page).getByRole('button', { name: 'Close' }).click()
    await expect(intro(page)).toBeHidden()

    // Closed without "Don't show this again": the next activation shows it again
    await turnOff(page)
    await setActive(page, true)
    await expect(intro(page)).toBeVisible()
  })

  test('Esc in the introduction closes it but leaves Redline on', async ({ page }) => {
    await open(page)
    await expect(intro(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(intro(page)).toBeHidden()
    expect(await closed(page)).toBe(false)
    await expect(pill(page)).toBeVisible()
    // The inspector's own Esc still turns Redline off afterwards
    await page.keyboard.press('Escape')
    await expect.poll(() => closed(page)).toBe(true)
  })

  test('opened in area mode, it lands in Area after closing', async ({ page }) => {
    await open(page, { initialMode: 'area' })
    await expect(intro(page)).toBeVisible()
    await expect(page.locator('[data-redline-area-overlay]')).toHaveCount(0)
    await startThrough(page)
    await expect(pill(page)).toHaveText('Area Screenshot')
    await expect(page.locator('[data-redline-area-overlay]')).toBeVisible()
  })

  test("the ? button reopens it after Don't show this again", async ({ page }) => {
    await open(page)
    await intro(page).getByLabel("Don't show this again").check()
    await startThrough(page)
    expect(await page.evaluate(() => localStorage.getItem('redline:intro:v1'))).toBe('1')

    // Remembered: turning Redline on again goes straight to picking
    await turnOff(page)
    await setActive(page, true)
    await expect(pill(page)).toBeVisible()
    await page.waitForTimeout(200)
    await expect(intro(page)).toHaveCount(0)

    await help(page).click()
    await expect(intro(page)).toBeVisible()
    await expect(introTitle(page)).toHaveText('Point at what you mean')
    await expect(pill(page)).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(intro(page)).toBeHidden()
    // Focus returns to the ? that opened it
    await expect(help(page)).toBeFocused()
  })

  test('tester audience reaches the introduction', async ({ page }) => {
    await open(page, { audience: 'tester' })
    await primary(page).click()
    await expect(intro(page).getByText("Don't type client names or details. Anything private on screen is blacked out before it's sent.")).toBeVisible()
    await primary(page).click()
    await expect(intro(page).getByText('Every note goes to the team, who read each one.')).toBeVisible()
  })

  test('shortcuts false reaches the introduction', async ({ page }) => {
    await open(page, { shortcuts: false })
    await primary(page).click()
    await expect(introTitle(page)).toHaveText("Say what's wrong")
    await expect(primary(page)).toHaveText('Start')
  })

  test('while it is open the inspector ignores every key', async ({ page }) => {
    await open(page)
    await expect(intro(page)).toBeVisible()
    // Focus on the primary button: S would toggle the mode behind the modal. Pressed an odd
    // number of times in all, so a toggle that slipped through can't cancel itself out.
    await page.keyboard.press('s')
    // Focus dropped to the page: S and Esc still do nothing to the inspector
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('s')
    await page.keyboard.press('s')
    await page.keyboard.press('Escape')
    expect(await closed(page)).toBe(false)
    await expect(intro(page)).toBeVisible()
    await intro(page).getByRole('button', { name: 'Close' }).click()
    await expect(pill(page)).toHaveText('Select Element')
  })

  test('turning Redline off closes it; on again shows it', async ({ page }) => {
    await open(page)
    await expect(intro(page)).toBeVisible()
    await setActive(page, false)
    await expect(intro(page)).toHaveCount(0)
    await expect(page.locator('[data-redline-ui]')).toHaveCount(0)
    await setActive(page, true)
    await expect(intro(page)).toBeVisible()
  })

  test('focus starts on the primary button and returns to the host button that turned Redline on', async ({ page }) => {
    await open(page, { startActive: false })
    await page.locator('#toggle').click()
    await expect(intro(page)).toBeVisible()
    await expect(primary(page)).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(intro(page)).toBeHidden()
    await expect(page.locator('#toggle')).toBeFocused()
  })

  test("focus goes to Redline's own controls when that button is gone", async ({ page }) => {
    await open(page, { startActive: false })
    await page.locator('#vanish').click()
    await expect(intro(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(intro(page)).toBeHidden()
    await expect(help(page)).toBeFocused()
  })

  test.describe('on a touchscreen laptop', () => {
    test.use({ hasTouch: true })

    test("a finger on the pill's ? opens the introduction", async ({ page }) => {
      await open(page, { showIntro: false })
      // A mouse brings the pill
      await page.mouse.move(600, 500)
      await expect(pill(page)).toBeVisible()
      const box = (await help(page).boundingBox())!
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
      await expect(intro(page)).toBeVisible()
      // Opened by a finger: the touch version, on its first page
      await expect(introTitle(page)).toHaveText('Point at what you mean')
      await expect(intro(page).getByText('Tap one thing on the page, or draw a box around a region.')).toBeVisible()
      await startThrough(page)
      await expect(bar(page)).toBeVisible()
    })
  })
})

test.describe('touch', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

  test('touch activation shows the two-page touch introduction', async ({ page }) => {
    await open(page, { audience: 'tester' })
    await expect(intro(page)).toBeVisible()
    await expect(intro(page).getByText('Tap one thing on the page, or draw a box around a region.')).toBeVisible()
    await expect(otherRedlineUi(page)).toHaveCount(0)
    await primary(page).tap()
    await expect(introTitle(page)).toHaveText("Say what's wrong")
    await expect(intro(page).getByText(/Don't type client names/)).toBeVisible()
    await expect(primary(page)).toHaveText('Start')
    await primary(page).tap()
    await expect(intro(page)).toBeHidden()
    await expect(bar(page)).toBeVisible()
    await expect(bar(page).getByText('Tap what you want to comment on.')).toBeVisible()
    expect(await closed(page)).toBe(false)
  })

  test("the bar's ? reopens it", async ({ page }) => {
    await open(page, { showIntro: false })
    await expect(bar(page)).toBeVisible()
    await bar(page).getByRole('button', { name: 'Show introduction' }).tap()
    await expect(intro(page)).toBeVisible()
    await expect(bar(page)).toHaveCount(0)
    await intro(page).getByRole('button', { name: 'Close' }).tap()
    await expect(intro(page)).toBeHidden()
    await expect(bar(page)).toBeVisible()
  })

  test("in Area mode the introduction can still scroll, and the drawing lock returns after", async ({ page, browserName }) => {
    // A short phone, so the introduction is taller than the screen
    await page.setViewportSize({ width: 375, height: 480 })
    await open(page, { initialMode: 'area' })
    await expect(intro(page)).toBeVisible()
    const scrollable = await intro(page).evaluate((el) => el.scrollHeight > el.clientHeight)
    expect(scrollable).toBe(true)
    expect(await touchMoveRefused(page, '[role="dialog"]')).toBe(false)
    if (browserName === 'chromium') {
      // A real swipe scrolls it (Playwright WebKit has no touch-drag API to drive this)
      const box = (await intro(page).boundingBox())!
      const cdp = await page.context().newCDPSession(page)
      const x = box.x + box.width / 2
      const y = box.y + box.height - 40
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
      for (let i = 1; i <= 10; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - 20 * i }] })
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await expect.poll(() => intro(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
    }

    await intro(page).getByRole('button', { name: 'Close' }).tap()
    await expect(intro(page)).toBeHidden()
    await expect(bar(page).getByText('Drag to draw a box.')).toBeVisible()
    expect(await touchMoveRefused(page, 'body')).toBe(true)
  })
})
