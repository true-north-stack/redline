// The feedback box in tester wording: a plain title, no selector, no UX review option, no
// keyboard hints, and an element pick that sends its screenshot unless the tester unticks
// it. Developer wording keeps today's box. Desktop (mouse) on Chromium.

import { test, expect, type Page, type Request } from '@playwright/test'
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

// #slow holds an image the route answers late once the page has loaded, so its capture
// is still running while the tester can already reach the box
const pageHtml = (props: object) => `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; font: 16px sans-serif; background: #ffffff; }
  #card { margin: 100px 0 0 100px; width: 420px; padding: 24px; background: #dddddd; }
  #save { padding: 8px 16px; font-size: 16px; }
  #slow { margin: 24px 0 0 100px; width: 420px; padding: 24px; background: #cde; }
  #slow img { width: 40px; height: 40px; display: block; }
</style></head><body>
  <div id="card"><button id="save">Save invoice</button><p>Totals</p></div>
  <div id="slow"><img src="/slow.png" alt=""><p>Slow card</p></div>
  <div id="redline-root"></div>
  <script>window.__REDLINE_PROPS__ = ${JSON.stringify(props)}</script>
  <script>${'${bundle}'}</script>
</body></html>`

// A 1x1 PNG
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

async function open(page: Page, props: object, slowImageMs = 0) {
  const posts: Request[] = []
  let imageRequests = 0
  await page.route(`${ORIGIN}/**`, async (route) => {
    const req = route.request()
    if (req.url().includes('/api/redlines')) {
      posts.push(req)
      return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' })
    }
    if (req.url().endsWith('/slow.png')) {
      // The page's own load is quick; the capture's fetch of the same image is the slow one
      if (slowImageMs && imageRequests++ > 0) await new Promise((r) => setTimeout(r, slowImageMs))
      return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'cache-control': 'no-store' }, body: PIXEL })
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body: pageHtml(props).replace('${bundle}', bundle) })
  })
  await page.goto(ORIGIN + '/x')
  await expect(page.getByText('Select Element')).toBeVisible()
  return posts
}

const feedbackBox = (page: Page) => page.getByPlaceholder("What's wrong? What should change?")
const screenshotBox = (page: Page) => page.getByLabel('Include Screenshot')

async function readForm(req: Request) {
  const res = new Response(new Uint8Array(req.postDataBuffer()!), { headers: { 'content-type': req.headers()['content-type'] } })
  return res.formData()
}

/** Click an element and open the box; `settled` resolves once its screenshot is captured (or dropped). */
async function pick(page: Page, selector: string, log = 'screenshot captured') {
  const settled = page.waitForEvent('console', (m) => m.text().includes(log))
  const box = (await page.locator(selector).boundingBox())!
  await page.mouse.move(box.x + 6, box.y + 6)
  await page.mouse.click(box.x + 6, box.y + 6)
  await expect(feedbackBox(page)).toBeVisible()
  return { settled }
}

/** Click an element and wait until its screenshot is captured (or dropped). */
async function pickAndCapture(page: Page, selector: string, log = 'screenshot captured') {
  await (await pick(page, selector, log)).settled
}

async function drawArea(page: Page) {
  await page.keyboard.press('s')
  await expect(page.getByText('Area Screenshot')).toBeVisible()
  const captured = page.waitForEvent('console', (m) => m.text().includes('area screenshot captured'))
  await page.mouse.move(200, 200)
  await page.mouse.down()
  await page.mouse.move(300, 280, { steps: 3 })
  await page.mouse.up()
  await captured
  await expect(feedbackBox(page)).toBeVisible()
}

test('tester box: plain title, no selector, no UX review, no keyboard hint', async ({ page }) => {
  await open(page, { audience: 'tester' })
  await pickAndCapture(page, '#save')

  await expect(page.getByText("What's wrong here?", { exact: true })).toBeVisible()
  await expect(page.getByText('Redline Feedback')).toHaveCount(0)
  await expect(page.getByText('#save', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Request UX Review')).toHaveCount(0)
  await expect(page.getByText(/Cmd\+Enter|Esc to cancel/)).toHaveCount(0)
  // The element's own words and the page stay, so the tester knows what they picked
  await expect(page.getByText('“Save invoice”')).toBeVisible()
  await expect(page.locator('[data-redline-ui][title="/x"]')).toBeVisible()

  // An area pick reads the same, without its dimensions line
  await page.getByRole('button', { name: 'Cancel' }).click()
  await drawArea(page)
  await expect(page.getByText("What's wrong here?", { exact: true })).toBeVisible()
  await expect(page.getByText('Area Feedback')).toHaveCount(0)
  await expect(page.getByText(/^area:/)).toHaveCount(0)
  await expect(page.getByText('Request UX Review')).toHaveCount(0)
  await expect(page.getByText(/Cmd\+Enter|Esc to cancel/)).toHaveCount(0)
  await expect(page.locator('[data-redline-ui] canvas')).toBeVisible()
  await expect(screenshotBox(page)).toBeChecked()
})

test('tester element pick has Include Screenshot ticked and sends a screenshot', async ({ page }) => {
  const posts = await open(page, { audience: 'tester' })
  await pickAndCapture(page, '#save')
  await expect(screenshotBox(page)).toBeChecked()

  await feedbackBox(page).fill('Button label is unclear')
  await page.getByRole('button', { name: 'Submit' }).click()
  await expect.poll(() => posts.length).toBe(1)
  expect(posts[0].headers()['content-type']).toContain('multipart/form-data')
  const form = await readForm(posts[0])
  expect(form.get('screenshot')).toBeInstanceOf(File)
  expect((form.get('screenshot') as File).size).toBeGreaterThan(100)
  expect(form.get('feedback')).toBe('Button label is unclear')
  expect(form.get('ux_review_requested')).toBe('false')
})

test('tester who unticks Include Screenshot before the capture finishes keeps it unticked', async ({ page }) => {
  const posts = await open(page, { audience: 'tester' }, 1500)
  const { settled } = await pick(page, '#slow')
  let capturedYet = false
  void settled.then(() => { capturedYet = true })
  await expect(screenshotBox(page)).not.toBeChecked()
  await screenshotBox(page).check()
  await screenshotBox(page).uncheck()
  // The capture was still waiting on the slow image while the tester chose
  expect(capturedYet).toBe(false)
  await settled
  await page.waitForTimeout(100)
  await expect(screenshotBox(page)).not.toBeChecked()

  await feedbackBox(page).fill('No picture please')
  await page.getByRole('button', { name: 'Submit' }).click()
  await expect.poll(() => posts.length).toBe(1)
  expect(posts[0].headers()['content-type']).toContain('application/json')
})

test('tester pick whose capture drops says so and stays unticked', async ({ page }) => {
  const posts = await open(page, { audience: 'tester', phiSelectors: ['[[not-a-selector'] })
  await pickAndCapture(page, '#save', 'screenshot dropped')
  await expect(screenshotBox(page)).not.toBeChecked()
  await expect(screenshotBox(page)).toBeDisabled()
  await expect(page.getByText('Screenshot dropped: masking failed.')).toBeVisible()

  await feedbackBox(page).fill('Spacing is off')
  await page.getByRole('button', { name: 'Submit' }).click()
  await expect.poll(() => posts.length).toBe(1)
  expect(posts[0].headers()['content-type']).toContain('application/json')
})

test('developer box is unchanged', async ({ page }) => {
  await open(page, {})
  await pickAndCapture(page, '#save')

  await expect(page.getByText('Redline Feedback', { exact: true })).toBeVisible()
  await expect(page.getByText("What's wrong here?")).toHaveCount(0)
  await expect(page.getByText('#save', { exact: true })).toBeVisible()
  await expect(page.getByText('Request UX Review')).toBeVisible()
  await expect(page.getByText('Cmd+Enter to submit · Esc to cancel')).toBeVisible()
  await page.waitForTimeout(100)
  await expect(screenshotBox(page)).not.toBeChecked()

  // The box keeps its desktop size: 400px of content plus padding and border
  const modal = (await feedbackBox(page).locator('..').boundingBox())!
  expect(Math.round(modal.width)).toBe(442)

  await page.getByRole('button', { name: 'Cancel' }).click()
  await drawArea(page)
  await expect(page.getByText('Area Feedback', { exact: true })).toBeVisible()
  await expect(page.getByText('area: 100 × 80px at (200, 200)')).toBeVisible()
  await expect(page.getByText('Request UX Review')).toBeVisible()
  await expect(page.getByText('Cmd+Enter to submit · Esc to cancel')).toBeVisible()
})

for (const key of ['Control+Enter', 'Meta+Enter']) {
  test(`${key.split('+')[0] === 'Control' ? 'Ctrl' : 'Cmd'}+Enter submits`, async ({ page }) => {
    const posts = await open(page, {})
    await pickAndCapture(page, '#save')
    await feedbackBox(page).fill('Keyboard send')
    await feedbackBox(page).press(key)
    await expect.poll(() => posts.length).toBe(1)
    expect(posts[0].postDataJSON().feedback).toBe('Keyboard send')
  })
}

test('a press that starts in the box and ends on the backdrop does not close it', async ({ page }) => {
  await open(page, { audience: 'tester' })
  await pickAndCapture(page, '#save')
  await feedbackBox(page).fill('Half a thought')
  // Past a double click's window, so only where the press began decides
  await page.waitForTimeout(600)

  // Selecting text in the note and letting go past the box's edge
  const area = (await feedbackBox(page).boundingBox())!
  await page.mouse.move(area.x + 20, area.y + 10)
  await page.mouse.down()
  await page.mouse.move(20, 20, { steps: 5 })
  await page.mouse.up()
  await expect(feedbackBox(page)).toBeVisible()
  await expect(feedbackBox(page)).toHaveValue('Half a thought')

  // A real click on the backdrop still closes it
  await page.mouse.click(20, 20)
  await expect(feedbackBox(page)).toBeHidden()
})
