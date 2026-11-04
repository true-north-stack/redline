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

test('no screenshot_url shows "Screenshot no longer available"', async ({ page }) => {
  await openAdmin(page, { view: 'detail', id: ID, items: [makeItem({ screenshot_path: null })] })
  await expect(page.getByText('Screenshot no longer available')).toBeVisible()
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
  await expect(page.getByRole('button', { name: 'Reopen' })).toHaveCount(0)

  for (const [label, status] of [['Mark fixed', 'fixed'], ['Defer', 'deferred'], ['Dismiss', 'dismissed']] as const) {
    const before = calls.filter((c) => c.method === 'PATCH').length
    await page.getByRole('button', { name: label }).click()
    await expect.poll(() => calls.filter((c) => c.method === 'PATCH').length).toBe(before + 1)
    const patch = calls.filter((c) => c.method === 'PATCH').at(-1)!
    expect(patch.body.status).toBe(status)
    expect(typeof patch.body.expected_status_updated_at).toBe('string')
    await expect(page.getByRole('button', { name: 'Reopen' })).toBeVisible()
    // Reopen back to open so the next action is available again, with the fresh token
    await page.getByRole('button', { name: 'Reopen' }).click()
    await expect.poll(() => calls.filter((c) => c.method === 'PATCH').length).toBe(before + 2)
    expect(calls.filter((c) => c.method === 'PATCH').at(-1)!.body.status).toBe('open')
    await expect(page.getByRole('button', { name: 'Reopen' })).toHaveCount(0)
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

test('actions are at least 44px tall and Reopen appears for non-open items', async ({ page }) => {
  await openAdmin(page, { view: 'detail', id: ID, items: [makeItem({ status: 'deferred' })] })
  for (const name of ['Mark fixed', 'Dismiss', 'Reopen']) {
    const box = await page.getByRole('button', { name }).boundingBox()
    expect(box!.height, name).toBeGreaterThanOrEqual(44)
  }
})

test('409 shows "Changed elsewhere. Showing the latest." and renders the current status', async ({ page }) => {
  await openAdmin(page, { view: 'detail', id: ID, items: [item], conflictWith: { status: 'dismissed' } })
  await page.getByRole('button', { name: 'Mark fixed' }).click()
  await expect(page.getByText('Changed elsewhere. Showing the latest.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reopen' })).toBeVisible()
  await expect(page.getByTestId('status')).toHaveText(/dismissed/i)
  expect((await events(page)).filter((e) => e.type === 'statusChanged')).toHaveLength(0)
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
