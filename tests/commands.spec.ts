// The slash-command files are prompts, not code, but hosts install them globally and run
// them against every project. These checks pin the parts that broke existing installs.

import { test, expect } from '@playwright/test'
import { readFile, access, readdir } from 'fs/promises'
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
  // Every copy-in file ships: all of component/ except the route templates is in both lists
  const shipped = (await readdir(join(repo, 'component'))).filter((f) => !f.endsWith('-example.ts'))
  const loop = /for f in ([^;]*); do/.exec(text)
  expect(loop, 'update.md has the comparison loop').not.toBeNull()
  const looped = loop![1].trim().split(/\s+/)
  for (const f of shipped) {
    expect(files, `AGENT-INSTALLATION step 6 lists ${f}`).toContain(f)
    expect(looped, `update.md loop compares ${f}`).toContain(f)
  }
  expect(text).toContain('re-run the install prompt from AGENT-INSTALLATION.md')
  expect(text).toContain('redline-config.ts')
  expect(text).toContain('redline-mask.ts')
})

test('VERSION matches the newest released CHANGELOG entry, and 1.2.0 keeps its upgrade note', async () => {
  const log = await read('CHANGELOG.md')
  const released = log.match(/^## (\d+\.\d+\.\d+) \(\d{4}-\d{2}-\d{2}\)$/m)
  expect(released, 'a dated release heading').not.toBeNull()
  expect((await read('VERSION')).trim()).toBe(released![1])
  // An unreleased entry, if any, sits above the newest release
  const unreleased = log.search(/^## \d+\.\d+\.\d+ \(unreleased\)$/m)
  if (unreleased >= 0) expect(unreleased).toBeLessThan(released!.index!)
  expect(log).toContain('Upgrading from 1.1.x')
  expect(log).toContain('15.1')
})

test('the docs name exactly the files the inspector imports', async () => {
  const inspector = await read('component/redline-inspector.tsx')
  const components = await readdir(join(repo, 'component'))
  const imports = [...inspector.matchAll(/from '\.\/(redline-[\w-]+)'/g)]
    .map((m) => components.find((f) => f.replace(/\.tsx?$/, '') === m[1]))
    .sort()
  expect(imports.length).toBeGreaterThan(2)
  const named = (text: string) => [...text.matchAll(/redline-[\w-]+\.tsx?/g)].map((m) => m[0]).sort()

  const update = /the new inspector imports ([\s\S]*?), so copying it alone/.exec(await read('commands/redline/update.md'))
  expect(update, 'update.md names what the inspector imports').not.toBeNull()
  expect(named(update![1])).toEqual(imports)

  const install = /It adds (.*?), which the new inspector imports/.exec(await read('AGENT-INSTALLATION.md'))
  expect(install, 'AGENT-INSTALLATION names what the inspector imports').not.toBeNull()
  for (const f of named(install![1])) expect(imports, `the inspector imports ${f}`).toContain(f)
})
