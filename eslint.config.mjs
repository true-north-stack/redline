// Lints the copy-in components with the same rules a current Next.js host runs
// (eslint-config-next, including the React Compiler hook rules), so files hosts
// vendor byte-for-byte don't fail their lint.
import next from 'eslint-config-next'

export default [
  ...next,
  // Redline has no pages/ directory; the rule only applies to the Pages Router
  { rules: { '@next/next/no-html-link-for-pages': 'off' } },
  { ignores: ['node_modules/**', 'tests/**', 'dev/**', 'scripts/**', 'supabase/**', 'docs/**', '.redline-stack/**', 'test-results/**'] },
]
