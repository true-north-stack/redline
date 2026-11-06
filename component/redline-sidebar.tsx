'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Crosshair, ExternalLink } from 'lucide-react'

interface RedlineRow {
  id: string
  page_url: string
  element_selector: string
  element_text: string | null
  feedback: string
  status: string
  created_at: string
}

interface RedlineSidebarProps {
  isActive: boolean
  onToggle: () => void
  /** Base URL for the redlines API. Defaults to '/api/redlines' */
  apiUrl?: string
}

export function RedlineSidebar({ isActive, onToggle, apiUrl = '/api/redlines' }: RedlineSidebarProps) {
  const router = useRouter()
  const [showList, setShowList] = useState(false)
  const [redlines, setRedlines] = useState<RedlineRow[]>([])
  const [count, setCount] = useState(0)
  // Bumped to re-fetch, e.g. when the list is opened
  const [refresh, setRefresh] = useState(0)

  // Fetch on mount and after submissions. State is set in the promise callback, not in
  // the effect body, so an update never cascades into a second render pass.
  useEffect(() => {
    let live = true
    function fetchRedlines() {
      fetch(apiUrl)
        .then((res) => (res.ok ? res.json() : null))
        .then((json) => {
          if (!live || !json) return
          setRedlines(json.data ?? [])
          setCount(json.count ?? 0)
        })
        .catch(() => {
          // API not available — silently degrade
        })
    }
    fetchRedlines()
    window.addEventListener('redline:submitted', fetchRedlines)
    return () => {
      live = false
      window.removeEventListener('redline:submitted', fetchRedlines)
    }
  }, [apiUrl, refresh])

  function handleNavigate(pageUrl: string) {
    setShowList(false)
    // Saved URLs keep query keys but redact values (?q=…), so navigate without the query
    router.push(pageUrl.replace(/\?[^#]*/, ''))
  }

  function formatTime(dateStr: string): string {
    const d = new Date(dateStr)
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  }

  function formatPageUrl(url: string): string {
    // /bookings/fc2cd2ff-... → /bookings/...
    return url.replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '/...')
  }

  return (
    <div className="mt-auto relative">
      <div className="flex items-center gap-0">
        {/* Toggle inspector */}
        <button
          type="button"
          onClick={onToggle}
          className={`flex flex-1 items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${
            isActive
              ? 'bg-red-500/15 text-red-400 font-medium'
              : 'text-muted-foreground hover:bg-white/5 hover:text-foreground'
          }`}
        >
          <Crosshair className="h-4 w-4" />
          Redline
          {isActive && (
            <span className="text-[10px] text-red-400">ON</span>
          )}
        </button>

        {/* Count badge — clickable to view list */}
        {count > 0 && (
          <button
            type="button"
            onClick={() => { setShowList(!showList); if (!showList) setRefresh((n) => n + 1) }}
            className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 text-[10px] font-semibold text-white hover:bg-red-500 transition-colors"
          >
            {count}
          </button>
        )}
      </div>

      {/* Redlines list popover */}
      {showList && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setShowList(false)} />

          {/* Panel */}
          <div className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-[400px] overflow-y-auto rounded-lg border border-border bg-card shadow-xl">
            <div className="sticky top-0 flex items-center justify-between border-b border-border bg-card px-3 py-2">
              <span className="text-xs font-semibold text-foreground">
                Open Redlines ({count})
              </span>
              <button
                type="button"
                onClick={() => setShowList(false)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Close
              </button>
            </div>

            {redlines.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                No open redlines
              </div>
            ) : (
              <div className="divide-y divide-border">
                {redlines.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => handleNavigate(r.page_url)}
                    className="w-full text-left px-3 py-2.5 hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mb-0.5">
                      <span className="font-mono">{formatPageUrl(r.page_url)}</span>
                      <ExternalLink className="h-2.5 w-2.5" />
                    </div>
                    <p className="text-xs text-foreground line-clamp-2">
                      {r.feedback}
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="font-mono text-[10px] text-muted-foreground/60 truncate max-w-[160px]">
                        {r.element_selector}
                      </span>
                      <span className="text-[10px] text-muted-foreground/40 ml-auto shrink-0">
                        {formatTime(r.created_at)}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
