// What a capture says must match what the tester saw: element text keeps separate boxes
// apart, a scrolled panel is pictured where it is scrolled to, and the places that hold
// personal data on almost every app are masked without being tagged.

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

const PRIVATE = 'jane@example.com'

const pageHtml = (props: object) => `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; min-height: 100vh; font: 16px sans-serif; background: #ffffff; }
  #card { position: absolute; left: 40px; top: 40px; width: 360px; padding: 16px; background: #eeeeee; }
  .label { font-size: 12px; }
  .row { display: flex; gap: 8px; }
  .chip { display: inline-block; padding: 2px 6px; }
  .hidden { display: none; }
  /* A drawer scrolled to its lower half: red on top, blue below */
  #drawer { position: absolute; left: 520px; top: 40px; width: 300px; height: 300px; overflow-y: auto; padding-left: 30px; box-sizing: border-box; }
  #drawer .top { height: 600px; background: #ff0000; }
  #drawer .bottom { height: 600px; background: #0000ff; }
  #fields { position: absolute; left: 40px; top: 400px; width: 400px; padding: 12px; background: #eeeeee; }
  #fields input, #fields textarea, #fields [contenteditable], #fields a { display: block; margin: 6px 0; color: #ff00ff; font-size: 20px; }
</style></head><body>
  <div id="card">
    <div class="label">Unpaid</div>
    <div>$5,786.50</div>
    <div><span>5 invoices</span> · <span>$932.50 overdue</span></div>
    <div class="row"><span>Jobs</span><span data-phi>Jane Q. Patient</span><span>BKTMV06</span></div>
    <span class="chip">Confirm</span><span class="chip">More actions</span>
    <p>Hello <b>world</b>, again.</p>
    <div class="hidden">never shown</div>
  </div>
  <div id="drawer"><div class="top"></div><div class="bottom"></div></div>
  <div id="fields">
    <input id="email" type="email" value="${PRIVATE}">
    <input id="tel" type="tel" value="555-0100">
    <textarea id="notes">Client notes</textarea>
    <div id="editable" contenteditable="true">Draft reply</div>
    <a id="mail" href="mailto:${PRIVATE}">${PRIVATE}</a>
    <a id="call" href="tel:5550100">555-0100</a>
  </div>
  <div id="redline-root"></div>
  <script>window.__REDLINE_PROPS__ = ${JSON.stringify(props)}</script>
  <script>${'${bundle}'}</script>
</body></html>`

async function open(page: Page, props: object = {}) {
  const posts: Request[] = []
  await page.route(`${ORIGIN}/**`, async (route) => {
    const req = route.request()
    if (req.url().includes('/api/redlines')) {
      posts.push(req)
      return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' })
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body: pageHtml(props).replace('${bundle}', bundle) })
  })
  await page.goto(ORIGIN + '/x')
  return posts
}

async function send(page: Page, posts: Request[]) {
  await page.getByPlaceholder("What's wrong? What should change?").fill('Looks off')
  await page.getByRole('button', { name: 'Submit' }).click()
  await expect.poll(() => posts.length).toBe(1)
  const res = new Response(new Uint8Array(posts[0].postDataBuffer()!), { headers: { 'content-type': posts[0].headers()['content-type'] } })
  return res.formData()
}

/** Pick an element by clicking a point inside it (offset from its top-left). */
async function pick(page: Page, selector: string, dx = 4, dy = 4) {
  const captured = page.waitForEvent('console', (m) => m.text().includes('screenshot captured'))
  const box = (await page.locator(selector).boundingBox())!
  await page.mouse.move(box.x + dx, box.y + dy)
  await page.mouse.click(box.x + dx, box.y + dy)
  await captured
}

/** Share of pixels near red and near blue in a PNG. */
async function redBlue(page: Page, png: Buffer) {
  return page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob())
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    const ctx = c.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height)
    let red = 0, blue = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 200 && data[i + 1] < 60 && data[i + 2] < 60) red++
      else if (data[i] < 60 && data[i + 1] < 60 && data[i + 2] > 200) blue++
    }
    const total = bmp.width * bmp.height
    return { red: red / total, blue: blue / total }
  }, png.toString('base64'))
}

/** Pixels near magenta, the color only the private fields use. */
async function magenta(page: Page, png: Buffer) {
  return page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob())
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    const ctx = c.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height)
    let n = 0
    for (let i = 0; i < data.length; i += 4) if (data[i] > 180 && data[i + 1] < 90 && data[i + 2] > 180) n++
    return n
  }, png.toString('base64'))
}

const shotOf = async (form: FormData) => Buffer.from(await (form.get('screenshot') as File).arrayBuffer())

test('element text keeps separate boxes apart, so a label over a value never runs into one number', async ({ page }) => {
  const posts = await open(page)
  await pick(page, '#card', 2, 2)
  await page.getByLabel('Include Screenshot').check() // sends a form, as testers do
  // Multipart carries line breaks as CRLF; the route stores them as LF
  const text = String((await send(page, posts)).get('element_text')).replace(/\r\n/g, '\n')
  expect(text).toBe([
    'Unpaid',
    '$5,786.50',
    '5 invoices · $932.50 overdue',
    'Jobs',
    '[redacted]',
    'BKTMV06',
    'Confirm More actions',
    'Hello world, again.',
  ].join('\n'))
})

test('an area drawn over a scrolled drawer pictures what is on screen, not the drawer top', async ({ page }) => {
  const posts = await open(page, { initialMode: 'area' })
  await page.locator('#drawer').evaluate((el) => { el.scrollTop = 700 })
  const captured = page.waitForEvent('console', (m) => m.text().includes('area screenshot captured'))
  const box = (await page.locator('#drawer').boundingBox())!
  await page.mouse.move(box.x + 50, box.y + 20)
  await page.mouse.down()
  await page.mouse.move(box.x + 230, box.y + 200, { steps: 5 })
  await page.mouse.up()
  await captured
  const shot = await redBlue(page, await shotOf(await send(page, posts)))
  expect(shot.blue).toBeGreaterThan(0.9)
  expect(shot.red).toBe(0)
})

test('an area over a drawer scrolled to where red meets blue shows both, in place', async ({ page }) => {
  const posts = await open(page, { initialMode: 'area' })
  // 450px down: the red block ends 150px into the 300px drawer
  await page.locator('#drawer').evaluate((el) => { el.scrollTop = 450 })
  const captured = page.waitForEvent('console', (m) => m.text().includes('area screenshot captured'))
  const box = (await page.locator('#drawer').boundingBox())!
  await page.mouse.move(box.x + 50, box.y + 50)
  await page.mouse.down()
  await page.mouse.move(box.x + 250, box.y + 250, { steps: 5 })
  await page.mouse.up()
  await captured
  const shot = await redBlue(page, await shotOf(await send(page, posts)))
  // 100px of red over 100px of blue
  expect(shot.red).toBeGreaterThan(0.4)
  expect(shot.red).toBeLessThan(0.6)
  expect(shot.blue).toBeGreaterThan(0.4)
})

test('picking the scrolled drawer itself pictures what is on screen', async ({ page }) => {
  const posts = await open(page)
  await page.locator('#drawer').evaluate((el) => { el.scrollTop = 700 })
  await pick(page, '#drawer', 10, 150) // the drawer's own padding, beside its content
  await page.getByLabel('Include Screenshot').check()
  const shot = await redBlue(page, await shotOf(await send(page, posts)))
  expect(shot.blue).toBeGreaterThan(0.75)
  expect(shot.red).toBe(0)
})

test('email and phone fields, text areas, editable text and mailto/tel links are masked by default', async ({ page }) => {
  const posts = await open(page)
  await pick(page, '#fields', 2, 2)
  await page.getByLabel('Include Screenshot').check()
  const form = await send(page, posts)
  expect(await magenta(page, await shotOf(form))).toBe(0)
  const text = String(form.get('element_text'))
  expect(text).not.toContain(PRIVATE)
  expect(text).not.toContain('555-0100')
  expect(text).not.toContain('Client notes')
  expect(text).not.toContain('Draft reply')
  expect(text.match(/\[redacted\]/g)?.length).toBeGreaterThanOrEqual(5)
})

test('maskDefaults false leaves those places unmasked', async ({ page }) => {
  const posts = await open(page, { maskDefaults: false })
  await pick(page, '#fields', 2, 2)
  await page.getByLabel('Include Screenshot').check()
  const form = await send(page, posts)
  expect(await magenta(page, await shotOf(form))).toBeGreaterThan(100)
  expect(String(form.get('element_text'))).toContain(PRIVATE)
})
