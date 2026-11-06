import { test, expect } from '@playwright/test'
import { buildFixture, openAdmin, events, makeItem, API } from './admin-ui'

const NOW = new Date('2026-11-03T12:00:00.000Z')
test.beforeAll(buildFixture)

const item = makeItem()
const ID = item.id

test('shows feedback, page link without the query, selector, element text, tester, version, user agent and "Deletes in 12 days"', async ({ page }) => {
  await page.clock.setFixedTime(NOW)
  await openAdmin(page, { view: 'detail', id: ID, items: [item] })
  await expect(page.getByText('The search button is too small to tap.')).toBeVisible()
  const link = page.getByRole('link', { name: /\/clients/ })
  await expect(link).toHaveAttribute('href', '/clients')
  await expect(page.getByText('main > form#search > button.primary')).toBeVisible()
  await expect(page.getByText('Search clients')).toBeVisible()
  await expect(page.getByText('Dana Tester')).toBeVisible()
  await expect(page.getByText('1.4.2')).toBeVisible()
  await expect(page.getByText('TestAgent', { exact: false })).toBeVisible()
  await expect(page.getByText('Deletes in 12 days')).toBeVisible()
})

test('missing tester, version, user agent and element text never render "null"', async ({ page }) => {
  await openAdmin(page, {
    view: 'detail', id: ID,
    items: [makeItem({ tester_id: null, tester_label: null, app_version: null, user_agent: null, element_text: null })],
  })
  await expect(page.getByText('The search button is too small to tap.')).toBeVisible()
  expect(await page.locator('body').innerText()).not.toMatch(/null/i)
})

test('screenshot opens in an in-page viewer and closes with Escape', async ({ page }) => {
  await openAdmin(page, { view: 'detail', id: ID, items: [item] })
  await page.getByRole('button', { name: /screenshot/i }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('an item sent without a screenshot says "No screenshot", not that one was lost', async ({ page }) => {
  await openAdmin(page, { view: 'detail', id: ID, items: [makeItem({ screenshot_path: null })] })
  await expect(page.getByText('No screenshot')).toBeVisible()
  await expect(page.getByText('Screenshot no longer available')).toHaveCount(0)
})

test('expired screenshot refetches once, then gives up', async ({ page }) => {
  const { calls } = await openAdmin(page, { view: 'detail', id: ID, items: [item], failImages: true })
  await expect(page.getByText('Screenshot no longer available')).toBeVisible()
  await page.waitForTimeout(300)
  const gets = calls.filter((c) => c.method === 'GET' && c.url === `${API}/${ID}`)
  expect(gets).toHaveLength(2)
})

test('each action PATCHes its status with expected_status_updated_at', async ({ page }) => {
  const { calls } = await openAdmin(page, { view: 'detail', id: ID, items: [item] })
  await expect(page.getByRole('button', { name: 'Move to To Fix' })).toHaveCount(0)

  for (const [label, status] of [['Mark fixed', 'fixed'], ['Defer', 'deferred'], ['Dismiss', 'dismissed']] as const) {
    const before = calls.filter((c) => c.method === 'PATCH').length
    await page.getByRole('button', { name: label }).click()
    await expect.poll(() => calls.filter((c) => c.method === 'PATCH').length).toBe(before + 1)
    const patch = calls.filter((c) => c.method === 'PATCH').at(-1)!
    expect(patch.body.status).toBe(status)
    expect(typeof patch.body.expected_status_updated_at).toBe('string')
    await expect(page.getByRole('button', { name: 'Move to To Fix' })).toBeVisible()
    // Move back to To Fix so the next action is available again, with the fresh token
    await page.getByRole('button', { name: 'Move to To Fix' }).click()
    await expect.poll(() => calls.filter((c) => c.method === 'PATCH').length).toBe(before + 2)
    expect(calls.filter((c) => c.method === 'PATCH').at(-1)!.body.status).toBe('open')
    await expect(page.getByRole('button', { name: 'Move to To Fix' })).toHaveCount(0)
  }

  const patches = calls.filter((c) => c.method === 'PATCH')
  expect(patches[0].body.expected_status_updated_at).toBe('opaque-ts-1')
  // The second PATCH sends back the token the server returned for the first, verbatim
  expect(patches[1].body.expected_status_updated_at).toMatch(/^opaque-\d+-/)

  const ev = await events(page)
  const changed = ev.filter((e) => e.type === 'statusChanged')
  expect(changed[0].payload.item.status).toBe('fixed')
  expect(changed[0].payload.previous.status).toBe('open')
})

test('a To Review item offers exactly Move to To Fix, Defer and Dismiss; Move to To Fix PATCHes open', async ({ page }) => {
  const { calls } = await openAdmin(page, { view: 'detail', id: ID, items: [makeItem({ status: 'review' })] })
  await expect(page.getByTestId('status')).toHaveText(/To Review/)
  const buttons = page.getByRole('button', { name: /^(Move to To Fix|Defer|Dismiss|Mark fixed|Reopen)$/ })
  await expect(buttons).toHaveText(['Move to To Fix', 'Defer', 'Dismiss'])
  await page.getByRole('button', { name: 'Move to To Fix' }).click()
  await expect.poll(() => calls.filter((c) => c.method === 'PATCH').length).toBe(1)
  expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ status: 'open', expected_status_updated_at: 'opaque-ts-1' })
  await expect(page.getByTestId('status')).toHaveText(/To Fix/)
  await expect(page.getByRole('button', { name: 'Mark fixed' })).toBeVisible()
})

test('actions are at least 44px tall', async ({ page }) => {
  await openAdmin(page, { view: 'detail', id: ID, items: [makeItem({ status: 'deferred' })] })
  for (const name of ['Mark fixed', 'Dismiss', 'Move to To Fix']) {
    const box = await page.getByRole('button', { name }).boundingBox()
    expect(box!.height, name).toBeGreaterThanOrEqual(44)
  }
})

test('a deferred item offers exactly Mark fixed, Dismiss and Move to To Fix', async ({ page }) => {
  await openAdmin(page, { view: 'detail', id: ID, items: [makeItem({ status: 'deferred' })] })
  const buttons = page.getByRole('button', { name: /^(Move to To Fix|Defer|Dismiss|Mark fixed|Reopen)$/ })
  await expect(buttons).toHaveText(['Mark fixed', 'Dismiss', 'Move to To Fix'])
})

test('409 shows "Changed elsewhere. Showing the latest." and renders the current status', async ({ page }) => {
  await openAdmin(page, { view: 'detail', id: ID, items: [item], conflictWith: { status: 'dismissed' } })
  await page.getByRole('button', { name: 'Mark fixed' }).click()
  await expect(page.getByText('Changed elsewhere. Showing the latest.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Move to To Fix' })).toBeVisible()
  await expect(page.getByTestId('status')).toHaveText(/dismissed/i)
  expect((await events(page)).filter((e) => e.type === 'statusChanged')).toHaveLength(0)
  const refreshed = (await events(page)).filter((e) => e.type === 'refreshed')
  expect(refreshed).toHaveLength(1)
  expect(refreshed[0].payload.latest.status).toBe('dismissed')
  expect(refreshed[0].payload.previous.status).toBe('open')
  expect(refreshed[0].payload.previous).not.toHaveProperty('screenshot_url')
})

test('a purged item shows the gone message', async ({ page }) => {
  await openAdmin(page, { view: 'detail', id: 'missing', items: [] })
  await expect(page.getByText('This feedback is no longer available.')).toBeVisible()
  expect((await events(page)).filter((e) => e.type === 'gone').map((e) => e.payload)).toEqual(['missing'])
})

test('a 404 on PATCH shows the gone message and calls onGone', async ({ page }) => {
  await openAdmin(page, { view: 'detail', id: ID, items: [item], purgeOnPatch: true })
  await page.getByRole('button', { name: 'Defer' }).click()
  await expect(page.getByText('This feedback is no longer available.')).toBeVisible()
  expect((await events(page)).filter((e) => e.type === 'gone').map((e) => e.payload)).toEqual([ID])
})

test('Back shows only below 1024px', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 })
  await openAdmin(page, { view: 'detail', id: ID, items: [item] })
  const back = page.getByRole('button', { name: 'Back' })
  await expect(back).toBeVisible()
  expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await back.click()
  expect((await events(page)).some((e) => e.type === 'back')).toBe(true)
  await page.setViewportSize({ width: 1280, height: 900 })
  await expect(back).toBeHidden()
})

test('unsafe or protocol-relative page_url renders as text, never a link', async ({ page }) => {
  for (const bad of ['javascript:alert(1)', '//evil.example/x', '/\\evil.example']) {
    await openAdmin(page, { view: 'detail', id: ID, items: [makeItem({ page_url: bad })] })
    await expect(page.getByText(bad, { exact: true })).toBeVisible()
    await expect(page.locator('a[href]')).toHaveCount(0)
  }
})

test('a PATCH that resolves after switching items is still reported', async ({ page }) => {
  const other = makeItem({ id: '22222222-2222-4222-8222-222222222222', feedback: 'Second item' })
  await openAdmin(page, { view: 'detail', id: ID, items: [item, other], patchDelayMs: 400 })
  await page.getByRole('button', { name: 'Mark fixed' }).click()
  await page.evaluate((id) => (window as any).__setId(id), other.id)
  await expect(page.getByText('Second item')).toBeVisible()
  // The new item's actions are usable while the old PATCH is in flight
  await expect(page.getByRole('button', { name: 'Mark fixed' })).toBeEnabled()
  await expect.poll(async () => (await events(page)).filter((e) => e.type === 'statusChanged').length).toBe(1)
  const ev = (await events(page)).find((e) => e.type === 'statusChanged')!
  expect(ev.payload.item.id).toBe(ID)
  expect(ev.payload.item.status).toBe('fixed')
  expect(ev.payload.previous.status).toBe('open')
  // The late result must not repaint the item now on screen
  await expect(page.getByText('Second item')).toBeVisible()
  await expect(page.getByTestId('status')).toHaveText(/To Fix/)
})

test('viewer: focus moves in, Tab stays inside, Escape returns focus to the thumbnail', async ({ page }) => {
  await openAdmin(page, { view: 'detail', id: ID, items: [item] })
  const thumb = page.getByRole('button', { name: 'Open screenshot' })
  await thumb.click()
  const dialog = page.getByRole('dialog')
  const close = page.getByRole('button', { name: 'Close screenshot' })
  await expect(close).toBeFocused()
  for (const key of ['Tab', 'Tab', 'Shift+Tab']) {
    await page.keyboard.press(key)
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(thumb).toBeFocused()
})

test('viewer closes from the close button and from a backdrop click', async ({ page }) => {
  await openAdmin(page, { view: 'detail', id: ID, items: [item] })
  const dialog = page.getByRole('dialog')
  await page.getByRole('button', { name: 'Open screenshot' }).click()
  await page.getByRole('button', { name: 'Close screenshot' }).click()
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: 'Open screenshot' }).click()
  await dialog.click({ position: { x: 5, y: 300 } })
  await expect(dialog).toBeHidden()
})

test('no horizontal scroll at 390px with very long content', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 })
  const long = (n: number, ch = 'a') => ch.repeat(n)
  await openAdmin(page, {
    view: 'detail', id: ID,
    items: [makeItem({
      feedback: long(2000),
      page_url: '/' + long(299),
      element_text: long(400),
      element_selector: long(300),
      user_agent: long(300),
      app_version: long(80),
      tester_label: long(120),
    })],
  })
  await expect(page.getByTestId('status')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})
