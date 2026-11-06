// Checks on the copy-in source itself, which hosts vendor byte for byte and read as docs.

import { test, expect } from '@playwright/test'
import { readFile, readdir } from 'fs/promises'
import { join } from 'path'
import { fileURLToPath } from 'url'

const dir = fileURLToPath(new URL('../component', import.meta.url))

test('every doc comment sits on what it documents, never on a stray line comment', async () => {
  for (const f of await readdir(dir)) {
    const text = await readFile(join(dir, f), 'utf-8')
    for (const m of text.matchAll(/\/\*\*[\s\S]*?\*\/\n[ \t]*(\S[^\n]*)/g)) {
      const line = text.slice(0, m.index).split('\n').length
      expect(m[1].startsWith('//'), `${f}:${line} doc comment is detached`).toBe(false)
    }
  }
})
