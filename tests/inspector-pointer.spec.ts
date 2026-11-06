// The inspector on pointer events: the page never sees the press that picks something,
// and desktop hover, click, S, area drag and Esc behave exactly as before.

import { test, expect, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { fileURLToPath } from 'url'

const ORIGIN = 'http://redline.test'
test.use({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1 })

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

const pageHtml = () => `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; font: 16px sans-serif; background: #ffffff; }
  #card { margin: 100px 0 0 100px; width: 420px; padding: 24px; background: #dddddd; }
  #save { padding: 8px 16px; font-size: 16px; }
</style></head><body>
  <div id="card"><button id="save">Save invoice</button><p>Totals</p></div>
  <div id="redline-root"></div>
  <script>
    window.__hostEvents = []
    const save = document.getElementById('save')
    for (const type of ['pointerdown', 'mousedown', 'click']) {
      save.addEventListener(type, () => window.__hostEvents.push(type))
    }
    window.__REDLINE_PROPS__ = {}
  </script>
  <script>${bundle}</script>
</body></html>`

async function open(page: Page) {
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: pageHtml() }),
  )
  await page.goto(ORIGIN + '/x')
  // The inspector mounts asynchronously; its key and pointer listeners are ready once the pill shows
  await expect(page.getByText('Select Element')).toBeVisible()
}

const hostEvents = (page: Page) => page.evaluate(() => (window as any).__hostEvents as string[])
const feedbackBox = (page: Page) => page.getByPlaceholder("What's wrong? What should change?")
const dashedOutline = (page: Page) => page.locator('[data-redline-ui][style*="dashed"]')
const solidOutline = (page: Page) => page.locator('[data-redline-ui][style*="2px solid"]')

async function center(page: Page, selector: string) {
  const box = (await page.locator(selector).boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

test('the page never sees pointerdown, mousedown or click on what is picked', async ({ page }) => {
  await open(page)
  const { x, y } = await center(page, '#save')
  await page.mouse.move(x, y)
  await page.mouse.click(x, y)
  await expect(feedbackBox(page)).toBeVisible()
  await expect(page.getByText('#save', { exact: true })).toBeVisible()
  expect(await hostEvents(page)).toEqual([])
})

test('desktop still works as before', async ({ page }) => {
  await open(page)

  // Hover shows the dashed outline and the tag label
  const { x, y } = await center(page, '#save')
  await page.mouse.move(x, y)
  await expect(dashedOutline(page)).toBeVisible()
  await expect(page.getByText('button', { exact: true })).toBeVisible()

  // The click selects: solid outline and the feedback box for #save
  await page.mouse.click(x, y)
  await expect(solidOutline(page)).toBeVisible()
  await expect(dashedOutline(page)).toHaveCount(0)
  await expect(feedbackBox(page)).toBeVisible()
  await expect(page.getByText('#save', { exact: true })).toBeVisible()

  // Cancel steps back to hovering
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(feedbackBox(page)).toBeHidden()
  await expect(page.getByText('Select Element')).toBeVisible()

  // S switches to area mode
  await page.keyboard.press('s')
  await expect(page.getByText('Area Screenshot')).toBeVisible()

  // A drag under 20px is ignored
  await page.mouse.move(300, 300)
  await page.mouse.down()
  await page.mouse.move(310, 310, { steps: 3 })
  await page.mouse.up()
  await expect(feedbackBox(page)).toBeHidden()
  await expect(page.getByText('Area Screenshot')).toBeVisible()

  // A 100x80 mouse drag opens the box with a preview straight away
  const captured = page.waitForEvent('console', (m) => m.text().includes('area screenshot captured'))
  await page.mouse.move(200, 200)
  await page.mouse.down()
  await page.mouse.move(250, 240, { steps: 3 })
  await expect(page.getByText('50 × 40', { exact: true })).toBeVisible()
  await page.mouse.move(300, 280, { steps: 3 })
  await page.mouse.up()
  await captured
  await expect(page.getByText('Area Feedback')).toBeVisible()
  await expect(page.getByText('area: 100 × 80px at (200, 200)')).toBeVisible()
  await expect(page.locator('[data-redline-ui] canvas')).toBeVisible()
  await expect(feedbackBox(page)).toBeFocused()

  // Esc (outside the textarea) closes the box and stays in area mode, then turns Redline off
  await feedbackBox(page).evaluate((el) => (el as HTMLElement).blur())
  await page.keyboard.press('Escape')
  await expect(page.getByText('Area Feedback')).toBeHidden()
  await expect(page.getByText('Area Screenshot')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect.poll(() => page.evaluate(() => (window as any).__redlineClosed === true)).toBe(true)

  expect(await hostEvents(page)).toEqual([])
})

test('a cancelled area drag resets and captures nothing', async ({ page }) => {
  await open(page)
  await page.keyboard.press('s')
  await expect(page.getByText('Area Screenshot')).toBeVisible()

  await page.mouse.move(200, 200)
  await page.mouse.down()
  await page.mouse.move(300, 280, { steps: 3 })
  await expect(page.getByText('100 × 80', { exact: true })).toBeVisible()

  // The browser takes the pointer away mid-drag (a gesture, a system dialog)
  await page.locator('[data-redline-area-overlay]').dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' })
  await expect(page.getByText('100 × 80', { exact: true })).toBeHidden()
  await page.mouse.up()
  await expect(page.getByText('Area Feedback')).toBeHidden()
  await expect(page.getByText('Area Screenshot')).toBeVisible()
  await expect(page.locator('[data-redline-ui][style*="9999px"]')).toHaveCount(0)
})
