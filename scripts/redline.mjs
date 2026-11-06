#!/usr/bin/env node
// Redline CLI — copy to your project as redline/redline.mjs. No dependencies.
//
//   node redline/redline.mjs purge [--days N]   Delete local redlines past retention, plus their screenshots
//   node redline/redline.mjs mode               Print `local`, or `remote <host>` when a remote is configured
//   node redline/redline.mjs pull               Sync the inbox into redline/feedback.json (inbox wins on conflict),
//                                               then remove pulled items that expired or the inbox no longer has
//   node redline/redline.mjs push               Send local status changes for pulled items to the inbox
//
// purge uses each item's expires_at and keeps items without one; --days N instead deletes
// anything older than N days. pull never removes an item it didn't bring down.
// pull and push talk to the redline-sync edge function, never to Supabase directly, so this
// machine holds only a sync secret and no service-role key. Configure them with
// REDLINE_REMOTE_URL and REDLINE_SYNC_SECRET, from the environment or a gitignored
// .env.redline in the project root:
//
//   REDLINE_REMOTE_URL=https://<project>.supabase.co
//   REDLINE_SYNC_SECRET=<the secret set on the redline-sync function>

import { readFile, writeFile, mkdir, unlink, rename } from 'fs/promises'
import { join, resolve, sep } from 'path'
import { execSync } from 'child_process'

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
  // The temp name matches the redline/feedback.json* gitignore pattern, so a leftover can't be committed
  const tmp = `${feedbackPath}.${process.pid}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(items, null, 2))
    await rename(tmp, feedbackPath)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
}

// Only an item with an expires_at can expire. Items saved before 1.2.0 have none: they are
// the owner's own notes, kept until purge --days removes them on purpose.
function isExpired(r, now) {
  return !!r.expires_at && new Date(r.expires_at).getTime() <= now
}

// Delete a local screenshot, but only inside redline/screenshots/. Returns true if removed.
async function removeScreenshot(path) {
  if (!path) return false
  const target = resolve(root, path)
  if (!target.startsWith(resolve(screenshotsDir) + sep)) return false
  try {
    await unlink(target)
    return true
  } catch {
    return false // already gone
  }
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
  const expired = (r) =>
    days !== null ? new Date(r.created_at ?? 0).getTime() + days * DAY_MS <= now : isExpired(r, now)

  const items = await readItems()
  const gone = items.filter(expired)
  let screenshots = 0
  for (const r of gone) if (await removeScreenshot(r.screenshot_path)) screenshots++
  if (gone.length) await writeItems(items.filter((r) => !expired(r)))
  console.log(`Purged ${gone.length} redline${gone.length === 1 ? '' : 's'} and ${screenshots} screenshot${screenshots === 1 ? '' : 's'}.`)
  const undated = days === null ? items.filter((r) => !r.expires_at).length : 0
  if (undated) {
    console.log(`Kept ${undated} redline${undated === 1 ? '' : 's'} with no expiry date (saved before 1.2.0). To remove old ones, run purge --days N.`)
  }
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
    throw new Error('REDLINE_REMOTE_URL is not a valid URL')
  }
  console.log(`Supabase: ${host}`)
  return { ...remote, host }
}

// A pulled item belongs to the remote it came from. Items pulled before remote_host was
// recorded can't say, so they count as the current remote's.
const fromRemote = (r, remote) => r.source === 'remote' && (!r.remote_host || r.remote_host === remote.host)

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
    throw new Error('REDLINE_REMOTE_URL is not a valid URL')
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

  const now = Date.now()
  const remoteIds = new Set(json.items.map((r) => r.id))
  const byId = new Map(items.map((r) => [r.id, r]))
  let added = 0
  let updated = 0
  let discarded = 0
  for (const { screenshot_url, ...r } of json.items) {
    const synced = { source: 'remote', remote_host: remote.host, remote_status: r.status, remote_status_updated_at: r.status_updated_at }
    const local = byId.get(r.id)
    if (!local) {
      if (isExpired(r, now)) continue // past retention, awaiting the daily purge: never bring it down
      const screenshotPath = await downloadScreenshot({ ...r, screenshot_url })
      const item = { ...r, screenshot_path: screenshotPath, ...synced }
      items.push(item)
      byId.set(r.id, item)
      added++
      continue
    }
    // Listed here, so it's the same inbox row even if it was pulled through another host
    // name (a custom domain, a proxy): it is adopted, and synced rewrites its remote_host
    if (local.source !== 'remote') continue
    local.remote_host = remote.host
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

  // Retention reaches this machine for items pulled from this remote only. The list above is
  // complete (the function pages through every approved row), so a pulled item missing from
  // it was purged, deleted, or sent back to To Review in the inbox. Items created on this
  // machine, or pulled from another remote, are never removed here: that is purge's job,
  // run on purpose. An empty list next to pulled items that haven't expired is more likely
  // a remote that answered wrongly than an inbox emptied by hand, so nothing is pruned
  // for being missing; those items still go once they expire.
  const pulledHere = items.filter((r) => fromRemote(r, remote))
  const trustList = json.items.length > 0 || pulledHere.every((r) => isExpired(r, now))
  const removed = pulledHere.filter((r) => isExpired(r, now) || (trustList && !remoteIds.has(r.id)))
  const changedLocally = removed.filter((r) => r.status !== r.remote_status).map((r) => r.id)
  for (const r of removed) await removeScreenshot(r.screenshot_path)
  const gone = new Set(removed)
  await writeItems(items.filter((r) => !gone.has(r)))
  console.log(`Pulled ${added} new, ${updated} updated${discarded ? `, ${discarded} local change${discarded === 1 ? '' : 's'} discarded` : ''} (${json.items.length} reviewed in the inbox).`)
  if (removed.length) {
    const note = changedLocally.length ? ` (including ${changedLocally.join(', ')}, changed locally)` : ''
    console.log(`Removed ${removed.length} redline${removed.length === 1 ? '' : 's'} no longer here to fix (expired, purged, or sent back to To Review)${note}.`)
  }
  if (!trustList) {
    const kept = pulledHere.length - removed.length
    console.log(`The inbox listed nothing to fix, so ${kept} pulled redline${kept === 1 ? ' was' : 's were'} kept. They go when they expire, or when the inbox lists items again.`)
  }
}

async function push() {
  const remote = await requireRemote()
  const items = await readItems()
  let pushed = 0
  let conflicts = 0
  const elsewhere = items.filter((r) => r.source === 'remote' && !fromRemote(r, remote) && r.status !== r.remote_status)
  try {
    for (const r of items) {
      if (!fromRemote(r, remote) || r.status === r.remote_status) continue
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
        console.log(`Not found on ${r.id}: it was purged or sent back to To Review in the inbox. Left as is.`)
      } else {
        throw new Error(`Push failed for ${r.id} (${status}).`)
      }
    }
  } finally {
    if (items.length) await writeItems(items)
  }
  console.log(`Pushed ${pushed} status change${pushed === 1 ? '' : 's'}${conflicts ? `, ${conflicts} conflict${conflicts === 1 ? '' : 's'}` : ''}.`)
  if (elsewhere.length) {
    const hosts = [...new Set(elsewhere.map((r) => r.remote_host))].join(', ')
    console.log(`Not sent: ${elsewhere.length} status change${elsewhere.length === 1 ? '' : 's'} on redlines pulled from ${hosts}. Run pull first if that is this same inbox under another address.`)
  }
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
