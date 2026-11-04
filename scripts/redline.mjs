#!/usr/bin/env node
// Redline CLI — copy to your project as redline/redline.mjs. No dependencies.
//
//   node redline/redline.mjs purge [--days N]   Delete local redlines past retention, plus their screenshots
//   node redline/redline.mjs mode               Print `local`, or `remote <host>` when a remote is configured
//   node redline/redline.mjs pull               Sync the inbox into redline/feedback.json (inbox wins on conflict)
//   node redline/redline.mjs push               Send local status changes for pulled items to the inbox
//
// purge uses each item's expires_at; --days N instead deletes anything older than N days.
// pull and push talk to the redline-sync edge function, never to Supabase directly, so this
// machine holds only a sync secret and no service-role key. Configure them with
// REDLINE_REMOTE_URL and REDLINE_SYNC_SECRET, from the environment or a gitignored
// .env.redline in the project root:
//
//   REDLINE_REMOTE_URL=https://<project>.supabase.co
//   REDLINE_SYNC_SECRET=<the secret set on the redline-sync function>

import { readFile, writeFile, mkdir, unlink, rename } from 'fs/promises'
import { join } from 'path'
import { execSync } from 'child_process'

const DEFAULT_DAYS = 30
const DAY_MS = 86_400_000

function projectRoot() {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return process.cwd()
  }
}

const root = process.env.REDLINE_ROOT || projectRoot()
const feedbackPath = join(root, 'redline', 'feedback.json')
const screenshotsDir = join(root, 'redline', 'screenshots')

async function readItems() {
  let text
  try {
    text = await readFile(feedbackPath, 'utf-8')
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  try {
    const items = JSON.parse(text)
    if (!Array.isArray(items)) throw new Error('not an array')
    return items
  } catch {
    throw new Error('redline/feedback.json is not valid JSON; fix or move it, then retry.')
  }
}

// Write to a temp file in the same directory, then rename, so a crash never leaves a half file
async function writeItems(items) {
  await mkdir(join(root, 'redline'), { recursive: true })
  const tmp = `${feedbackPath}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(items, null, 2))
  await rename(tmp, feedbackPath)
}

function flag(name) {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}

async function purge() {
  const daysArg = flag('--days')
  const days = daysArg === undefined ? null : Number(daysArg)
  if (days !== null && !(days >= 0)) throw new Error('--days must be a number of days, e.g. --days 30')

  const now = Date.now()
  const expired = (r) => {
    const created = new Date(r.created_at ?? 0).getTime()
    if (days !== null) return created + days * DAY_MS <= now
    // Items saved before expires_at existed fall back to the 30-day default
    const expires = r.expires_at ? new Date(r.expires_at).getTime() : created + DEFAULT_DAYS * DAY_MS
    return expires <= now
  }

  const items = await readItems()
  const gone = items.filter(expired)
  let screenshots = 0
  for (const r of gone) {
    if (!r.screenshot_path) continue
    try {
      await unlink(join(root, r.screenshot_path))
      screenshots++
    } catch {
      // already gone
    }
  }
  if (gone.length) await writeItems(items.filter((r) => !expired(r)))
  console.log(`Purged ${gone.length} redline${gone.length === 1 ? '' : 's'} and ${screenshots} screenshot${screenshots === 1 ? '' : 's'}.`)
}

// Remote config: environment first, then a minimal KEY=VALUE parse of <root>/.env.redline
async function loadRemote() {
  const file = {}
  try {
    for (const line of (await readFile(join(root, '.env.redline'), 'utf-8')).split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i.exec(line)
      if (!m || line.trim().startsWith('#')) continue
      file[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2')
    }
  } catch {
    // no .env.redline
  }
  const url = (process.env.REDLINE_REMOTE_URL || file.REDLINE_REMOTE_URL || '').replace(/\/+$/, '')
  const secret = process.env.REDLINE_SYNC_SECRET || file.REDLINE_SYNC_SECRET || ''
  return url ? { url, secret } : null
}

async function requireRemote() {
  const remote = await loadRemote()
  if (!remote || !remote.secret) {
    throw new Error('No remote configured. Set REDLINE_REMOTE_URL and REDLINE_SYNC_SECRET in .env.redline in the project root (or in the environment).')
  }
  let host
  try {
    host = new URL(remote.url).host
  } catch {
    throw new Error(`REDLINE_REMOTE_URL is not a URL: ${JSON.stringify(remote.url)}`)
  }
  console.log(`Supabase: ${host}`)
  return remote
}

async function sync(remote, body) {
  const res = await fetch(`${remote.url}/functions/v1/redline-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-redline-sync-secret': remote.secret },
    body: JSON.stringify(body),
  })
  if (res.status === 401) throw new Error('The sync secret was rejected (401). Check REDLINE_SYNC_SECRET.')
  let json = null
  try {
    json = await res.json()
  } catch {
    // non-JSON error body
  }
  return { status: res.status, json }
}

async function mode() {
  const remote = await loadRemote()
  if (!remote) return console.log('local')
  try {
    console.log(`remote ${new URL(remote.url).host}`)
  } catch {
    throw new Error(`REDLINE_REMOTE_URL is not a URL: ${JSON.stringify(remote.url)}`)
  }
}

async function downloadScreenshot(r) {
  if (!r.screenshot_path) return null
  if (!/^[\w-]+\.(png|jpg)$/.test(r.screenshot_path)) {
    console.warn(`Skipping screenshot for ${r.id}: unexpected path ${JSON.stringify(r.screenshot_path)}`)
    return null
  }
  if (!r.screenshot_url) {
    console.warn(`Screenshot for ${r.id} is no longer in storage; saving the redline without it.`)
    return null
  }
  const img = await fetch(r.screenshot_url)
  if (!img.ok) {
    console.warn(`Screenshot for ${r.id} not downloaded (${img.status}); saving the redline without it.`)
    return null
  }
  await mkdir(screenshotsDir, { recursive: true })
  await writeFile(join(screenshotsDir, r.screenshot_path), Buffer.from(await img.arrayBuffer()))
  return `redline/screenshots/${r.screenshot_path}`
}

async function pull() {
  const remote = await requireRemote()
  const items = await readItems() // fail on an unreadable file before touching anything
  const { status, json } = await sync(remote, { action: 'list' })
  if (status !== 200 || !Array.isArray(json?.items)) throw new Error(`Remote list failed (${status}).`)

  const byId = new Map(items.map((r) => [r.id, r]))
  let added = 0
  let updated = 0
  let discarded = 0
  for (const { screenshot_url, ...r } of json.items) {
    const synced = { source: 'remote', remote_status: r.status, remote_status_updated_at: r.status_updated_at }
    const local = byId.get(r.id)
    if (!local) {
      const screenshotPath = await downloadScreenshot({ ...r, screenshot_url })
      const item = { ...r, screenshot_path: screenshotPath, ...synced }
      items.push(item)
      byId.set(r.id, item)
      added++
      continue
    }
    if (local.source !== 'remote') continue
    const untouched = local.status === local.remote_status
    const remoteMoved = local.remote_status_updated_at !== r.status_updated_at
    if (!untouched && !remoteMoved) continue // unpushed local change, remote unchanged: push will send it
    if (!untouched && local.status !== r.status) {
      console.log(`Discarded local change on ${r.id} (${r.page_url}): ${local.status} → kept ${r.status}`)
      discarded++
    }
    const screenshotPath = local.screenshot_path ?? (await downloadScreenshot({ ...r, screenshot_url }))
    const changed = local.status !== r.status || remoteMoved
    Object.assign(local, r, { screenshot_path: screenshotPath }, synced)
    if (changed) updated++
  }
  await writeItems(items)
  console.log(`Pulled ${added} new, ${updated} updated${discarded ? `, ${discarded} local change${discarded === 1 ? '' : 's'} discarded` : ''} (${json.items.length} in the inbox).`)
}

async function push() {
  const remote = await requireRemote()
  const items = await readItems()
  let pushed = 0
  let conflicts = 0
  try {
    for (const r of items) {
      if (r.source !== 'remote' || r.status === r.remote_status) continue
      const { status, json } = await sync(remote, {
        action: 'set_status',
        id: r.id,
        status: r.status,
        expected_status_updated_at: r.remote_status_updated_at,
      })
      if (status === 200 && json?.item) {
        r.remote_status = json.item.status
        r.remote_status_updated_at = json.item.status_updated_at
        pushed++
      } else if (status === 409) {
        console.log(`Conflict on ${r.id}: changed in the inbox. Run pull.`)
        conflicts++
      } else if (status === 404) {
        console.log(`Not found on ${r.id}: it is gone from the inbox (purged?). Left as is.`)
      } else {
        throw new Error(`Push failed for ${r.id} (${status}).`)
      }
    }
  } finally {
    if (items.length) await writeItems(items)
  }
  console.log(`Pushed ${pushed} status change${pushed === 1 ? '' : 's'}${conflicts ? `, ${conflicts} conflict${conflicts === 1 ? '' : 's'}` : ''}.`)
}

const commands = { purge, mode, pull, push }
const command = commands[process.argv[2]]
if (!command) {
  console.log('Usage: node redline/redline.mjs <purge [--days N] | mode | pull | push>')
  process.exit(process.argv[2] ? 1 : 0)
}
command().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
