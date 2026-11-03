#!/usr/bin/env node
// Redline CLI — copy to your project as redline/redline.mjs. No dependencies.
//
//   node redline/redline.mjs purge [--days N]   Delete local redlines past retention, plus their screenshots
//   node redline/redline.mjs pull               Copy Supabase redlines into redline/feedback.json
//
// purge uses each item's expires_at; --days N instead deletes anything older than N days.
// pull reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) from the
// environment, e.g. `node --env-file=.env redline/redline.mjs pull`.

import { readFile, writeFile, mkdir, unlink } from 'fs/promises'
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
  try {
    return JSON.parse(await readFile(feedbackPath, 'utf-8'))
  } catch {
    return []
  }
}

async function writeItems(items) {
  await mkdir(join(root, 'redline'), { recursive: true })
  await writeFile(feedbackPath, JSON.stringify(items, null, 2))
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

async function pull() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, '')
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  const bucket = process.env.REDLINE_BUCKET || 'redline-screenshots'
  if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY).')
  const auth = { apikey: key, Authorization: `Bearer ${key}` }

  const res = await fetch(`${url}/rest/v1/items?select=*&order=created_at.asc`, {
    headers: { ...auth, 'Accept-Profile': 'feedback' },
  })
  if (!res.ok) throw new Error(`Supabase read failed: ${res.status} ${await res.text()}`)
  const remote = await res.json()

  const items = await readItems()
  const known = new Set(items.map((r) => r.id))
  let added = 0
  for (const r of remote) {
    if (known.has(r.id)) continue
    let screenshotPath = null
    if (r.screenshot_path && !/^[\w-]+\.(png|jpg)$/.test(r.screenshot_path)) {
      console.warn(`Skipping screenshot for ${r.id}: unexpected path ${JSON.stringify(r.screenshot_path)}`)
    } else if (r.screenshot_path) {
      const img = await fetch(`${url}/storage/v1/object/authenticated/${bucket}/${r.screenshot_path}`, { headers: auth })
      if (img.ok) {
        await mkdir(screenshotsDir, { recursive: true })
        await writeFile(join(screenshotsDir, r.screenshot_path), Buffer.from(await img.arrayBuffer()))
        screenshotPath = `redline/screenshots/${r.screenshot_path}`
      } else {
        console.warn(`Screenshot for ${r.id} not downloaded (${img.status}); saving the redline without it.`)
      }
    }
    items.push({ ...r, screenshot_path: screenshotPath })
    added++
  }
  if (added) await writeItems(items)
  console.log(`Pulled ${added} new redline${added === 1 ? '' : 's'} (${remote.length - added} already local).`)
}

const commands = { purge, pull }
const command = commands[process.argv[2]]
if (!command) {
  console.log('Usage: node redline/redline.mjs <purge [--days N] | pull>')
  process.exit(process.argv[2] ? 1 : 0)
}
command().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
