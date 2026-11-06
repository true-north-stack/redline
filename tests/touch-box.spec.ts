// The feedback box on a phone, in tester wording: it fits the screen, and the second tap of
// a double tap on Comment can't close it. Runs on Chromium with touch emulation and on
// WebKit as an iPhone 13.

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

const pageHtml = () => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><style>
  body { margin: 0; font: 16px sans-serif; background: #ffffff; }
  #card { margin: 24px; padding: 16px; background: #dddddd; }
  #card h2 { margin: 0 0 12px; font-size: 18px; }
  #save { padding: 12px 20px; font-size: 16px; }
</style></head><body>
  <section id="card" aria-label="Invoice card">
    <h2>March invoice</h2>
    <button id="save">Save invoice</button>
  </section>
  <div id="redline-root"></div>
  <script>window.__REDLINE_PROPS__ = { audience: 'tester' }</script>
  <script>${bundle}</script>
</body></html>`

const bar = (page: Page) => page.getByTestId('redline-touch-bar')
const barButton = (page: Page, name: string) => bar(page).getByRole('button', { name, exact: true })
const feedbackBox = (page: Page) => page.getByPlaceholder("What's wrong? What should change?")
const dialog = (page: Page) => feedbackBox(page).locator('..')

async function open(page: Page) {
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: pageHtml() }),
  )
  await page.goto(ORIGIN + '/x')
  await expect(bar(page)).toBeVisible()
}

/** Tap the Save button and wait for its pick to be staged. */
async function stageSave(page: Page) {
  const box = (await page.locator('#save').boundingBox())!
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page.getByTestId('redline-pick-name')).toHaveText('Button: Save invoice')
}

test('the box and its note fit the screen', async ({ page }) => {
  await open(page)
  await stageSave(page)
  const captured = page.waitForEvent('console', (m) => m.text().includes('screenshot captured'))
  await barButton(page, 'Comment').tap()
  await expect(feedbackBox(page)).toBeVisible()
  await captured
  await expect(page.getByText("What's wrong here?", { exact: true })).toBeVisible()
  await expect(page.getByLabel('Include Screenshot')).toBeChecked()
  // The screenshot that will be sent is shown, small enough to keep the note on screen
  await expect(page.getByTestId('redline-element-preview')).toBeVisible()
  const shot = (await page.getByTestId('redline-element-preview').boundingBox())!
  expect(Math.round(shot.height)).toBeLessThanOrEqual(160)
  expect(shot.y + shot.height).toBeLessThan((await feedbackBox(page).boundingBox())!.y)

  const box = (await dialog(page).boundingBox())!
  const note = (await feedbackBox(page).boundingBox())!
  const viewport = page.viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
  // The note sits inside the box, short of its right edge by the padding
  expect(note.x).toBeGreaterThan(box.x)
  expect(note.x + note.width).toBeLessThanOrEqual(box.x + box.width - 1)

  // Big enough to hit with a thumb, and large enough type that iOS doesn't zoom on focus
  await expect(feedbackBox(page)).toHaveCSS('font-size', '16px')
  for (const name of ['Cancel', 'Submit', 'Close']) {
    const b = (await dialog(page).getByRole('button', { name, exact: true }).boundingBox())!
    expect(Math.round(b.height), name).toBeGreaterThanOrEqual(44)
  }
  const label = (await page.getByText('Include Screenshot').boundingBox())!
  expect(Math.round(label.height)).toBeGreaterThanOrEqual(44)
})

test('a double tap on Comment leaves the box open', async ({ page }) => {
  await open(page)
  await stageSave(page)
  const comment = (await barButton(page, 'Comment').boundingBox())!
  const x = comment.x + comment.width / 2
  const y = comment.y + comment.height / 2
  await page.touchscreen.tap(x, y)
  await page.touchscreen.tap(x, y)
  await expect(feedbackBox(page)).toBeVisible()
  await page.waitForTimeout(300)
  await expect(feedbackBox(page)).toBeVisible()

  // A deliberate tap on the backdrop, once the gesture is over, still closes it
  await page.waitForTimeout(400)
  await page.touchscreen.tap(x, y)
  await expect(feedbackBox(page)).toBeHidden()
  await expect(bar(page)).toBeVisible()
})

test('a press on the backdrop released inside the box leaves it open', async ({ page }) => {
  await open(page)
  await stageSave(page)
  await barButton(page, 'Comment').tap()
  await expect(feedbackBox(page)).toBeVisible()
  await feedbackBox(page).fill('Half a thought')
  // Past a double tap's window, so only where the press and release land decides
  await page.waitForTimeout(600)

  const note = (await feedbackBox(page).boundingBox())!
  await page.mouse.move(20, 20)
  await page.mouse.down()
  await page.mouse.move(note.x + 20, note.y + 10, { steps: 5 })
  await page.mouse.up()
  await page.waitForTimeout(100)
  await expect(feedbackBox(page)).toBeVisible()
  await expect(feedbackBox(page)).toHaveValue('Half a thought')

  // Pressed and released on the backdrop: closes
  await page.mouse.click(20, 20)
  await expect(feedbackBox(page)).toBeHidden()
})
