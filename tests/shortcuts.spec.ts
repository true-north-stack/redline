// The documented triple-tap keys, driven through the real hook in a real browser.

import { test, expect, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { fileURLToPath } from 'url'

const ORIGIN = 'http://redline.test'

let bundle = ''
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./fixture/shortcuts.tsx', import.meta.url))],
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  })
  bundle = result.outputFiles[0].text
})

async function load(page: Page, options: object = {}) {
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><body><div id="root"></div><script>window.__SHORTCUT_OPTIONS__ = ${JSON.stringify(options)}</script><script>${bundle}</script></body></html>`,
    }),
  )
  await page.goto(`${ORIGIN}/`)
  await page.waitForSelector('[data-testid="field"]')
}

const activations = (page: Page) => page.evaluate(() => (window as any).__activations as string[])

test('rrr, uuu and eee activate element, element and area', async ({ page }) => {
  await load(page)
  for (const key of ['r', 'u', 'e']) await page.keyboard.type(key.repeat(3))
  expect(await activations(page)).toEqual(['element', 'element', 'area'])
})

test('three presses slower than 500ms in total do nothing', async ({ page }) => {
  await load(page)
  await page.keyboard.press('r')
  await page.waitForTimeout(300)
  await page.keyboard.press('r')
  await page.waitForTimeout(300)
  await page.keyboard.press('r')
  expect(await activations(page)).toEqual([])
})

test('typing rrr in an input does nothing', async ({ page }) => {
  await load(page)
  await page.getByTestId('field').focus()
  await page.keyboard.type('rrr')
  await page.getByTestId('editable').focus()
  await page.keyboard.type('eee')
  expect(await activations(page)).toEqual([])
})

test('Cmd+R and key repeat do nothing', async ({ page }) => {
  await load(page)
  for (let i = 0; i < 3; i++) await page.keyboard.press('Meta+r')
  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+e')
  for (let i = 0; i < 3; i++) await page.keyboard.press('Alt+u')
  // Holding a key down fires repeat events after the first press
  await page.keyboard.down('r')
  await page.keyboard.down('r')
  await page.keyboard.down('r')
  await page.keyboard.up('r')
  expect(await activations(page)).toEqual([])
})

test('mixed keys reset the count', async ({ page }) => {
  await load(page)
  await page.keyboard.type('rre')
  expect(await activations(page)).toEqual([])
  await page.keyboard.type('ee')
  expect(await activations(page)).toEqual(['area'])
})

test('enabled false listens to nothing', async ({ page }) => {
  await load(page, { enabled: false })
  await page.keyboard.type('rrr')
  await page.keyboard.type('eee')
  expect(await activations(page)).toEqual([])
})

test('while a Redline dialog is open, keys do nothing wherever focus is', async ({ page }) => {
  await load(page, { dialog: true })
  // Focus on the dialog's button
  await page.getByTestId('dialog-button').focus()
  await page.keyboard.type('rrr')
  await page.keyboard.type('eee')
  // Focus dropped to the page while the dialog is still open
  await page.evaluate(() => (document.activeElement as HTMLElement).blur())
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)
  await page.keyboard.type('rrr')
  await page.keyboard.type('eee')
  expect(await activations(page)).toEqual([])
})

test('with no Redline dialog, keys from the page still work', async ({ page }) => {
  await load(page)
  await expect(page.locator('[role="dialog"]')).toHaveCount(0)
  await page.keyboard.type('rrr')
  expect(await activations(page)).toEqual(['element'])
})

test('Shift or Caps Lock (an uppercase key) still counts', async ({ page }) => {
  await load(page)
  // Shift held: the key arrives as "R" with shiftKey set
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+R')
  // Caps Lock on: the key arrives as "U" or "E" with no modifier
  await page.keyboard.type('UUU')
  await page.keyboard.type('EEE')
  expect(await activations(page)).toEqual(['element', 'element', 'area'])
})

test('a keydown with no key (Chrome autofill) throws nothing, and rrr still works', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))
  await load(page)
  await page.evaluate(() => {
    // Chrome autofill dispatches keydown events whose key is undefined
    const e = new KeyboardEvent('keydown', { bubbles: true })
    Object.defineProperty(e, 'key', { value: undefined })
    document.dispatchEvent(e)
  })
  await page.keyboard.type('rrr')
  expect(errors).toEqual([])
  expect(await activations(page)).toEqual(['element'])
})
