// Wire types for the admin inbox API. Type-only imports, so this file is client-safe.
import type { RedlineItem, RedlineStatus } from './redline-storage'

export type AdminItem = RedlineItem & { tester_label: string | null }
export type AdminDetail = AdminItem & { screenshot_url: string | null }
export interface AdminListResponse {
  items: AdminItem[]
  nextCursor: string | null
  counts: Record<RedlineStatus, number>
  testers: { id: string; label: string }[]
  versions: string[]
}
export interface AdminConflict { current: AdminItem }
