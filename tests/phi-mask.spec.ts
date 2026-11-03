// Proves PHI never leaves the browser: drives the real inspector, intercepts the
// POST it sends, and checks the screenshot pixels and text fields.
//
// The PHI elements are painted in colors used nowhere else on the page (green
// background, magenta text). If any of those pixels reach the uploaded PNG, or the
// PHI strings reach the request body, masking failed.

import { test, expect, type Page, type Request } from '@playwright/test'
import { build } from 'esbuild'
import { fileURLToPath } from 'url'

const ORIGIN = 'http://redline.test'
const PHI_NAME = 'Jane Q. Patient'
const PHI_DOB = 'DOB 1970-01-01'

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

function pageHtml(props: object) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #ffffff; font: 16px sans-serif; }
  #card { margin: 100px 0 0 100px; width: 420px; padding: 24px; background: #dddddd; }
  .phi { display: block; background: #00ff00; color: #ff00ff; font-size: 28px; padding: 8px; margin-bottom: 12px; }
  /* Overflowing text must not escape its mask */
  .dob { display: block; width: 60px; white-space: nowrap; overflow: visible; background: #00ff00; color: #ff00ff; font-size: 28px; }
  .control { width: 80px; height: 30px; background: #0000ff; margin-top: 12px; }
</style></head>
<body>
  <div id="card" data-testid="patient-card">
    <span data-phi class="phi">${PHI_NAME}</span>
    <span class="dob">${PHI_DOB}</span>
    <p>Visible note</p>
    <div class="control"></div>
  </div>
  <div id="redline-root"></div>
  <script>window.__REDLINE_PROPS__ = ${JSON.stringify(props)}</script>
  <script>${bundle}</script>
</body></html>`
}

async function openFixture(page: Page, props: object, path = '/fixture') {
  const posts: Request[] = []
  await page.route(`${ORIGIN}/**`, async (route) => {
    const req = route.request()
    if (req.url().includes('/api/redlines')) {
      posts.push(req)
      return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' })
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body: pageHtml(props) })
  })
  await page.goto(ORIGIN + path)
  return posts
}

/** Decode the multipart body the inspector sent. */
async function readForm(req: Request) {
  const res = new Response(new Uint8Array(req.postDataBuffer()!), { headers: { 'content-type': req.headers()['content-type'] } })
  return res.formData()
}

/** Count pixels near each probe color in a PNG, decoded in the browser. */
async function countColors(page: Page, png: Buffer) {
  return page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob()
    const bmp = await createImageBitmap(blob)
    const canvas = new OffscreenCanvas(bmp.width, bmp.height)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height)
    const near = (r: number, g: number, b: number, i: number) =>
      Math.abs(data[i] - r) < 60 && Math.abs(data[i + 1] - g) < 60 && Math.abs(data[i + 2] - b) < 60
    const counts = { green: 0, magenta: 0, black: 0, blue: 0, total: bmp.width * bmp.height }
    for (let i = 0; i < data.length; i += 4) {
      if (near(0, 255, 0, i)) counts.green++
      else if (near(255, 0, 255, i)) counts.magenta++
      // Mask boxes are pure #000; Redline's capture background (#1a1a1a) must not count
      else if (data[i] < 6 && data[i + 1] < 6 && data[i + 2] < 6) counts.black++
      else if (near(0, 0, 255, i)) counts.blue++
    }
    return counts
  }, png.toString('base64'))
}

async function submit(page: Page) {
  await page.getByPlaceholder("What's wrong? What should change?").fill('Spacing is off')
  await page.getByRole('button', { name: 'Submit' }).click()
}

function assertNoPhiText(raw: string) {
  expect(raw).not.toContain(PHI_NAME)
  expect(raw).not.toContain('1970-01-01')
}

test('element mode: masked elements are black boxes in the screenshot and [redacted] in the text', async ({ page }) => {
  const posts = await openFixture(page, { phiSelectors: ['.dob'] }, '/fixture?q=Jane%20Patient#access_token=abc123')

  const captured = page.waitForEvent('console', (m) => m.text().includes('screenshot captured'))
  const card = (await page.locator('#card').boundingBox())!
  await page.mouse.click(card.x + 6, card.y + 6) // card padding, so the card itself is selected
  await captured

  await expect(page.getByText('[redacted]', { exact: false })).toBeVisible()
  await page.getByLabel('Include Screenshot').check()
  await submit(page)
  await expect.poll(() => posts.length).toBe(1)

  const form = await readForm(posts[0])
  const png = Buffer.from(await (form.get('screenshot') as File).arrayBuffer())
  const colors = await countColors(page, png)

  expect(colors.green, 'PHI background pixels in screenshot').toBe(0)
  expect(colors.magenta, 'PHI text pixels in screenshot').toBe(0)
  expect(colors.black, 'mask boxes present').toBeGreaterThan(1000)
  expect(colors.blue, 'unmasked content still rendered').toBeGreaterThan(1000)

  const text = String(form.get('element_text'))
  expect(text).toContain('[redacted]')
  expect(text).toContain('Visible note')
  assertNoPhiText(posts[0].postDataBuffer()!.toString('latin1'))

  expect(form.get('page_url')).toBe('/fixture?q=…')
})

test('area mode: masked elements are black boxes in the cropped screenshot', async ({ page }) => {
  const posts = await openFixture(page, { initialMode: 'area', phiSelectors: ['.dob'] })

  const captured = page.waitForEvent('console', (m) => m.text().includes('area screenshot captured'))
  const card = (await page.locator('#card').boundingBox())!
  await page.mouse.move(card.x - 10, card.y - 10)
  await page.mouse.down()
  await page.mouse.move(card.x + card.width + 10, card.y + card.height + 10, { steps: 5 })
  await page.mouse.up()
  await captured

  await submit(page)
  await expect.poll(() => posts.length).toBe(1)

  const form = await readForm(posts[0])
  const png = Buffer.from(await (form.get('screenshot') as File).arrayBuffer())
  const colors = await countColors(page, png)

  expect(colors.green, 'PHI background pixels in screenshot').toBe(0)
  expect(colors.magenta, 'PHI text pixels in screenshot').toBe(0)
  expect(colors.black, 'mask boxes present').toBeGreaterThan(1000)
  expect(colors.blue, 'unmasked content still rendered').toBeGreaterThan(1000)
  assertNoPhiText(posts[0].postDataBuffer()!.toString('latin1'))
})

test('selecting an element inside a masked one redacts it entirely', async ({ page }) => {
  const posts = await openFixture(page, {})
  const captured = page.waitForEvent('console', (m) => m.text().includes('screenshot captured'))
  await page.locator('.phi').click()
  await captured

  await page.getByLabel('Include Screenshot').check()
  await submit(page)
  await expect.poll(() => posts.length).toBe(1)

  const form = await readForm(posts[0])
  expect(form.get('element_text')).toBe('[redacted]')
  const colors = await countColors(page, Buffer.from(await (form.get('screenshot') as File).arrayBuffer()))
  expect(colors.green + colors.magenta).toBe(0)
  assertNoPhiText(posts[0].postDataBuffer()!.toString('latin1'))
})

test('fails closed: a bad selector drops the screenshot and the element text', async ({ page }) => {
  const posts = await openFixture(page, { phiSelectors: ['[[not-a-selector'] })
  const dropped = page.waitForEvent('console', (m) => m.text().includes('screenshot dropped'))
  const card = (await page.locator('#card').boundingBox())!
  await page.mouse.click(card.x + 6, card.y + 6)
  await dropped

  await page.getByLabel('Include Screenshot').check()
  await submit(page)
  await expect.poll(() => posts.length).toBe(1)

  expect(posts[0].headers()['content-type']).toContain('application/json')
  const body = posts[0].postDataJSON()
  expect(body.element_text).toBeNull()
  assertNoPhiText(JSON.stringify(body))
})

test('a failed save keeps the modal open with an error', async ({ page }) => {
  await page.route(`${ORIGIN}/api/redlines`, (route) => route.fulfill({ status: 401, body: 'Unauthorized' }))
  await page.route(`${ORIGIN}/fixture`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: pageHtml({}) }),
  )
  await page.goto(`${ORIGIN}/fixture`)
  const card = (await page.locator('#card').boundingBox())!
  await page.mouse.click(card.x + 6, card.y + 6)
  await submit(page)

  await expect(page.getByRole('alert')).toHaveText('Sign in to leave feedback.')
  await expect(page.getByPlaceholder("What's wrong? What should change?")).toHaveValue('Spacing is off')
})
