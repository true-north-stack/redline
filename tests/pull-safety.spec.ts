// pull and push against a stand-in for the redline-sync function, so the rules that keep an
// owner's history safe run without the Supabase stack. Node only, no browser.

import { test, expect } from '@playwright/test'
import { createServer, type Server } from 'http'
import { mkdtemp, readFile, writeFile, mkdir, access } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFile } from 'child_process'
import { fileURLToPath } from 'url'

const CLI = fileURLToPath(new URL('../scripts/redline.mjs', import.meta.url))
const DAY = 86_400_000
const SECRET = 'sync-secret'

type Row = Record<string, unknown> & { id: string }

function row(overrides: Partial<Row> = {}): Row {
  const now = new Date()
  return {
    id: crypto.randomUUID(),
    page_url: '/jobs',
    element_selector: '#save',
    element_text: 'Save',
    feedback: 'Button is misaligned',
    screenshot_path: null,
    screenshot_url: null,
    status: 'open',
    status_updated_at: now.toISOString(),
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 30 * DAY).toISOString(),
    ...overrides,
  }
}

/** A stand-in inbox: lists `rows`, records status changes pushed to it. */
async function inbox(rows: Row[]) {
  const pushed: string[] = []
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.headers['x-redline-sync-secret'] !== SECRET) return res.writeHead(401).end()
      const msg = JSON.parse(body)
      res.setHeader('content-type', 'application/json')
      if (msg.action === 'list') return res.end(JSON.stringify({ items: rows }))
      if (msg.action === 'set_status') {
        pushed.push(msg.id)
        return res.end(JSON.stringify({ item: { status: msg.status, status_updated_at: new Date().toISOString() } }))
      }
      res.writeHead(400).end('{}')
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}`, pushed, rows, close: () => new Promise((done) => server.close(done)) }
}

function cli(root: string, args: string[], url: string): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    execFile('node', [CLI, ...args], {
      env: { ...process.env, REDLINE_ROOT: root, REDLINE_REMOTE_URL: url, REDLINE_SYNC_SECRET: SECRET },
      encoding: 'utf-8',
    }, (err, stdout, stderr) => done({ code: err ? (err.code as number) ?? 1 : 0, out: stdout + stderr }))
  })
}

async function project(items: Row[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'redline-pull-'))
  await mkdir(join(root, 'redline', 'screenshots'), { recursive: true })
  await writeFile(join(root, 'redline', 'feedback.json'), JSON.stringify(items))
  return root
}
const local = async (root: string): Promise<Row[]> => JSON.parse(await readFile(join(root, 'redline', 'feedback.json'), 'utf-8'))
const exists = (p: string) => access(p).then(() => true, () => false)

test('the first pull after adding a remote keeps every item created on this machine', async () => {
  const remote = await inbox([row()])
  try {
    // An owner's history: dated, undated (saved before 1.2.0), deferred, expired
    const { expires_at: _, ...undated } = row({ created_at: new Date(Date.now() - 400 * DAY).toISOString(), status: 'fixed' })
    const deferred = row({ status: 'deferred', created_at: new Date(Date.now() - 90 * DAY).toISOString(), expires_at: undefined })
    const expired = row({ status: 'dismissed', expires_at: new Date(Date.now() - DAY).toISOString(), screenshot_path: 'redline/screenshots/old.png' })
    const mine = [undated, deferred, expired].map(({ screenshot_url: _u, status_updated_at: _s, ...r }) => r as Row)
    const root = await project(mine)
    await writeFile(join(root, 'redline', 'screenshots', 'old.png'), 'x')

    const r = await cli(root, ['pull'], remote.url)
    expect(r.code).toBe(0)
    expect(r.out).not.toContain('Removed')
    const ids = (await local(root)).map((x) => x.id)
    expect(ids).toEqual(expect.arrayContaining(mine.map((x) => x.id)))
    expect(ids).toHaveLength(4) // plus the one pulled
    expect(await exists(join(root, 'redline', 'screenshots', 'old.png'))).toBe(true)
  } finally {
    await remote.close()
  }
})

test('items pulled from one remote are neither removed nor pushed when pulling from another', async () => {
  const staging = await inbox([row(), row()])
  const prod = await inbox([row()])
  try {
    const root = await project()
    expect((await cli(root, ['pull'], staging.url)).code).toBe(0)
    const fromStaging = (await local(root)).map((x) => x.id)
    expect(fromStaging).toHaveLength(2)

    // Change one locally, then point this machine at another project
    const items = await local(root)
    items[0].status = 'fixed'
    await writeFile(join(root, 'redline', 'feedback.json'), JSON.stringify(items))
    const r = await cli(root, ['pull'], prod.url)
    expect(r.code).toBe(0)
    expect(r.out).not.toContain('Removed')
    expect((await local(root)).map((x) => x.id)).toEqual(expect.arrayContaining([...fromStaging, prod.rows[0].id]))

    expect((await cli(root, ['push'], prod.url)).code).toBe(0)
    expect(prod.pushed).toEqual([])
    expect((await cli(root, ['push'], staging.url)).code).toBe(0)
    expect(staging.pushed).toEqual([fromStaging[0]])
  } finally {
    await staging.close()
    await prod.close()
  }
})

test('an empty inbox list keeps pulled items that have not expired, and says so', async () => {
  const remote = await inbox([row(), row()])
  try {
    const root = await project()
    expect((await cli(root, ['pull'], remote.url)).code).toBe(0)
    remote.rows.length = 0
    const r = await cli(root, ['pull'], remote.url)
    expect(r.code).toBe(0)
    expect(r.out).toContain('The inbox listed nothing to fix, so 2 pulled redlines were kept.')
    expect(await local(root)).toHaveLength(2)
  } finally {
    await remote.close()
  }
})

test('an empty inbox list still lets expired pulled items go', async () => {
  const remote = await inbox([row()])
  try {
    const root = await project()
    expect((await cli(root, ['pull'], remote.url)).code).toBe(0)
    const items = await local(root)
    items[0].expires_at = new Date(Date.now() - DAY).toISOString()
    await writeFile(join(root, 'redline', 'feedback.json'), JSON.stringify(items))
    remote.rows.length = 0
    const r = await cli(root, ['pull'], remote.url)
    expect(r.out).toContain('Removed 1 redline no longer here to fix')
    expect(r.out).not.toContain('kept')
    expect(await local(root)).toHaveLength(0)
  } finally {
    await remote.close()
  }
})

test('a pulled item missing from a non-empty list is removed', async () => {
  const remote = await inbox([row(), row()])
  try {
    const root = await project()
    expect((await cli(root, ['pull'], remote.url)).code).toBe(0)
    const gone = remote.rows.shift()!
    const r = await cli(root, ['pull'], remote.url)
    expect(r.out).toContain('Removed 1 redline no longer here to fix')
    expect((await local(root)).map((x) => x.id)).not.toContain(gone.id)
  } finally {
    await remote.close()
  }
})
