// Element screenshots must look like the page: a transparent element is drawn over the
// background it sits on, and headings and paragraphs aren't pushed down by default margins.

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

// The layout FLT hit: a white main behind a transparent heading, inside flex and overflow.
// The dark variant has black on body only (html stays transparent) and a faint card tint.
const pageHtml = (dark: boolean) => `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; font: 16px sans-serif; background: ${dark ? 'rgb(0, 0, 0)' : '#e5e7eb'}; }
  .shell { display: flex; height: 100vh; }
  main { flex: 1; overflow: auto; ${dark ? '' : 'background: #ffffff;'} }
  .wrap { max-width: 800px; margin: 0 auto; padding: 32px 24px; ${dark ? 'background: rgba(255, 255, 255, 0.05);' : ''} }
  h1, p { margin: 0; font-size: 20px; line-height: 28px; color: ${dark ? '#f5f5f5' : '#111111'}; }
</style></head><body>
  <div class="shell"><main><div class="wrap">
    <h1 id="title">Dashboard</h1>
    <p id="intro">Welcome back</p>
  </div></main></div>
  <div id="redline-root"></div>
  <script>window.__REDLINE_PROPS__ = {}</script>
  <script>${'${bundle}'}</script>
</body></html>`

async function open(page: Page, dark = false) {
  const posts: Request[] = []
  await page.route(`${ORIGIN}/**`, async (route) => {
    const req = route.request()
    if (req.url().includes('/api/redlines')) {
      posts.push(req)
      return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' })
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body: pageHtml(dark).replace('${bundle}', bundle) })
  })
  await page.goto(ORIGIN + '/x')
  return posts
}

async function screenshotOf(page: Page, selector: string, dark = false) {
  const posts = await open(page, dark)
  const captured = page.waitForEvent('console', (m) => m.text().includes('screenshot captured'))
  const box = (await page.locator(selector).boundingBox())!
  await page.mouse.move(box.x + 5, box.y + 5)
  await page.mouse.click(box.x + 5, box.y + 5)
  await captured
  await page.getByLabel('Include Screenshot').check()
  await page.getByPlaceholder("What's wrong? What should change?").fill('Heading looks off')
  await page.getByRole('button', { name: 'Submit' }).click()
  await expect.poll(() => posts.length).toBe(1)
  const res = new Response(new Uint8Array(posts[0].postDataBuffer()!), { headers: { 'content-type': posts[0].headers()['content-type'] } })
  const file = (await res.formData()).get('screenshot') as File
  return Buffer.from(await file.arrayBuffer())
}

/** Background color at the top-left pixel, and the rows that hold dark ink. */
async function analyse(page: Page, png: Buffer) {
  return page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob())
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    const ctx = c.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height)
    let inkTop = -1, inkBottom = -1
    for (let y = 0; y < bmp.height; y++) {
      for (let x = 0; x < Math.min(bmp.width, 300); x++) {
        const i = (y * bmp.width + x) * 4
        if (data[i] < 90 && data[i + 1] < 90 && data[i + 2] < 90) {
          if (inkTop < 0) inkTop = y
          inkBottom = y
          break
        }
      }
    }
    return { width: bmp.width, height: bmp.height, corner: [data[0], data[1], data[2]], inkTop, inkBottom }
  }, png.toString('base64'))
}

for (const [name, selector] of [['heading', '#title'], ['paragraph', '#intro']] as const) {
  test(`a transparent ${name} is captured over the white behind it, with its text fully inside`, async ({ page }) => {
    const shot = await analyse(page, await screenshotOf(page, selector))
    // White background, not Redline's dark fill
    expect(shot.corner[0]).toBeGreaterThan(240)
    expect(shot.corner[1]).toBeGreaterThan(240)
    expect(shot.corner[2]).toBeGreaterThan(240)
    // The glyphs sit inside the frame, clear of the bottom edge (no default margin pushing them down)
    expect(shot.inkTop).toBeGreaterThan(0)
    expect(shot.inkBottom).toBeLessThan(shot.height - 2)
  })
}

test('on a dark page, a transparent heading is captured on the dark background behind it', async ({ page }) => {
  const shot = await analyse(page, await screenshotOf(page, '#title', true))
  // Black body, not white: the faint card tint is skipped, not mistaken for the background
  expect(shot.corner[0]).toBeLessThan(20)
  expect(shot.corner[1]).toBeLessThan(20)
  expect(shot.corner[2]).toBeLessThan(20)
})
