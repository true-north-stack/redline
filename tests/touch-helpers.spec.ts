// Unit-level checks for the touch picking helpers, run in a real browser because
// they depend on layout (element boxes, viewport size).

import { test, expect, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { fileURLToPath } from 'url'

const ORIGIN = 'http://redline.test'

let bundle = ''
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./fixture/touch-helpers.ts', import.meta.url))],
    bundle: true,
    write: false,
    format: 'iife',
    logLevel: 'silent',
  })
  bundle = result.outputFiles[0].text
})

async function load(page: Page, body: string) {
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}</style></head><body>${body}<script>${bundle}</script></body></html>`,
    }),
  )
  await page.goto(`${ORIGIN}/`)
}

/** Ids of the path from the element matching selector. */
const pathIds = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const t = (window as any).__touch
    return t.pickPath(document.querySelector(sel)).map((e: HTMLElement) => e.id)
  }, selector)

const describe = (page: Page, selector: string, masks: string[] = ['[data-phi]']) =>
  page.evaluate(
    ({ sel, masks }) => (window as any).__touch.describeElement(document.querySelector(sel), masks),
    { sel: selector, masks },
  )

test('pickPath climbs from a span inside a button, and the default pick is the button', async ({ page }) => {
  await load(page, '<div id="card" style="padding:16px"><button id="save"><span id="label">Save invoice</span></button></div>')
  expect(await pathIds(page, '#label')).toEqual(['label', 'save', 'card'])
  const picked = await page.evaluate(() => {
    const t = (window as any).__touch
    const path = t.pickPath(document.querySelector('#label'))
    return path[t.defaultPickIndex(path)].id
  })
  expect(picked).toBe('save')
})

test('same-box wrappers collapse to one step', async ({ page }) => {
  await load(page, '<div id="outer"><div id="inner" style="padding:8px"><p id="t" style="margin:0">Hi</p></div></div>')
  const ids = await pathIds(page, '#t')
  const wrappers = ids.filter((id: string) => id === 'outer' || id === 'inner')
  expect(wrappers).toEqual(['inner'])
})

test('a same-box run keeps its meaningful element', async ({ page }) => {
  await load(page, '<a id="link" href="/x" style="display:block"><div id="wrap">Go</div></a>')
  const ids = await pathIds(page, '#wrap')
  expect(ids).toContain('link')
  expect(ids).not.toContain('wrap')
})

test('nothing inside Redline UI is pickable', async ({ page }) => {
  await load(page, '<div data-redline-ui><button id="b">x</button></div>')
  expect(await pathIds(page, '#b')).toEqual([])
})

test('full-viewport containers are skipped', async ({ page }) => {
  await load(page, '<div id="full" style="width:100vw;height:100vh"><p id="t" style="margin:0">Hi</p></div>')
  const ids = await pathIds(page, '#t')
  expect(ids).toContain('t')
  expect(ids).not.toContain('full')
})

test('describeElement names things in plain words', async ({ page }) => {
  await load(
    page,
    `<button id="b"><span>Save invoice</span></button>
     <a id="a" href="/c">Clients</a>
     <input id="i" aria-label="Search clients">
     <h1 id="h">Dashboard</h1>
     <div id="empty"></div>
     <div id="d" role="dialog" aria-label="Edit"></div>`,
  )
  expect(await describe(page, '#b')).toBe('Button: Save invoice')
  expect(await describe(page, '#a')).toBe('Link: Clients')
  expect(await describe(page, '#i')).toBe('Field: Search clients')
  expect(await describe(page, '#h')).toBe('Heading: Dashboard')
  expect(await describe(page, '#empty')).toBe('Section')
  expect(await describe(page, '#d')).toBe('Dialog: Edit')
})

test('describeElement never shows masked text', async ({ page }) => {
  await load(page, '<button id="b"><span data-phi>Jane Doe</span></button>')
  expect(await describe(page, '#b')).not.toContain('Jane')
})

test('long names are cut at 40 characters', async ({ page }) => {
  await load(page, `<button id="b">${'x'.repeat(60)}</button>`)
  const name = (await describe(page, '#b')).replace('Button: ', '')
  expect(name).toHaveLength(40)
  expect(name.endsWith('…')).toBe(true)
})
