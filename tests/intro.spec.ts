// The first-run introduction, driven through the real component in a real browser.

import { test, expect, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { fileURLToPath } from 'url'

const ORIGIN = 'http://redline.test'

let bundle = ''
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./fixture/intro.tsx', import.meta.url))],
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  })
  bundle = result.outputFiles[0].text
})

interface Props { audience?: 'tester' | 'developer'; touch?: boolean; shortcuts?: boolean }

async function load(page: Page, props: Props = {}) {
  const full = { audience: 'tester', touch: false, shortcuts: true, ...props }
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="root"></div><script>window.__INTRO_PROPS__ = ${JSON.stringify(full)}</script><script>${bundle}</script></body></html>`,
    }),
  )
  await page.goto(`${ORIGIN}/`)
  await page.waitForSelector('[role="dialog"]')
}

const dialog = (page: Page) => page.getByRole('dialog')
const title = (page: Page) => dialog(page).locator('h2').filter({ visible: true })
const next = (page: Page) => dialog(page).getByRole('button', { name: /^(Next|Start)$/ })
const back = (page: Page) => dialog(page).getByRole('button', { name: 'Back' })
const closed = (page: Page) => page.evaluate(() => (window as any).__introClosed ?? 0)
const dismissed = (page: Page) => page.evaluate(() => (window as any).__introDismissed() as boolean)

test('desktop shows three pages in order, and Start closes', async ({ page }) => {
  await load(page)
  await expect(dialog(page)).toHaveAttribute('aria-modal', 'true')
  await expect(dialog(page)).toHaveAccessibleName('Point at what you mean')
  await expect(title(page)).toHaveText('Point at what you mean')
  await expect(dialog(page).getByText('Pick one thing on the page, or a whole region.')).toBeVisible()
  await expect(dialog(page).getByText('Element. Hover, then click.')).toBeVisible()
  await expect(dialog(page).getByText('Area. Drag a box.')).toBeVisible()
  await expect(dialog(page).getByText('Press S to switch between them.')).toBeVisible()
  await expect(back(page)).toBeHidden()
  await expect(next(page)).toHaveText('Next')

  await next(page).click()
  await expect(title(page)).toHaveText("Say what's wrong")
  await expect(dialog(page)).toHaveAccessibleName("Say what's wrong")
  await expect(dialog(page).getByText(/^(⌘|Ctrl) Enter sends\. Esc backs out\.$/)).toBeVisible()
  await expect(back(page)).toBeVisible()
  await expect(next(page)).toHaveText('Next')

  await back(page).click()
  await expect(title(page)).toHaveText('Point at what you mean')
  await next(page).click()
  await next(page).click()
  await expect(title(page)).toHaveText('Next time, use the keyboard')
  await expect(dialog(page).getByText('Tap a letter three times quickly, anywhere outside a text field.')).toBeVisible()
  await expect(dialog(page).getByText('R R R', { exact: true })).toBeVisible()
  await expect(dialog(page).getByText('Pick an element (or U U U with your left hand)')).toBeVisible()
  await expect(dialog(page).getByText('E E E', { exact: true })).toBeVisible()
  await expect(dialog(page).getByText('Drag an area')).toBeVisible()
  await expect(dialog(page).getByText('Turn Redline off')).toBeVisible()
  await expect(next(page)).toHaveText('Start')

  expect(await closed(page)).toBe(0)
  await next(page).click()
  expect(await closed(page)).toBe(1)
})

test('tester and developer wording differ where the spec says', async ({ page }) => {
  const privacy = "Don't type client names or details. Anything private on screen is blacked out before it's sent."
  await load(page, { audience: 'tester' })
  await next(page).click()
  await expect(dialog(page).getByText('A box opens with a screenshot attached. Write what you expected to see.')).toBeVisible()
  await expect(dialog(page).getByText(privacy)).toBeVisible()
  await expect(dialog(page).getByText(/Tick Include Screenshot/)).toHaveCount(0)
  await next(page).click()
  await expect(dialog(page).getByText('Every note goes to the team, who read each one.')).toBeVisible()
  await expect(dialog(page).getByText(/redline fix/)).toHaveCount(0)

  await page.unrouteAll()
  await load(page, { audience: 'developer' })
  await next(page).click()
  await expect(dialog(page).getByText('A box opens for your note. Tick Include Screenshot to attach what you picked.')).toBeVisible()
  await expect(dialog(page).getByText(privacy)).toHaveCount(0)
  await expect(dialog(page).getByText(/screenshot attached/)).toHaveCount(0)
  await next(page).click()
  await expect(dialog(page).getByText('Then run /redline fix in Claude Code and it works through them.')).toBeVisible()
  await expect(dialog(page).getByText(/Every note goes to the team/)).toHaveCount(0)
})

test('shortcuts false skips the keyboard page', async ({ page }) => {
  await load(page, { shortcuts: false })
  await next(page).click()
  await expect(title(page)).toHaveText("Say what's wrong")
  await expect(next(page)).toHaveText('Start')
  await next(page).click()
  expect(await closed(page)).toBe(1)
})

test('touch shows two pages and no keyboard hints', async ({ page }) => {
  await load(page, { touch: true, audience: 'tester' })
  await expect(title(page)).toHaveText('Point at what you mean')
  await expect(dialog(page).getByText('Tap one thing on the page, or draw a box around a region.')).toBeVisible()
  await expect(dialog(page).getByText('Element. Tap it, then Bigger for the whole thing.')).toBeVisible()
  await expect(dialog(page).getByText('Area. Switch to Area, then drag a box.')).toBeVisible()
  await expect(dialog(page)).not.toContainText(/Enter|Esc|S to switch|R R R/)

  await next(page).click()
  await expect(title(page)).toHaveText("Say what's wrong")
  await expect(dialog(page).getByText('A box opens with a screenshot attached. Write what you expected to see.')).toBeVisible()
  await expect(dialog(page).getByText(/Don't type client names/)).toBeVisible()
  await expect(dialog(page)).not.toContainText(/Enter|Esc|S to switch|R R R/)
  await expect(next(page)).toHaveText('Start')
})

test("Don't show this again persists only when ticked", async ({ page }) => {
  await load(page)
  await dialog(page).getByRole('button', { name: 'Close' }).click()
  expect(await closed(page)).toBe(1)
  expect(await dismissed(page)).toBe(false)

  await dialog(page).getByLabel("Don't show this again").check()
  await dialog(page).getByRole('button', { name: 'Close' }).click()
  expect(await closed(page)).toBe(2)
  expect(await page.evaluate(() => localStorage.getItem('redline:intro:v1'))).toBe('1')
  expect(await dismissed(page)).toBe(true)
})

test('blocked storage still opens and closes', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('blocked', 'SecurityError') },
    })
  })
  await load(page)
  await expect(title(page)).toHaveText('Point at what you mean')
  expect(await dismissed(page)).toBe(false)
  await dialog(page).getByLabel("Don't show this again").check()
  await next(page).click()
  await next(page).click()
  await next(page).click()
  expect(await closed(page)).toBe(1)
  expect(await dismissed(page)).toBe(false)
})

test('Esc closes and does not bubble', async ({ page }) => {
  await load(page)
  await page.evaluate(() => {
    const w = window as any
    w.__escSeen = 0
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') w.__escSeen++ })
  })
  // Clicking plain text inside the dialog must not drop focus out of it
  await dialog(page).getByText('Pick one thing on the page, or a whole region.').click()
  await page.keyboard.press('Escape')
  expect(await closed(page)).toBe(1)
  expect(await page.evaluate(() => (window as any).__escSeen)).toBe(0)
})

test('focus stays inside the dialog', async ({ page }) => {
  await load(page)
  // The primary button, not ×: a ring on × reads as a highlighted close
  await expect(next(page)).toBeFocused()
  const inside = () => page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Tab')
    expect(await inside()).toBe(true)
  }
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Shift+Tab')
    expect(await inside()).toBe(true)
  }
  // Back disappears on page 1; focus must not fall out with it
  await next(page).click()
  await back(page).click()
  expect(await inside()).toBe(true)
})

test('reduced motion: nothing animates', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await load(page)
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
  await expect(dialog(page).getByText('Element. Hover, then click.')).toBeVisible()
  await expect(dialog(page).getByText('Area. Drag a box.')).toBeVisible()

  await page.unrouteAll()
  await load(page, { touch: true })
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
  await expect(dialog(page).getByText('Element. Tap it, then Bigger for the whole thing.')).toBeVisible()
  await expect(dialog(page).getByText('Area. Switch to Area, then drag a box.')).toBeVisible()
})

test('animates when motion is allowed', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await load(page)
  expect(await page.evaluate(() => document.getAnimations().length)).toBeGreaterThan(0)
})

test('fits a 390px screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  for (const props of [{ touch: true }, { touch: false }] as Props[]) {
    await page.unrouteAll()
    await load(page, props)
    const pages = props.touch ? 2 : 3
    for (let p = 0; p < pages; p++) {
      const box = (await dialog(page).boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(390)
      expect(box.y + box.height).toBeLessThanOrEqual(844)
      const overflow = await dialog(page).evaluate((el) => el.scrollWidth - el.clientWidth)
      expect(overflow).toBeLessThanOrEqual(0)
      if (p < pages - 1) await next(page).click()
    }
  }
})

test('desktop: Next stays under the pointer from page to page', async ({ page }) => {
  for (const props of [{ audience: 'tester' }, { audience: 'developer' }, { shortcuts: false }] as Props[]) {
    await page.unrouteAll()
    await load(page, props)
    const first = (await next(page).boundingBox())!
    const pages = props.shortcuts === false ? 2 : 3
    for (let p = 1; p < pages; p++) {
      await next(page).click()
      expect(await next(page).boundingBox()).toEqual(first)
    }
  }
})
