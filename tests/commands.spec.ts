// The slash-command files are prompts, not code, but hosts install them globally and run
// them against every project. These checks pin the parts that broke existing installs.

import { test, expect } from '@playwright/test'
import { readFile, access } from 'fs/promises'
import { join } from 'path'
import { fileURLToPath } from 'url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const read = (p: string) => readFile(join(repo, p), 'utf-8')

test('every command that syncs treats a missing redline/redline.mjs as local mode', async () => {
  for (const name of ['check', 'fix', 'defer', 'clear']) {
    const text = await read(`commands/redline/${name}.md`)
    const firstMode = text.indexOf('node redline/redline.mjs mode')
    const guard = text.indexOf('If `redline/redline.mjs` does not exist')
    expect(guard, `${name}.md has the missing-file guard`).toBeGreaterThan(-1)
    expect(guard, `${name}.md checks for the file before running it`).toBeLessThan(firstMode)
    expect(text, `${name}.md suggests the installer`).toContain('AGENT-INSTALLATION')
  }
})

test('commands that write feedback.json say never to edit the sync fields', async () => {
  for (const p of ['commands/redline.md', 'commands/redline/fix.md', 'commands/redline/defer.md']) {
    const text = await read(p)
    expect(text, p).toContain('Never edit `source`, `remote_status` or `remote_status_updated_at`')
  }
})

test('update compares every installed component with the new release, never a file with itself', async () => {
  const text = await read('commands/redline/update.md')
  for (const m of text.matchAll(/diff\s+(?:-\w+\s+)*(\S+)\s+(\S+)/g)) expect(m[1], m[0]).not.toBe(m[2])
  const install = await read('AGENT-INSTALLATION.md')
  const step6 = /6\. .*copy these from \/tmp\/redline\/component\/ there: (.*)/.exec(install)
  expect(step6).not.toBeNull()
  const files = step6![1].split(/,\s*/).map((f) => f.trim().replace(/\.$/, ''))
  expect(files.length).toBeGreaterThan(5)
  for (const f of files) {
    expect(text, `update.md compares ${f}`).toContain(f)
    await access(join(repo, 'component', f))
  }
  expect(text).toContain('re-run the install prompt from AGENT-INSTALLATION.md')
  expect(text).toContain('redline-config.ts')
  expect(text).toContain('redline-mask.ts')
})

test('CHANGELOG has an unreleased 1.2.0 entry with an upgrade note; VERSION is not bumped', async () => {
  const log = await read('CHANGELOG.md')
  expect(log).toMatch(/## 1\.2\.0 \(unreleased\)/)
  expect(log).toContain('Upgrading from 1.1.x')
  expect(log).toContain('15.1')
  expect((await read('VERSION')).trim()).toBe('1.1.2')
})
