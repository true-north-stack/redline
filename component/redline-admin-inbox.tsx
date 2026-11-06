'use client'

// Admin inbox: status tabs with counts, tester/version filters, a paged list and the
// detail pane. State lives in the URL (?status=&tester=&version=&id=) through the History
// API on the current path, so it works inside Next and outside it.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Camera } from 'lucide-react'
import { RedlineAdminDetail } from './redline-admin-detail'
import { STATUS_LABELS } from './redline-admin-types'
import type { AdminItem, AdminListResponse } from './redline-admin-types'
import type { RedlineStatus } from './redline-storage'

type Tab = RedlineStatus | 'all'
interface Query { status: Tab; tester: string; version: string; id: string | null }
interface Undo { item: AdminItem; previous: RedlineStatus; error?: string }

const TABS: { key: Tab; label: string }[] = [
  { key: 'review', label: STATUS_LABELS.review },
  { key: 'open', label: STATUS_LABELS.open },
  { key: 'deferred', label: STATUS_LABELS.deferred },
  { key: 'fixed', label: STATUS_LABELS.fixed },
  { key: 'dismissed', label: STATUS_LABELS.dismissed },
  { key: 'all', label: 'All' },
]
const UNDO_MS = 5000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ZERO: Record<RedlineStatus, number> = { review: 0, open: 0, fixed: 0, dismissed: 0, deferred: 0 }
const control =
  'min-h-[44px] rounded-md border border-border bg-background px-3 text-sm text-foreground transition-colors hover:bg-muted disabled:opacity-50'

const DEFAULT_QUERY: Query = { status: 'review', tester: '', version: '', id: null }
// Fired after every history write, so the URL store below re-reads it
const LOCATION_EVENT = 'redline:inbox-location'
const getSearch = () => window.location.search
// The server render has no URL; the inbox waits for the client before it loads anything
const getServerSearch = () => null

function readQuery(search: string): Query {
  const p = new URLSearchParams(search)
  const s = p.get('status')
  const status: Tab = s === 'all' || TABS.some((t) => t.key === s) ? (s as Tab) : 'review'
  return { status, tester: p.get('tester') ?? '', version: p.get('version') ?? '', id: UUID.test(p.get('id') ?? '') ? p.get('id') : null }
}

function writeQuery(q: Query, mode: 'push' | 'replace') {
  const p = new URLSearchParams(window.location.search)
  p.set('status', q.status)
  for (const [k, v] of [['tester', q.tester], ['version', q.version], ['id', q.id]] as const) {
    if (v) p.set(k, v)
    else p.delete(k)
  }
  const url = `${window.location.pathname}?${p.toString()}`
  if (mode === 'push') window.history.pushState({ redlineInbox: true }, '', url)
  else window.history.replaceState(window.history.state, '', url)
  window.dispatchEvent(new Event(LOCATION_EVENT))
}

const rtf = typeof Intl !== 'undefined' ? new Intl.RelativeTimeFormat('en', { numeric: 'auto' }) : null
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000_000], ['month', 2_592_000_000], ['week', 604_800_000],
  ['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000],
]
function relativeTime(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now()
  if (Number.isNaN(diff) || !rtf) return ''
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return rtf.format(Math.trunc(diff / ms), unit)
  }
  return 'just now'
}

/** Newest first, ties by id, the same order the API returns. */
const newerFirst = (a: AdminItem, b: AdminItem) =>
  a.created_at === b.created_at ? (a.id < b.id ? 1 : -1) : a.created_at < b.created_at ? 1 : -1

function emptyText(tab: Tab): string {
  if (tab === 'all') return 'No feedback yet.'
  if (tab === 'review') return 'Nothing to review. New feedback from testers shows up here.'
  if (tab === 'open') return 'Nothing to fix. Feedback you move to To Fix shows up here, and /redline fix works through it.'
  return `No ${tab} feedback.`
}

function useDesktop() {
  const [desktop, setDesktop] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const sync = () => setDesktop(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  return desktop
}

function Row({ item, selected, onOpen }: { item: AdminItem; selected: boolean; onOpen(): void }) {
  const tester = item.tester_label ?? item.tester_id
  const meta = [tester, item.app_version, relativeTime(item.created_at)].filter(Boolean)
  return (
    <li>
      <button
        type="button"
        data-row-id={item.id}
        onClick={onOpen}
        aria-current={selected ? 'true' : undefined}
        className={`flex min-h-[44px] w-full min-w-0 flex-col gap-1 border-b border-border px-4 py-3 text-left transition-colors hover:bg-muted ${selected ? 'bg-muted' : 'bg-background'}`}
      >
        <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="shrink-0 rounded-full border border-border bg-card px-2 py-0.5 font-medium capitalize text-foreground">
            {STATUS_LABELS[item.status]}
          </span>
          {item.ux_review_requested && (
            <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 font-medium text-primary-foreground">UX review</span>
          )}
          {item.screenshot_path && <Camera aria-label="Has screenshot" className="h-3.5 w-3.5 shrink-0" />}
        </span>
        <span className="line-clamp-2 min-w-0 whitespace-pre-line [overflow-wrap:anywhere] text-sm text-foreground">{item.feedback}</span>
        <span className="block min-w-0 truncate font-mono text-xs text-muted-foreground">{item.page_url}</span>
        <span className="block min-w-0 truncate text-xs text-muted-foreground">{meta.join(' · ')}</span>
      </button>
    </li>
  )
}

export function RedlineAdminInbox({ apiUrl = '/api/admin/redlines' }: { apiUrl?: string }) {
  const qRef = useRef<Query>(DEFAULT_QUERY)
  const focusNext = useRef<'detail' | 'list' | null>(null)
  // The URL is the one source of truth for tab, filters and selection
  const subscribe = useCallback((notify: () => void) => {
    const onPop = () => {
      // Back out of an item: return focus to the list. Decided before React re-renders,
      // while qRef still holds the query that was showing.
      if (qRef.current.id && !readQuery(window.location.search).id) focusNext.current = 'list'
      notify()
    }
    window.addEventListener('popstate', onPop)
    window.addEventListener(LOCATION_EVENT, notify)
    return () => {
      window.removeEventListener('popstate', onPop)
      window.removeEventListener(LOCATION_EVENT, notify)
    }
  }, [])
  const search = useSyncExternalStore(subscribe, getSearch, getServerSearch)
  const ready = search !== null
  const q = useMemo(() => (search === null ? DEFAULT_QUERY : readQuery(search)), [search])
  const [items, setItems] = useState<AdminItem[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [counts, setCounts] = useState<Record<RedlineStatus, number>>(ZERO)
  const [testers, setTesters] = useState<AdminListResponse['testers']>([])
  const [versions, setVersions] = useState<string[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [moreBusy, setMoreBusy] = useState(false)
  const [moreError, setMoreError] = useState(false)
  const [undo, setUndo] = useState<Undo | null>(null)
  const desktop = useDesktop()

  const itemsRef = useRef(items)
  const reqId = useRef(0)
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const undoRef = useRef<Undo | null>(null)
  // Handlers and async callbacks read the latest committed values through these
  useLayoutEffect(() => {
    qRef.current = q
    itemsRef.current = items
    undoRef.current = undo
  })
  const loadingFirst = useRef(false)
  const openedFrom = useRef<string | null>(null)
  const detailRef = useRef<HTMLElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const listRef = useRef<HTMLElement>(null)
  const [detailKey, setDetailKey] = useState(0)
  const [undoBusyId, setUndoBusyId] = useState<string | null>(null)

  const buildUrl = useCallback(
    (cursor?: string) => {
      const p = new URLSearchParams()
      if (q.status !== 'all') p.set('status', q.status)
      if (q.tester) p.set('tester', q.tester)
      if (q.version) p.set('version', q.version)
      if (cursor) p.set('cursor', cursor)
      const s = p.toString()
      return s ? `${apiUrl}?${s}` : apiUrl
    },
    [apiUrl, q.status, q.tester, q.version],
  )

  // Normalize the URL once on the client: drops anything we did not accept (bad id, unknown status)
  useEffect(() => {
    writeQuery(readQuery(window.location.search), 'replace')
  }, [])

  const applyPage = (data: AdminListResponse, append: boolean) => {
    setItems((prev) => (append ? [...prev, ...data.items.filter((i) => !prev.some((p) => p.id === i.id))] : data.items))
    setNextCursor(data.nextCursor)
    setCounts({ ...ZERO, ...data.counts })
    setTesters(data.testers)
    setVersions(data.versions)
  }

  // Which list URL the current list state belongs to. A filter change shows the skeleton
  // straight away (derived below), with no state set inside an effect.
  const [listFor, setListFor] = useState<string | null>(null)
  const listUrl = ready ? buildUrl() : null

  // First page of the current list. State is only set in the promise callbacks.
  const fetchFirst = useCallback(() => {
    const mine = ++reqId.current
    loadingFirst.current = true
    const url = buildUrl()
    return fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status))
        return res.json() as Promise<AdminListResponse>
      })
      .then((data) => {
        if (mine !== reqId.current) return
        loadingFirst.current = false
        applyPage(data, false)
        setMoreError(false)
        setListFor(url)
        setState('ready')
      })
      .catch(() => {
        if (mine !== reqId.current) return
        loadingFirst.current = false
        setListFor(url)
        setState('error')
      })
  }, [buildUrl])

  useEffect(() => {
    if (ready) void fetchFirst()
  }, [ready, fetchFirst])

  // Handlers that finish after a re-render (a failed Undo, a stale PATCH) must fetch the
  // list as it is now, not as it was when they started
  const fetchFirstRef = useRef(fetchFirst)
  useLayoutEffect(() => {
    fetchFirstRef.current = fetchFirst
  }, [fetchFirst])

  // Reload from a handler (Retry, a failed Undo): show the skeleton while it runs
  function reload() {
    setState('loading')
    setMoreError(false)
    void fetchFirstRef.current()
  }

  const view = listFor === listUrl ? state : 'loading'

  // A local change makes any list response that started earlier stale. A first-page load
  // is re-run (the server already has the change); a Load more is dropped and can be retried.
  function invalidateLists() {
    reqId.current++
    if (loadingFirst.current) void fetchFirstRef.current()
  }

  async function loadMore() {
    if (!nextCursor || moreBusy) return
    const mine = reqId.current
    setMoreBusy(true)
    setMoreError(false)
    try {
      const res = await fetch(buildUrl(nextCursor))
      if (!res.ok) throw new Error(String(res.status))
      const data = (await res.json()) as AdminListResponse
      if (mine === reqId.current) applyPage(data, true)
    } catch {
      if (mine === reqId.current) setMoreError(true)
    } finally {
      setMoreBusy(false)
    }
  }

  function changeFilter(patch: Partial<Query>) {
    writeQuery({ ...qRef.current, ...patch }, 'replace')
  }

  function openItem(id: string) {
    openedFrom.current = id
    focusNext.current = 'detail'
    writeQuery({ ...qRef.current, id }, 'push')
  }

  function selectQuiet(id: string | null) {
    writeQuery({ ...qRef.current, id }, 'replace')
  }

  function back() {
    focusNext.current = 'list'
    if (window.history.state?.redlineInbox) window.history.back()
    else selectQuiet(null)
  }

  // Remove a row and pick the row now in its place (or the one before it when it was last)
  function removeRow(id: string, advance: boolean) {
    const list = itemsRef.current
    const at = list.findIndex((i) => i.id === id)
    if (at < 0) return
    const rest = list.filter((i) => i.id !== id)
    setItems(rest)
    if (advance && qRef.current.id === id) {
      const next = (rest[at] ?? rest[at - 1])?.id ?? null
      focusNext.current = next ? 'detail' : 'list'
      selectQuiet(next)
    }
  }

  function bumpCounts(from: RedlineStatus, to: RedlineStatus) {
    if (from === to) return
    setCounts((c) => ({ ...c, [from]: Math.max(0, c[from] - 1), [to]: c[to] + 1 }))
  }

  function startUndo(item: AdminItem, previous: RedlineStatus) {
    if (undoTimer.current) clearTimeout(undoTimer.current)
    setUndo({ item, previous })
    undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS)
  }
  useEffect(() => () => { if (undoTimer.current) clearTimeout(undoTimer.current) }, [])

  function onStatusChanged(item: AdminItem, previous: AdminItem) {
    invalidateLists()
    bumpCounts(previous.status, item.status)
    const tab = qRef.current.status
    if (tab !== 'all' && item.status !== tab) removeRow(item.id, true)
    else setItems((list) => list.map((i) => (i.id === item.id ? { ...i, ...item } : i)))
    startUndo(item, previous.status)
  }

  // A change made elsewhere won a race with ours (409). Same list and count update as a
  // status change, but nothing to undo, and the pane stays on the item so its notice is seen.
  function onRefreshed(latest: AdminItem, previous: AdminItem) {
    invalidateLists()
    bumpCounts(previous.status, latest.status)
    const tab = qRef.current.status
    if (tab !== 'all' && latest.status !== tab) removeRow(latest.id, false)
    else setItems((list) => list.map((i) => (i.id === latest.id ? { ...i, ...latest } : i)))
  }

  function onGone(id: string) {
    invalidateLists()
    const row = itemsRef.current.find((i) => i.id === id)
    if (row) {
      setCounts((c) => ({ ...c, [row.status]: Math.max(0, c[row.status] - 1) }))
      removeRow(id, true)
    }
  }

  async function doUndo() {
    if (!undo || undoBusyId === undo.item.id) return
    const { item, previous } = undo
    if (undoTimer.current) clearTimeout(undoTimer.current)
    setUndoBusyId(item.id)
    // Undo is single-slot: a newer action replaces the bar, and this one must not touch it
    const stillMine = () => undoRef.current?.item.id === item.id
    const fail = (error: string) => {
      if (stillMine()) {
        setUndo({ item, previous, error })
        undoTimer.current = setTimeout(() => setUndo((u) => (u?.item.id === item.id ? null : u)), UNDO_MS)
      }
      reload()
    }
    try {
      const res = await fetch(`${apiUrl}/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // The token from the first PATCH's response, not the one the item was loaded with
        body: JSON.stringify({ status: previous, expected_status_updated_at: item.status_updated_at }),
      })
      if (res.ok) {
        const restored = (await res.json()) as AdminItem
        invalidateLists()
        bumpCounts(item.status, restored.status)
        const tab = qRef.current.status
        if (tab === 'all' || tab === restored.status) {
          setItems((list) =>
            list.some((i) => i.id === restored.id)
              ? list.map((i) => (i.id === restored.id ? { ...i, ...restored } : i))
              : [...list, restored].sort(newerFirst),
          )
        } else {
          removeRow(restored.id, false)
        }
        // Never move the selection or the mobile view; only refresh the pane if it shows this item
        if (qRef.current.id === restored.id) setDetailKey((k) => k + 1)
        setUndo((u) => (u?.item.id === item.id ? null : u))
      } else if (res.status === 404) fail('That feedback is gone.')
      else if (res.status === 409) fail('Changed elsewhere. Could not undo.')
      else fail('Could not undo. Try again.')
    } catch {
      fail('Could not undo. Try again.')
    } finally {
      setUndoBusyId((id) => (id === item.id ? null : id))
    }
  }

  const showList = desktop || !q.id
  const showDetail = desktop || !!q.id

  // Move focus after a selection change so it never drops to <body>
  useEffect(() => {
    const want = focusNext.current
    if (!want) return
    if (want === 'detail') {
      if (!q.id) return
      if (!desktop && !showDetail) return
      focusNext.current = null
      // On desktop, opening a row by click keeps focus where the user is
      if (desktop && document.activeElement && document.activeElement !== document.body && !detailRef.current?.contains(document.activeElement) && openedFrom.current === q.id) return
      detailRef.current?.focus()
    } else {
      if (q.id && !desktop) return
      focusNext.current = null
      const row = openedFrom.current
        ? listRef.current?.querySelector<HTMLElement>(`[data-row-id="${openedFrom.current}"]`)
        : null
      ;(row ?? headingRef.current)?.focus()
    }
  })

  const testerOptions = q.tester && !testers.some((t) => t.id === q.tester) ? [...testers, { id: q.tester, label: q.tester }] : testers
  const versionOptions = q.version && !versions.includes(q.version) ? [...versions, q.version] : versions

  return (
    <div className="relative flex min-w-0 flex-col lg:h-[calc(100dvh-4rem)] lg:flex-row">
      <section
        ref={listRef}
        data-testid="list-pane"
        hidden={!showList}
        className="flex min-w-0 flex-col bg-background pb-24 lg:w-[26rem] lg:pb-0 lg:shrink-0 lg:overflow-y-auto lg:border-r lg:border-border"
      >
        <h2 ref={headingRef} tabIndex={-1} className="sr-only">Tester feedback</h2>
        <div className="flex flex-col gap-3 border-b border-border p-3">
          <div role="tablist" aria-label="Status" className="grid grid-cols-3 gap-1">
            {TABS.map((t) => {
              const count = t.key === 'all' ? counts.review + counts.open + counts.deferred + counts.fixed + counts.dismissed : counts[t.key]
              const active = q.status === t.key
              return (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => changeFilter({ status: t.key })}
                  className={`inline-flex min-h-[44px] min-w-0 items-center justify-center gap-1 rounded-md border px-1.5 text-sm font-medium whitespace-nowrap transition-colors ${active ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-foreground hover:bg-muted'}`}
                >
                  {t.label}
                  <span className={`text-xs ${active ? 'text-primary-foreground' : 'text-muted-foreground'}`}>{count}</span>
                </button>
              )
            })}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
              Tester
              <select className={`${control} w-full min-w-0`} value={q.tester} onChange={(e) => changeFilter({ tester: e.target.value })}>
                <option value="">All testers</option>
                {testerOptions.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
              Version
              <select className={`${control} w-full min-w-0`} value={q.version} onChange={(e) => changeFilter({ version: e.target.value })}>
                <option value="">All versions</option>
                {versionOptions.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
          </div>
        </div>

        {view === 'loading' && (
          <ul aria-busy="true" className="flex flex-col">
            {[0, 1, 2, 3, 4].map((n) => (
              <li key={n} data-skeleton className="flex min-h-[44px] animate-pulse flex-col gap-2 border-b border-border px-4 py-3">
                <span className="h-3 w-16 rounded bg-muted" />
                <span className="h-4 w-full rounded bg-muted" />
                <span className="h-3 w-1/2 rounded bg-muted" />
              </li>
            ))}
          </ul>
        )}

        {view === 'error' && (
          <div className="flex flex-col items-start gap-3 p-4">
            <p role="alert" className="text-sm text-destructive">Could not load feedback.</p>
            <button type="button" onClick={reload} className={control}>Retry</button>
          </div>
        )}

        {view === 'ready' && items.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">{emptyText(q.status)}</p>
        )}

        {view === 'ready' && items.length > 0 && (
          <>
            <ul className="flex flex-col">
              {items.map((item) => (
                <Row key={item.id} item={item} selected={q.id === item.id} onOpen={() => openItem(item.id)} />
              ))}
            </ul>
            {(nextCursor || moreError) && (
              <div className="flex flex-col items-start gap-2 p-3">
                {moreError && <p role="alert" className="text-sm text-destructive">Could not load more.</p>}
                <button type="button" onClick={loadMore} disabled={moreBusy} className={control}>
                  {moreBusy ? 'Loading...' : 'Load more'}
                </button>
              </div>
            )}
          </>
        )}
      </section>

      <section
        ref={detailRef}
        tabIndex={-1}
        aria-label="Feedback detail"
        data-testid="detail-pane"
        hidden={!showDetail}
        className="min-w-0 flex-1 outline-none lg:overflow-hidden"
      >
        {q.id ? (
          <RedlineAdminDetail
            key={detailKey}
            apiUrl={apiUrl}
            id={q.id}
            onBack={back}
            onStatusChanged={onStatusChanged}
            onRefreshed={onRefreshed}
            onGone={onGone}
          />
        ) : (
          <p className="p-6 text-sm text-muted-foreground">Select feedback to see it here.</p>
        )}
      </section>

      {undo && (
        <div
          data-testid="undo-bar"
          role="status"
          className="fixed inset-x-4 bottom-4 z-40 mx-auto flex max-w-md items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-1 text-sm text-foreground shadow-lg"
        >
          {undo.error ? (
            <span>{undo.error}</span>
          ) : (
            <>
              <span>{undo.item.status === 'open' ? 'Moved to To Fix · ' : `Marked ${undo.item.status} · `}</span>
              <button
                type="button"
                onClick={doUndo}
                disabled={undoBusyId === undo.item.id}
                className="inline-flex min-h-[44px] items-center px-2 font-medium text-primary underline disabled:opacity-50"
              >
                Undo
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
