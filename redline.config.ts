// Redline config — copy to your project root as redline.config.ts.
// Imported by the API route (storage, retention, version) and by the inspector (PHI selectors).
import { defineRedlineConfig } from './component/redline-config' // adjust to where you copied it

export default defineRedlineConfig({
  // 'local' (default): redline/feedback.json in the project root.
  // 'supabase': opt-in, for testers on a deployed build. Needs the migrations + edge function.
  storage: 'local',

  // Supabase mode only. Server-only env vars — never NEXT_PUBLIC_*.
  supabase: {
    url: process.env.SUPABASE_URL,
    secretKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    bucket: 'redline-screenshots',
  },

  // Masked in screenshots and captured text, in addition to [data-phi]
  phiSelectors: [],

  // Days before feedback and screenshots are purged
  retentionDays: 30,

  appVersion: process.env.NEXT_PUBLIC_APP_VERSION,
})
