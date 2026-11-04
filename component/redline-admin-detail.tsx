'use client'

// Admin inbox detail pane: shows one feedback item and lets the owner change its status.
// The inbox shell owns Undo, list removal and counts; this reports through callbacks.

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ExternalLink, X, ImageOff, Loader2 } from 'lucide-react'
import type { AdminDetail, AdminItem } from './redline-admin-types'
import type { RedlineStatus } from './redline-storage'

export interface RedlineAdminDetailProps {
  apiUrl: string
  id: string
  onBack?(): void
  onStatusChanged(item: AdminItem, previous: AdminItem): void
  /** A PATCH lost to a change made elsewhere (409): `latest` is the item as it is now. */
  onRefreshed?(latest: AdminItem, previous: AdminItem): void
  onGone(id: string): void
}

type Load = 'loading' | 'ready' | 'gone' | 'error'

const DAY_MS = 86_400_000
const btn =
  'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-md border border-border px-4 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50 disabled:pointer-events-none'

function stripQuery(url: string) {
  // Saved URLs keep query keys but redact values (?q=…), so link without the query
  return url.replace(/\?[^#]*/, '')
}

/** Same-origin path only: exactly one leading slash, never // or /\ */
const SAFE_PATH = /^\/(?![/\\])/

function deletesIn(expiresAt: string): string {
  const days = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / DAY_MS)
  if (days <= 0) return 'Deletes today'
  return days === 1 ? 'Deletes in 1 day' : `Deletes in ${days} days`
}

function Field({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`break-words text-sm text-foreground ${mono ? 'font-mono text-xs' : ''}`}>{value || '—'}</dd>
    </div>
  )
}

export function RedlineAdminDetail({ apiUrl, id, onBack, onStatusChanged, onRefreshed, onGone }: RedlineAdminDetailProps) {
  const [load, setLoad] = useState<Load>('loading')
  const [detail, setDetail] = useState<AdminDetail | null>(null)
  const [shotFailed, setShotFailed] = useState(false)
  const [viewer, setViewer] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const refetched = useRef<Set<string>>(new Set())
  const current = useRef(id)
  current.current = id
  const closeRef = useRef<HTMLButtonElement>(null)
  const thumbRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  const fetchItem = useCallback(
    async (forId: string): Promise<AdminDetail | 'gone' | 'error'> => {
      try {
        const res = await fetch(`${apiUrl}/${encodeURIComponent(forId)}`)
        if (res.status === 404) return 'gone'
        if (!res.ok) return 'error'
        return (await res.json()) as AdminDetail
      } catch {
        return 'error'
      }
    },
    [apiUrl],
  )

  const initial = useCallback(async () => {
    setLoad('loading')
    setDetail(null)
    setShotFailed(false)
    setViewer(false)
    setNotice(null)
    setActionError(null)
    setBusy(false)
    const forId = id
    const r = await fetchItem(forId)
    if (current.current !== forId) return
    if (r === 'gone') {
      setLoad('gone')
      onGone(forId)
    } else if (r === 'error') setLoad('error')
    else {
      setDetail(r)
      setLoad('ready')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, fetchItem])

  useEffect(() => {
    initial()
  }, [initial])

  useEffect(() => {
    if (!viewer) return
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setViewer(false)
        return
      }
      if (e.key !== 'Tab') return
      const nodes = dialogRef.current?.querySelectorAll<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])')
      if (!nodes || nodes.length === 0) return
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      const active = document.activeElement
      if (!dialogRef.current?.contains(active)) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewer])

  // Return focus to the thumbnail when the viewer closes
  const wasOpen = useRef(false)
  useEffect(() => {
    if (wasOpen.current && !viewer) thumbRef.current?.focus()
    wasOpen.current = viewer
  }, [viewer])

  async function onImageError() {
    // Signed URLs last 5 minutes: refetch once per id, then give up
    if (refetched.current.has(id)) {
      setShotFailed(true)
      return
    }
    refetched.current.add(id)
    const forId = id
    const r = await fetchItem(forId)
    if (current.current !== forId) return
    if (r === 'gone') {
      setLoad('gone')
      onGone(forId)
    } else if (r === 'error' || !r.screenshot_url) setShotFailed(true)
    else setDetail(r)
  }

  async function changeStatus(status: RedlineStatus) {
    if (!detail || busy) return
    const forId = id
    const previous = stripDetail(detail)
    setBusy(true)
    setNotice(null)
    setActionError(null)
    try {
      const res = await fetch(`${apiUrl}/${encodeURIComponent(forId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, expected_status_updated_at: detail.status_updated_at }),
      })
      const live = () => current.current === forId
      if (res.status === 404) {
        if (live()) setLoad('gone')
        onGone(forId)
      } else if (res.status === 409) {
        const { current: latest } = (await res.json()) as { current: AdminItem }
        if (live()) {
          setDetail((d) => (d ? { ...d, ...latest } : d))
          setNotice('Changed elsewhere. Showing the latest.')
        }
        // The list still shows the old copy: let the shell move the row and fix counts
        onRefreshed?.(latest, previous)
      } else if (res.ok) {
        const updated = (await res.json()) as AdminItem
        // The server changed regardless of what is on screen now: always report it
        if (live()) setDetail((d) => (d ? { ...d, ...updated } : d))
        onStatusChanged(updated, previous)
      } else if (live()) {
        setActionError('Could not update the status. Try again.')
      }
    } catch {
      if (current.current === forId) setActionError('Could not update the status. Try again.')
    } finally {
      if (current.current === forId) setBusy(false)
    }
  }

  const backBtn = onBack ? (
    <button type="button" onClick={onBack} className={`${btn} self-start lg:hidden`}>
      <ArrowLeft className="h-4 w-4" />
      Back
    </button>
  ) : null

  if (load === 'loading') {
    return (
      <div className="flex h-full flex-col gap-4 p-4" aria-busy="true">
        {backBtn}
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading...
        </div>
      </div>
    )
  }

  if (load === 'gone') {
    return (
      <div className="flex h-full flex-col gap-4 p-4">
        {backBtn}
        <p role="status" className="text-sm text-muted-foreground">This feedback is no longer available.</p>
      </div>
    )
  }

  if (load === 'error' || !detail) {
    return (
      <div className="flex h-full flex-col gap-4 p-4">
        {backBtn}
        <p role="alert" className="text-sm text-destructive">Could not load this feedback.</p>
        <button type="button" onClick={initial} className={`${btn} self-start`}>Retry</button>
      </div>
    )
  }

  const showShot = detail.screenshot_url && !shotFailed
  const tester = detail.tester_label ?? detail.tester_id

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto bg-background p-4">
      {backBtn}

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span
          data-testid="status"
          className="rounded-full border border-border bg-card px-2.5 py-1 font-medium capitalize text-foreground"
        >
          {detail.status}
        </span>
        <span>{deletesIn(detail.expires_at)}</span>
      </div>

      {notice && (
        <p role="status" className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground">
          {notice}
        </p>
      )}
      {actionError && (
        <p role="alert" className="text-sm text-destructive">{actionError}</p>
      )}

      <p className="whitespace-pre-wrap break-words text-base text-foreground">{detail.feedback}</p>

      <div className="rounded-lg border border-border bg-card p-3">
        {showShot ? (
          <button
            ref={thumbRef}
            type="button"
            aria-label="Open screenshot"
            onClick={() => setViewer(true)}
            className="block min-h-[44px] w-full overflow-hidden rounded-md"
          >
            <img
              src={detail.screenshot_url!}
              alt="Screenshot of the page"
              onError={onImageError}
              className="max-h-80 w-full object-contain object-left-top"
            />
          </button>
        ) : (
          <div className="flex min-h-[44px] items-center gap-2 text-sm text-muted-foreground">
            <ImageOff className="h-4 w-4" />
            Screenshot no longer available
          </div>
        )}
      </div>

      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-xs text-muted-foreground">Page</dt>
          <dd>
            {SAFE_PATH.test(stripQuery(detail.page_url)) ? (
              <a
                href={stripQuery(detail.page_url)}
                rel="noreferrer"
                className="inline-flex min-h-[44px] items-center gap-1.5 break-all font-mono text-xs text-primary underline"
              >
                {detail.page_url}
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            ) : (
              <span className="break-all font-mono text-xs text-foreground">{detail.page_url}</span>
            )}
          </dd>
        </div>
        <Field label="Element" value={detail.element_selector} mono />
        <Field label="Element text" value={detail.element_text} />
        <Field label="Tester" value={tester} />
        <Field label="Version" value={detail.app_version} />
        <div className="sm:col-span-2">
          <Field label="User agent" value={detail.user_agent} mono />
        </div>
      </dl>

      <div className="mt-auto flex flex-wrap gap-2 pt-2">
        {detail.status !== 'fixed' && (
          <button type="button" disabled={busy} onClick={() => changeStatus('fixed')} className={`${btn} bg-primary text-primary-foreground hover:bg-primary/90`}>
            Mark fixed
          </button>
        )}
        {detail.status !== 'deferred' && (
          <button type="button" disabled={busy} onClick={() => changeStatus('deferred')} className={btn}>Defer</button>
        )}
        {detail.status !== 'dismissed' && (
          <button type="button" disabled={busy} onClick={() => changeStatus('dismissed')} className={btn}>Dismiss</button>
        )}
        {detail.status !== 'open' && (
          <button type="button" disabled={busy} onClick={() => changeStatus('open')} className={btn}>Reopen</button>
        )}
      </div>

      {viewer && showShot && (
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Screenshot"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setViewer(false)}
        >
          <button
            ref={closeRef}
            type="button"
            aria-label="Close screenshot"
            onClick={() => setViewer(false)}
            className="absolute right-3 top-3 inline-flex h-11 w-11 items-center justify-center rounded-full bg-card text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
          <img
            src={detail.screenshot_url!}
            alt="Screenshot of the page"
            onError={onImageError}
            onClick={(e) => e.stopPropagation()}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      )}
    </div>
  )
}

function stripDetail(d: AdminDetail): AdminItem {
  const { screenshot_url: _drop, ...item } = d
  return item
}
