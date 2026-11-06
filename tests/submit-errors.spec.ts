// What the feedback box says when a save is refused. Each message says what to do,
// and only says "try again" when trying again can work.

import { test, expect, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { fileURLToPath } from 'url'

const ORIGIN = 'http://redline.test'
let bundle = ''
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./fixture/app.tsx', import.meta.url))],
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  })
  bundle = result.outputFiles[0].text
})

async function openWith(page: Page, status: number, body: unknown, raw?: string) {
  await page.route(`${ORIGIN}/**`, (route) => {
    if (route.request().url().includes('/api/redlines')) {
      return raw === undefined
        ? route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
        : route.fulfill({ status, contentType: 'text/plain', body: raw })
    }
    return route.fulfill({
      status: 200, contentType: 'text/html',
      body: `<!doctype html><html><body style="margin:0"><div id="card" style="margin:80px;padding:24px;background:#ddd">Card</div><div id="redline-root"></div><script>window.__REDLINE_PROPS__={}</script><script>${bundle}</script></body></html>`,
    })
  })
  await page.goto(ORIGIN + '/x')
  const box = (await page.locator('#card').boundingBox())!
  const captured = page.waitForEvent('console', (m) => m.text().includes('screenshot captured'))
  await page.mouse.click(box.x + 6, box.y + 6)
  await captured
}

async function send(page: Page, withScreenshot = false) {
  if (withScreenshot) await page.getByLabel('Include Screenshot').check()
  await page.getByPlaceholder("What's wrong? What should change?").fill('Card looks off')
  await page.getByRole('button', { name: 'Submit' }).click()
}

test('413 on the note says it is too long', async ({ page }) => {
  await openWith(page, 413, { error: 'too_large', field: 'feedback' })
  await send(page)
  await expect(page.getByText('That note is too long. Shorten it and try again.')).toBeVisible()
})

test('413 with a screenshot attached says to untick it', async ({ page }) => {
  await openWith(page, 413, { error: 'too_large', field: 'screenshot' })
  await send(page, true)
  await expect(page.getByText('Too large to send. Untick Include Screenshot and try again.')).toBeVisible()
})

test('413 from a host that sends no JSON still gets a useful message', async ({ page }) => {
  await openWith(page, 413, null, 'Payload Too Large')
  await send(page)
  await expect(page.getByText('Too large to send. Shorten the note and try again.')).toBeVisible()
})

test('429 says to wait, not to retry now', async ({ page }) => {
  await openWith(page, 429, { error: 'rate_limited' })
  await send(page)
  await expect(page.getByText('Too many notes in a row. Wait a few minutes, then send it again.')).toBeVisible()
})

test('a server error keeps the retry message', async ({ page }) => {
  await openWith(page, 500, { error: 'Could not save redline' })
  await send(page)
  await expect(page.getByText("Couldn't save the feedback (500). Try again.")).toBeVisible()
})

test('the note box stops at 5000 characters', async ({ page }) => {
  await openWith(page, 201, {})
  const box = page.getByPlaceholder("What's wrong? What should change?")
  await expect(box).toHaveAttribute('maxlength', '5000')
})
