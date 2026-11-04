import { test, expect, type Page } from '@playwright/test'
import { buildFixture, openAdmin, makeItem, type OpenAdminOpts } from './admin-ui'
import type { AdminItem } from '../component/redline-admin-types'

const NOW = new Date('2026-11-03T12:00:00.000Z')
test.beforeAll(buildFixture)

/** n = 1 is the newest. Ids are valid UUIDs; feedback is "Feedback n". */
function mk(n: number, over: Partial<AdminItem> = {}): AdminItem {
  return makeItem({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    feedback: `Feedback ${n}`,
    created_at: new Date(NOW.getTime() - n * 60_000).toISOString(),
    status_updated_at: `ts-${n}`,
    ...over,
  })
}

const list = (page: Page) => page.getByTestId('list-pane')
const detail = (page: Page) => page.getByTestId('detail-pane')
const tab = (page: Page, name: string) => page.getByRole('tab', { name: new RegExp(`^${name}\\b`) })
const rows = (page: Page) => list(page).getByRole('button', { name: /Feedback|xxxx/ })

test('opens on Open with counts on every tab', async ({ page }) => {
  await openAdmin(page, {
    view: 'inbox',
    items: [mk(1), mk(2), mk(3, { status: 'fixed' }), mk(4, { status: 'dismissed' }), mk(5, { status: 'deferred' }), mk(6, { status: 'deferred' })],
  })
  await expect(tab(page, 'Open')).toHaveAttribute('aria-selected', 'true')
  await expect(tab(page, 'Open')).toHaveText(/Open\s*2/)
  await expect(tab(page, 'Deferred')).toHaveText(/Deferred\s*2/)
  await expect(tab(page, 'Fixed')).toHaveText(/Fixed\s*1/)
  await expect(tab(page, 'Dismissed')).toHaveText(/Dismissed\s*1/)
  await expect(tab(page, 'All')).toHaveText(/All\s*6/)
  await expect(list(page).getByText('Feedback 1')).toBeVisible()
  await expect(list(page).getByText('Feedback 3')).toHaveCount(0)
  await tab(page, 'Fixed').click()
  await expect(list(page).getByText('Feedback 3')).toBeVisible()
  await expect(list(page).getByText('Feedback 1')).toHaveCount(0)
  expect(page.url()).toContain('status=fixed')
  await tab(page, 'All').click()
  await expect(rows(page)).toHaveCount(6)
  expect(page.url()).toContain('status=all')
})

test('tester and version filters narrow the list and land in the URL', async ({ page }) => {
  const { calls } = await openAdmin(page, {
    view: 'inbox',
    items: [
      mk(1, { tester_id: 't1', tester_label: 'Dana', app_version: '1.0.0' }),
      mk(2, { tester_id: 't2', tester_label: 'Lee', app_version: '1.0.0' }),
      mk(3, { tester_id: 't2', tester_label: 'Lee', app_version: '2.0.0' }),
    ],
  })
  await expect(rows(page)).toHaveCount(3)
  await page.getByLabel('Tester').selectOption('t2')
  await expect(rows(page)).toHaveCount(2)
  expect(page.url()).toContain('tester=t2')
  await page.getByLabel('Version').selectOption('2.0.0')
  await expect(rows(page)).toHaveCount(1)
  await expect(list(page).getByText('Feedback 3')).toBeVisible()
  expect(page.url()).toContain('version=2.0.0')
  expect(calls.at(-1)!.url).toContain('tester=t2')
  // A reload restores the filters from the URL
  await page.reload()
  await expect(page.getByLabel('Tester')).toHaveValue('t2')
  await expect(page.getByLabel('Version')).toHaveValue('2.0.0')
  await expect(rows(page)).toHaveCount(1)
})

test('Load more fetches the next cursor page and appends it', async ({ page }) => {
  const items = Array.from({ length: 60 }, (_, i) => mk(i + 1))
  const { calls } = await openAdmin(page, { view: 'inbox', items })
  await expect(rows(page)).toHaveCount(50)
  await page.getByRole('button', { name: 'Load more' }).click()
  await expect(rows(page)).toHaveCount(60)
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0)
  expect(calls.filter((c) => c.url.includes('cursor=50'))).toHaveLength(1)
})

test("rows show the feedback's first lines, page, tester, version, relative time, a screenshot icon and a UX review badge", async ({ page }) => {
  await page.clock.setFixedTime(NOW)
  await openAdmin(page, {
    view: 'inbox',
    items: [makeItem({ feedback: 'First line\nSecond line', created_at: '2026-11-01T12:00:00.000Z', ux_review_requested: true })],
  })
  const row = list(page).getByRole('button', { name: /First line/ })
  await expect(row).toContainText('Second line')
  await expect(row).toContainText('/clients')
  await expect(row).toContainText('Dana Tester')
  await expect(row).toContainText('1.4.2')
  await expect(row).toContainText('2 days ago')
  await expect(row).toContainText('UX review')
  await expect(row.getByLabel('Has screenshot')).toBeVisible()
})

test('side by side at 1024+', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openAdmin(page, { view: 'inbox', items: [mk(1), mk(2)] })
  await list(page).getByRole('button', { name: /Feedback 1/ }).click()
  await expect(detail(page).getByRole('button', { name: 'Mark fixed' })).toBeVisible()
  const l = (await list(page).boundingBox())!
  const d = (await detail(page).boundingBox())!
  expect(d.x).toBeGreaterThan(l.x + l.width - 1)
  await expect(list(page)).toBeVisible()
})

test('?id= opens that item directly (390), and browser Back returns to the list', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 })
  const a = mk(1)
  await openAdmin(page, { view: 'inbox', items: [a, mk(2)], id: a.id })
  await expect(detail(page).getByText('Feedback 1')).toBeVisible()
  await expect(list(page)).toBeHidden()
  // The in-app Back control
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(list(page)).toBeVisible()
  await expect(detail(page)).toBeHidden()
  expect(page.url()).not.toContain('id=')
  // Opening a row pushes history, so the browser's Back returns to the list
  await list(page).getByRole('button', { name: /Feedback 2/ }).click()
  await expect(list(page)).toBeHidden()
  expect(page.url()).toContain('id=00000000-0000-4000-8000-000000000002')
  await page.goBack()
  await expect(list(page)).toBeVisible()
  expect(page.url()).not.toContain('id=')
  await page.goForward()
  await expect(detail(page).getByText('Feedback 2')).toBeVisible()
})

test('empty states follow the tab', async ({ page }) => {
  await openAdmin(page, { view: 'inbox', items: [] })
  await expect(page.getByText('No open feedback. New submissions from testers show up here.')).toBeVisible()
  await tab(page, 'Deferred').click()
  await expect(page.getByText('No deferred feedback.')).toBeVisible()
  await tab(page, 'All').click()
  await expect(page.getByText('No feedback yet.')).toBeVisible()
})

test('failed load shows Retry, which recovers', async ({ page }) => {
  await openAdmin(page, { view: 'inbox', items: [mk(1)], failList: true })
  await expect(page.getByRole('alert')).toContainText('Could not load')
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(list(page).getByText('Feedback 1')).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('loading shows skeleton rows', async ({ page }) => {
  await openAdmin(page, { view: 'inbox', items: [mk(1)], delayMs: 500 })
  await expect(page.locator('[data-skeleton]').first()).toBeVisible()
  await expect(list(page).getByText('Feedback 1')).toBeVisible()
  await expect(page.locator('[data-skeleton]')).toHaveCount(0)
})

async function markFixedFirst(page: Page, extra: Partial<OpenAdminOpts> = {}) {
  const r = await openAdmin(page, {
    view: 'inbox',
    items: [mk(1), mk(2), mk(3), mk(4, { status: 'fixed' })],
    ...extra,
  })
  await list(page).getByRole('button', { name: /Feedback 1/ }).click()
  await expect(detail(page).getByText('Feedback 1')).toBeVisible()
  await detail(page).getByRole('button', { name: 'Mark fixed' }).click()
  return r
}

test('Mark fixed moves the item out of Open, selects the next one and shows "Marked fixed · Undo"', async ({ page }) => {
  await markFixedFirst(page)
  await expect(list(page).getByText('Feedback 1')).toHaveCount(0)
  await expect(detail(page).getByText('Feedback 2')).toBeVisible()
  const bar = page.getByTestId('undo-bar')
  await expect(bar).toHaveText('Marked fixed · Undo')
  await expect(bar.getByRole('button', { name: 'Undo' })).toBeVisible()
})

test('selecting the last row falls back to the previous one', async ({ page }) => {
  await openAdmin(page, { view: 'inbox', items: [mk(1), mk(2)] })
  await list(page).getByRole('button', { name: /Feedback 2/ }).click()
  await detail(page).getByRole('button', { name: 'Dismiss' }).click()
  await expect(detail(page).getByText('Feedback 1')).toBeVisible()
  await expect(page.getByTestId('undo-bar')).toHaveText('Marked dismissed · Undo')
})

test('Undo uses the timestamp from the first PATCH', async ({ page }) => {
  const { calls, store } = await markFixedFirst(page)
  await expect(page.getByTestId('undo-bar')).toBeVisible()
  const firstTs = store.get(mk(1).id)!.status_updated_at
  expect(firstTs).toMatch(/^opaque-/)
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect.poll(() => calls.filter((c) => c.method === 'PATCH').length).toBe(2)
  const [first, second] = calls.filter((c) => c.method === 'PATCH')
  expect(first.body).toEqual({ status: 'fixed', expected_status_updated_at: 'ts-1' })
  expect(second.body).toEqual({ status: 'open', expected_status_updated_at: firstTs })
  await expect(list(page).getByRole('button', { name: /Feedback 1/ })).toBeVisible()
  await expect(tab(page, 'Open')).toHaveText(/Open\s*3/)
  await expect(page.getByTestId('undo-bar')).toHaveCount(0)
  expect(store.get(mk(1).id)!.status).toBe('open')
})

test('Undo disappears after 5 seconds', async ({ page }) => {
  await page.clock.install({ time: NOW })
  await markFixedFirst(page)
  await expect(page.getByTestId('undo-bar')).toBeVisible()
  await page.clock.runFor(4900)
  await expect(page.getByTestId('undo-bar')).toBeVisible()
  await page.clock.runFor(200)
  await expect(page.getByTestId('undo-bar')).toHaveCount(0)
})

test('counts update after a status change', async ({ page }) => {
  await markFixedFirst(page)
  await expect(tab(page, 'Open')).toHaveText(/Open\s*2/)
  await expect(tab(page, 'Fixed')).toHaveText(/Fixed\s*2/)
  await expect(tab(page, 'All')).toHaveText(/All\s*4/)
})

test('in All the row stays and updates in place', async ({ page }) => {
  await openAdmin(page, { view: 'inbox', items: [mk(1), mk(2)] })
  await tab(page, 'All').click()
  await list(page).getByRole('button', { name: /Feedback 1/ }).click()
  await detail(page).getByRole('button', { name: 'Mark fixed' }).click()
  await expect(page.getByTestId('undo-bar')).toBeVisible()
  await expect(list(page).getByRole('button', { name: /Feedback 1/ })).toContainText('fixed')
  await expect(rows(page)).toHaveCount(2)
})

test('a purged item disappears from the list', async ({ page }) => {
  await openAdmin(page, { view: 'inbox', items: [mk(1), mk(2)], purgeOnPatch: true })
  await list(page).getByRole('button', { name: /Feedback 1/ }).click()
  await detail(page).getByRole('button', { name: 'Defer' }).click()
  await expect(list(page).getByText('Feedback 1')).toHaveCount(0)
  await expect(tab(page, 'Open')).toHaveText(/Open\s*1/)
})

test('no horizontal scroll at 390 with extreme fields', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 })
  const extreme = mk(1, {
    feedback: 'x'.repeat(2000),
    page_url: '/' + 'a'.repeat(299),
    element_selector: 'div > ' + 'b'.repeat(300),
    tester_id: null, tester_label: null, app_version: null, user_agent: null, element_text: null,
  })
  await openAdmin(page, { view: 'inbox', items: [extreme, mk(2)] })
  await expect(list(page).getByRole('button', { name: /xxxx/ })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  expect(await page.locator('body').innerText()).not.toMatch(/null/i)
  await list(page).getByRole('button', { name: /xxxx/ }).click()
  await expect(detail(page).getByRole('button', { name: 'Mark fixed' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  expect(await page.locator('body').innerText()).not.toMatch(/null/i)
})

test('every button and row is at least 44px tall at 390', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 })
  const items = Array.from({ length: 55 }, (_, i) => mk(i + 1, { feedback: i === 0 ? 'Hi there' : `Feedback ${i + 1}` }))
  await openAdmin(page, { view: 'inbox', items })
  await expect(list(page).getByRole('button', { name: 'Load more' })).toBeVisible()
  const check = async (label: string) => {
    const small = await page.evaluate(() =>
      [...document.querySelectorAll('button, select, a[href], [role=tab]')]
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && r.height > 0 && r.height < 44)
        .map(({ el, r }) => `${el.tagName} "${(el.textContent ?? '').slice(0, 30)}" ${r.height}`))
    expect(small, label).toEqual([])
  }
  await check('list')
  await list(page).getByRole('button', { name: /Hi there/ }).click()
  await expect(detail(page).getByRole('button', { name: 'Mark fixed' })).toBeVisible()
  await check('detail')
})

// ---- Review fixes ----

test('?id=../../evil never requests outside the admin API and shows the list', async ({ page }) => {
  const urls: string[] = []
  page.on('request', (r) => { if (r.url().startsWith('http://redline.test')) urls.push(r.url()) })
  const { calls } = await openAdmin(page, { view: 'inbox', items: [mk(1)], search: '?id=../../evil' })
  await expect(list(page).getByText('Feedback 1')).toBeVisible()
  await page.waitForTimeout(200)
  const api = 'http://redline.test/api/redline-admin'
  for (const u of urls.filter((u) => !u.endsWith('/admin') && !u.includes('?id='))) {
    expect(u.startsWith(api), u).toBe(true)
  }
  expect(calls.every((c) => /\/api\/redline-admin(\?.*)?$/.test(c.url))).toBe(true)
  expect(page.url()).not.toContain('evil')
  // A well-formed id in a path-shaped value is still encoded, never traversed
  await openAdmin(page, { view: 'inbox', items: [mk(1)], search: '?id=00000000-0000-4000-8000-000000000001' })
  await expect(detail(page).getByText('Feedback 1')).toBeVisible()
})

test('Undo after switching tabs removes the row from the current tab and fixes counts', async ({ page }) => {
  await markFixedFirst(page)
  await expect(page.getByTestId('undo-bar')).toBeVisible()
  await tab(page, 'Fixed').click()
  await expect(list(page).getByRole('button', { name: /Feedback 1/ })).toBeVisible()
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByTestId('undo-bar')).toHaveCount(0)
  await expect(list(page).getByText('Feedback 1')).toHaveCount(0)
  await expect(list(page).getByRole('button', { name: /Feedback 4/ })).toBeVisible()
  await expect(tab(page, 'Open')).toHaveText(/Open\s*3/)
  await expect(tab(page, 'Fixed')).toHaveText(/Fixed\s*1/)
})

test('Undo never moves the selection or the URL id', async ({ page }) => {
  await markFixedFirst(page)
  await list(page).getByRole('button', { name: /Feedback 3/ }).click()
  await expect(detail(page).getByText('Feedback 3')).toBeVisible()
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByTestId('undo-bar')).toHaveCount(0)
  await expect(list(page).getByRole('button', { name: /Feedback 1/ })).toBeVisible()
  await expect(detail(page).getByText('Feedback 3')).toBeVisible()
  expect(page.url()).toContain('id=00000000-0000-4000-8000-000000000003')
})

test('a Load more in flight during a status change cannot reset counts or resurrect rows', async ({ page }) => {
  const items = Array.from({ length: 60 }, (_, i) => mk(i + 1))
  await openAdmin(page, { view: 'inbox', items, cursorDelayMs: 800 })
  await expect(rows(page)).toHaveCount(50)
  await page.getByRole('button', { name: 'Load more' }).click()
  await list(page).getByRole('button', { name: /Feedback 1\b/ }).first().click()
  await detail(page).getByRole('button', { name: 'Mark fixed' }).click()
  await expect(tab(page, 'Open')).toHaveText(/Open\s*59/)
  await page.waitForTimeout(1100)
  await expect(tab(page, 'Open')).toHaveText(/Open\s*59/)
  await expect(tab(page, 'Fixed')).toHaveText(/Fixed\s*1/)
  await expect(list(page).getByText('Feedback 1', { exact: true })).toHaveCount(0)
})

test('a resolving Undo never clears a newer Undo bar', async ({ page }) => {
  await openAdmin(page, { view: 'inbox', items: [mk(1), mk(2), mk(3)], patchDelays: [0, 900, 0] })
  await list(page).getByRole('button', { name: /Feedback 1/ }).click()
  await detail(page).getByRole('button', { name: 'Mark fixed' }).click()
  await expect(detail(page).getByText('Feedback 2')).toBeVisible()
  await page.getByRole('button', { name: 'Undo' }).click() // A's undo, slow
  await detail(page).getByRole('button', { name: 'Mark fixed' }).click() // B
  const bar = page.getByTestId('undo-bar')
  await expect(bar).toHaveText('Marked fixed · Undo')
  await page.waitForTimeout(1300) // A's undo resolves meanwhile
  await expect(list(page).getByRole('button', { name: /Feedback 1/ })).toBeVisible()
  await expect(bar).toHaveText('Marked fixed · Undo')
  await expect(bar.getByRole('button', { name: 'Undo' })).toBeEnabled()
})

test('focus: after Mark fixed it is not on body; mobile open and Back move focus', async ({ page }) => {
  await markFixedFirst(page)
  await expect(detail(page).getByText('Feedback 2')).toBeVisible()
  const inDetail = () => page.evaluate(() => document.activeElement !== document.body &&
    !!document.querySelector('[data-testid=detail-pane]')?.contains(document.activeElement))
  await expect.poll(inDetail).toBe(true)

  await page.setViewportSize({ width: 390, height: 800 })
  await page.goto('http://redline.test/admin')
  await expect(rows(page).first()).toBeVisible()
  await rows(page).first().click()
  await expect(list(page)).toBeHidden()
  await expect.poll(inDetail).toBe(true)
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(list(page)).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-row-id'))).toBe(
    // Feedback 1 was fixed above, so the first row opened is Feedback 2
    '00000000-0000-4000-8000-000000000002',
  )
})

// ---- Final review fixes ----

test('a 409 in the detail pane refreshes the list: the row leaves Open, counts update, no Undo bar', async ({ page }) => {
  await openAdmin(page, { view: 'inbox', items: [mk(1), mk(2), mk(3, { status: 'fixed' })], conflictWith: { status: 'fixed' } })
  await expect(tab(page, 'Open')).toHaveText(/Open\s*2/)
  await list(page).getByRole('button', { name: /Feedback 1/ }).click()
  await expect(detail(page).getByText('Feedback 1')).toBeVisible()
  await detail(page).getByRole('button', { name: 'Dismiss' }).click()
  await expect(detail(page).getByText('Changed elsewhere. Showing the latest.')).toBeVisible()
  await expect(list(page).getByText('Feedback 1')).toHaveCount(0)
  await expect(tab(page, 'Open')).toHaveText(/Open\s*1/)
  await expect(tab(page, 'Fixed')).toHaveText(/Fixed\s*2/)
  await expect(tab(page, 'All')).toHaveText(/All\s*3/)
  await expect(page.getByTestId('undo-bar')).toHaveCount(0)
  // The pane keeps showing the refreshed item so the notice is readable
  await expect(detail(page).getByText('Feedback 1')).toBeVisible()
})

test('a 409 in All updates the row badge in place', async ({ page }) => {
  await openAdmin(page, { view: 'inbox', items: [mk(1), mk(2)], conflictWith: { status: 'deferred' } })
  await tab(page, 'All').click()
  await list(page).getByRole('button', { name: /Feedback 1/ }).click()
  await detail(page).getByRole('button', { name: 'Mark fixed' }).click()
  await expect(detail(page).getByText('Changed elsewhere. Showing the latest.')).toBeVisible()
  await expect(list(page).getByRole('button', { name: /Feedback 1/ })).toContainText('deferred')
  await expect(tab(page, 'Deferred')).toHaveText(/Deferred\s*1/)
  await expect(page.getByTestId('undo-bar')).toHaveCount(0)
})

test('after Reopen the Undo bar reads "Reopened · Undo"', async ({ page }) => {
  await openAdmin(page, { view: 'inbox', items: [mk(1, { status: 'fixed' })], search: '?status=fixed' })
  await list(page).getByRole('button', { name: /Feedback 1/ }).click()
  await detail(page).getByRole('button', { name: 'Reopen' }).click()
  await expect(page.getByTestId('undo-bar')).toHaveText('Reopened · Undo')
})

test('below 1024px the list leaves room under Load more for the fixed Undo bar', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 })
  const items = Array.from({ length: 60 }, (_, i) => mk(i + 1, { status: i === 0 ? 'fixed' : 'open' }))
  await openAdmin(page, { view: 'inbox', items, search: '?status=all' })
  await list(page).getByRole('button', { name: /Feedback 1\b/ }).first().click()
  await detail(page).getByRole('button', { name: 'Reopen' }).click()
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByTestId('undo-bar')).toBeVisible()
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  const more = (await list(page).getByRole('button', { name: 'Load more' }).boundingBox())!
  const bar = (await page.getByTestId('undo-bar').boundingBox())!
  expect(more.y + more.height, 'Load more ends above the Undo bar').toBeLessThanOrEqual(bar.y)
})
