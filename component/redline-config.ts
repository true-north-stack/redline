// Shared Redline config + helpers. Safe to import from client and server code:
// nothing here touches the DOM or the filesystem.

export type RedlineStorage = 'local' | 'supabase'

export interface RedlineConfig {
  /** Where feedback goes. 'local' (default) writes redline/feedback.json; 'supabase' is opt-in. */
  storage: RedlineStorage
  /** Supabase mode only. Read these from server-only env vars, never NEXT_PUBLIC_*. */
  supabase?: {
    url?: string
    /** Secret key (sb_secret_…) or legacy service_role key. Server-side only. */
    secretKey?: string
    /** Private bucket for screenshots. Default: redline-screenshots */
    bucket?: string
  }
  /** Extra CSS selectors to mask, on top of [data-phi] and the defaults. */
  phiSelectors?: string[]
  /**
   * Mask the fields and links that usually hold personal data (DEFAULT_MASKS) without
   * tagging them. Default: true. Turn off only if nothing in those places is private.
   */
  maskDefaults?: boolean
  /** Days to keep feedback and screenshots. Default: 30 */
  retentionDays?: number
  /** Saved on every item, e.g. process.env.NEXT_PUBLIC_APP_VERSION */
  appVersion?: string
}

export const DEFAULT_PHI_SELECTOR = '[data-phi]'

/**
 * Masked unless maskDefaults is false: places that hold personal data on almost every
 * app, typed or shown, whether or not anyone remembered to tag them. Redline's own
 * feedback box is a textarea too, but Redline's UI is never captured.
 */
export const DEFAULT_MASKS = [
  'input[type="email" i]',
  'input[type="tel" i]',
  'input[autocomplete~="email" i]',
  'input[autocomplete~="tel" i]',
  'textarea',
  '[contenteditable]:not([contenteditable="false" i])',
  'a[href^="mailto:" i]',
  'a[href^="tel:" i]',
  'a[href^="sms:" i]',
]
export const DEFAULT_RETENTION_DAYS = 30
export const DEFAULT_BUCKET = 'redline-screenshots'

/**
 * Size caps on what a tester can send. Feedback is untrusted input, written by anyone
 * the host lets in, so every field is bounded here and again by the database.
 */
export const LIMITS = {
  feedback: 5000,
  element_text: 2000,
  element_selector: 1000,
  page_url: 2000,
  user_agent: 512,
  screenshotBytes: 8 * 1024 * 1024,
  requestBytes: 10 * 1024 * 1024,
} as const

export function defineRedlineConfig(config: RedlineConfig): RedlineConfig {
  // The config file is also imported by the inspector for phiSelectors. Server-only
  // env vars are undefined in the browser anyway; strip the block so a misconfigured
  // NEXT_PUBLIC_ key can't ride along in client state either.
  if (typeof window !== 'undefined' && config.supabase) {
    if (config.supabase.secretKey) {
      console.error('[redline] Supabase secret key is visible in the browser. Use a server-only env var.')
    }
    const clientSafe = { ...config }
    delete clientSafe.supabase
    return clientSafe
  }
  return config
}

/** Every selector to mask: [data-phi], the defaults unless turned off, and the host's extras. */
export function maskSelectors(extra: string[] = [], defaults = true): string[] {
  return [DEFAULT_PHI_SELECTOR, ...(defaults ? DEFAULT_MASKS : []), ...extra.filter((s) => s.trim())]
}

/**
 * Page URL as saved with a redline: path, query keys with values redacted, and the
 * hash only when it's a plain anchor. Query values and fragments carry search terms
 * and auth tokens (#access_token=…), so they never get stored.
 */
export function sanitizePageUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw, 'http://redline.local')
  } catch {
    return ''
  }
  const keys = Array.from(url.searchParams.keys())
  const query = keys.length ? '?' + keys.map((k) => `${encodeURIComponent(k)}=…`).join('&') : ''
  const hash = /^#[\w-]*$/.test(url.hash) ? url.hash : ''
  // Collapse leading slashes/backslashes so a path can never read as protocol-relative (//host)
  const path = url.pathname.replace(/^[/\\]+/, '/')
  return path + query + hash
}
