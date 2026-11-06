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
  <div id="rows" style="position: absolute; left: 520px; top: 480px; width: 300px; padding: 8px; background: #eeeeee;">
    <div class="row"><span>5 invoices</span><span>·</span><span>$932.50 overdue</span></div>
    <div class="row"><div><div>Due</div><div>Friday</div></div><div>Paid</div></div>
    <div style="display: grid; grid-template-columns: 1fr 1fr;"><span>Client</span><span>Rate</span><span>[name]</span><span>$90/h</span></div>
    <div style="display: flex; flex-direction: column;"><span>Line one</span><span>Line two</span></div>
    <div class="row"><div style="display: contents"><span>Open</span><span>3</span></div></div>
    <div class="row" style="flex-wrap: wrap; width: 120px;"><span style="width: 100px">Wrapped</span><span style="width: 100px">onto two</span></div>
  </div>
  <pre id="log" style="position: absolute; left: 40px; top: 650px; margin: 0;">line one
line two</pre>
  <!-- A component whose masked part shows a name passed in through a slot -->
  <x-field id="xf" style="display: block; position: absolute; left: 520px; top: 400px; padding: 10px; background: #eeeeee;"><span id="slotted" style="color: #ff00ff; font-size: 20px;">Jane Slot</span></x-field>
  <script>customElements.define('x-field', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<div data-phi style="padding: 4px"><slot></slot></div>' }
  })</script>
  <div id="redline-root"></div>
  <script>window.__REDLINE_PROPS__ = ${JSON.stringify(props)}</script>
  <script>${'${bundle}'}</script>
</body></html>`

// An app shell: a scrolling main with a sticky header, a badge placed against the shell
// (so it doesn't scroll), and a fixed button declared inside the scrolled content.
// Beside it, a grid that scrolls. Colors: sticky green, content red then blue, badge
// yellow, fixed button orange.
const shellHtml = (props: object) => `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; min-height: 100vh; background: #ffffff; }
  #shell { position: relative; width: 600px; height: 400px; }
  #main { height: 400px; overflow-y: auto; }
  .sticky { position: sticky; top: 0; height: 40px; background: #00ff00; }
  .red { height: 800px; background: #ff0000; }
  .blue { height: 800px; background: #0000ff; }
  .badge { position: absolute; right: 40px; top: 10px; width: 60px; height: 60px; background: #ffff00; }
  .fab { position: fixed; left: 700px; top: 20px; width: 60px; height: 60px; background: #ff8800; }
  #grid { display: grid; position: absolute; left: 0; top: 450px; width: 300px; height: 200px; overflow-y: auto; }
  #grid .red, #grid .blue { height: 300px; }
  /* A wide table scrolled sideways, with a sticky first column */
  #wide { position: absolute; left: 320px; top: 450px; width: 300px; height: 150px; overflow-x: auto; }
  #wide table { border-collapse: collapse; }
  #wide td { height: 100px; padding: 0; }
  #wide .pin { position: sticky; left: 0; min-width: 60px; background: #00ff00; }
  #wide .red, #wide .blue { min-width: 400px; height: 100px; }
  /* A first child pulled up by a negative margin */
  #neg { position: absolute; left: 650px; top: 450px; width: 150px; height: 150px; overflow-y: auto; }
  #neg .red { margin-top: -50px; height: 250px; }
  #neg .blue { height: 400px; }
</style></head><body>
  <div id="shell"><main id="main">
    <div class="sticky"></div>
    <div class="red"></div>
    <div class="blue"><div class="fab"></div></div>
    <div class="badge"></div>
  </main></div>
  <div id="grid"><div class="red"></div><div class="blue"></div></div>
  <div id="wide"><table><tr><td class="pin"></td><td class="red"></td><td class="blue"></td></tr></table></div>
  <div id="neg"><div class="red"></div><div class="blue"></div></div>
  <div id="tabs" style="position: absolute; left: 0; top: 660px; width: 300px; height: 30px; display: flex; justify-content: center; overflow-x: auto;"><div style="flex: none; width: 200px; background: #ff0000;"></div><div style="flex: none; width: 200px; background: #00ff00;"></div><div style="flex: none; width: 200px; background: #0000ff;"></div></div>
  <div id="redline-root"></div>
  <script>window.__REDLINE_PROPS__ = ${JSON.stringify(props)}</script>
  <script>${'${bundle}'}</script>
</body></html>`

async function open(page: Page, props: object = {}, html = pageHtml) {
  const posts: Request[] = []
  await page.route(`${ORIGIN}/**`, async (route) => {
    const req = route.request()
    if (req.url().includes('/api/redlines')) {
      posts.push(req)
      return route.fulfill({ status: 201, contentType: 'application/json', body: '{}' })
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body: html(props).replace('${bundle}', bundle) })
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

/** Share of pixels near each probe color in a PNG. */
async function colors(page: Page, png: Buffer) {
  return page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob())
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    const ctx = c.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height)
    const probes = { green: [0, 255, 0], red: [255, 0, 0], blue: [0, 0, 255], yellow: [255, 255, 0], orange: [255, 136, 0] } as const
    const counts: Record<string, number> = { green: 0, red: 0, blue: 0, yellow: 0, orange: 0 }
    for (let i = 0; i < data.length; i += 4) {
      for (const [name, [r, g, b]] of Object.entries(probes)) {
        if (Math.abs(data[i] - r) < 40 && Math.abs(data[i + 1] - g) < 40 && Math.abs(data[i + 2] - b) < 40) counts[name]++
      }
    }
    const total = bmp.width * bmp.height
    return Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / total]))
  }, png.toString('base64'))
}

async function drawArea(page: Page, x1: number, y1: number, x2: number, y2: number) {
  const captured = page.waitForEvent('console', (m) => m.text().includes('area screenshot captured'))
  await page.mouse.move(x1, y1)
  await page.mouse.down()
  await page.mouse.move(x2, y2, { steps: 5 })
  await page.mouse.up()
  await captured
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

test('element text keeps separate boxes apart and items side by side on one line', async ({ page }) => {
  const posts = await open(page)
  await pick(page, '#card', 2, 2)
  await page.getByLabel('Include Screenshot').check() // sends a form, as testers do
  // Multipart carries line breaks as CRLF; the route stores them as LF
  const text = String((await send(page, posts)).get('element_text')).replace(/\r\n/g, '\n')
  expect(text).toBe([
    'Unpaid',
    '$5,786.50',
    '5 invoices · $932.50 overdue',
    'Jobs [redacted] BKTMV06',
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

test('a scrolled app shell keeps its sticky header, its pinned badge and its fixed button', async ({ page }) => {
  const posts = await open(page, { initialMode: 'area' }, shellHtml)
  await page.locator('#main').evaluate((el) => { el.scrollTop = 1000 })
  await drawArea(page, 1, 1, 580, 390)
  const shot = await colors(page, await shotOf(await send(page, posts)))
  // 40px of sticky header over blue rows; the red block is scrolled away
  expect(shot.green).toBeGreaterThan(0.07)
  expect(shot.red).toBe(0)
  expect(shot.blue).toBeGreaterThan(0.6)
  expect(shot.yellow).toBeGreaterThan(0.01)
})

test('a fixed button declared inside scrolled content stays where the browser shows it', async ({ page }) => {
  const posts = await open(page, { initialMode: 'area' }, shellHtml)
  await page.locator('#main').evaluate((el) => { el.scrollTop = 1000 })
  await drawArea(page, 680, 1, 780, 100)
  const shot = await colors(page, await shotOf(await send(page, posts)))
  expect(shot.orange).toBeGreaterThan(0.3)
})

test('a scrolled grid is pictured where it is scrolled to', async ({ page }) => {
  const posts = await open(page, { initialMode: 'area' }, shellHtml)
  await page.locator('#grid').evaluate((el) => { el.scrollTop = 350 })
  await drawArea(page, 20, 470, 260, 630)
  const shot = await colors(page, await shotOf(await send(page, posts)))
  expect(shot.blue).toBeGreaterThan(0.9)
  expect(shot.red).toBe(0)
})

test('text in pre keeps its line breaks', async ({ page }) => {
  const posts = await open(page)
  await pick(page, '#log', 4, 4)
  await page.getByLabel('Include Screenshot').check()
  const text = String((await send(page, posts)).get('element_text')).replace(/\r\n/g, '\n')
  expect(text).toBe('line one\nline two')
})

test('a name slotted into a masked part of a component is masked, picked from the host or itself', async ({ page }) => {
  const posts = await open(page)
  await pick(page, '#xf', 2, 2)
  await page.getByLabel('Include Screenshot').check()
  const host = await send(page, posts)
  expect(String(host.get('element_text'))).not.toContain('Jane Slot')
  expect(await magenta(page, await shotOf(host))).toBe(0)

  posts.length = 0
  await page.reload()
  await pick(page, '#slotted', 10, 10)
  await page.getByLabel('Include Screenshot').check()
  const slotted = await send(page, posts)
  expect(String(slotted.get('element_text'))).toBe('[redacted]')
  expect(await magenta(page, await shotOf(slotted))).toBe(0)
})

test('a table scrolled sideways keeps its sticky first column', async ({ page }) => {
  const posts = await open(page, { initialMode: 'area' }, shellHtml)
  await page.locator('#wide').evaluate((el) => { el.scrollLeft = 500 })
  await drawArea(page, 330, 460, 610, 540)
  const shot = await colors(page, await shotOf(await send(page, posts)))
  // 50px of pinned green, then blue; the red cell is scrolled away
  expect(shot.green).toBeGreaterThan(0.12)
  expect(shot.red).toBe(0)
  expect(shot.blue).toBeGreaterThan(0.7)
})

test('a first child with a negative top margin is pictured where it is', async ({ page }) => {
  const posts = await open(page, { initialMode: 'area' }, shellHtml)
  await page.locator('#neg').evaluate((el) => { el.scrollTop = 150 })
  await drawArea(page, 651, 451, 780, 595)
  const shot = await colors(page, await shotOf(await send(page, posts)))
  // The browser shows 50px of red over 100px of blue
  expect(shot.red).toBeGreaterThan(0.25)
  expect(shot.red).toBeLessThan(0.42)
  expect(shot.blue).toBeGreaterThan(0.55)
})

test('an overflowing centered flex row scrolled sideways is pictured where it is', async ({ page }) => {
  const posts = await open(page, { initialMode: 'area' }, shellHtml)
  await page.locator('#tabs').evaluate((el) => { el.scrollLeft = 100 })
  const want = await colors(page, await page.locator('#tabs').screenshot())
  await drawArea(page, 1, 661, 299, 689)
  const shot = await colors(page, await shotOf(await send(page, posts)))
  // The copy may draw a classic scrollbar where the live page overlays one, so compare
  // where green gives way to blue rather than raw shares
  expect(shot.red).toBe(0)
  expect(shot.green / (shot.green + shot.blue)).toBeCloseTo(want.green / (want.green + want.blue), 1)
})

test('items side by side read on one line; a new row on screen starts a new line', async ({ page }) => {
  const posts = await open(page)
  await pick(page, '#rows', 2, 2)
  await page.getByLabel('Include Screenshot').check()
  const text = String((await send(page, posts)).get('element_text')).replace(/\r\n/g, '\n')
  expect(text).toBe([
    '5 invoices · $932.50 overdue',
    // An item that stacks its own lines keeps them
    'Due',
    'Friday',
    'Paid',
    'Client Rate',
    '[name] $90/h',
    'Line one',
    'Line two',
    'Open 3',
    'Wrapped',
    'onto two',
  ].join('\n'))
})
