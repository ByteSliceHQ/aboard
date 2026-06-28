import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { getAgents } from '../server/aboard'
import { relativeFromMs, absoluteFromMs, shortId } from '../lib/format'
import type { ApiResult, ObservedAgent } from '../types'

export const Route = createFileRoute('/agents')({
  loader: async () => getAgents(),
  component: AgentsPage,
})

// Poll often enough to feel live; agent calls are human-paced so this is cheap.
const POLL_MS = 1000
// Rows seen within this window are flagged "active" so you can watch calls land.
const ACTIVE_WINDOW_MS = 2500

function AgentsPage() {
  const initial = Route.useLoaderData() as ApiResult<ObservedAgent[]>
  const [result, setResult] = useState<ApiResult<ObservedAgent[]>>(initial)
  const [live, setLive] = useState(true)
  // A ticking clock so the "active" highlight and relative times refresh even
  // between polls.
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!live) return
    let cancelled = false
    const tick = async () => {
      const r = await getAgents()
      if (!cancelled) {
        setResult(r)
        setNow(Date.now())
      }
    }
    const id = setInterval(tick, POLL_MS)
    void tick()
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [live])

  const agents = result.ok ? result.data : []

  return (
    <section>
      <div className="page-header" style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <h1>Agents</h1>
          <p className="muted">
            Agents seen at the proxy. A delegated <strong>sub-agent</strong> is an
            offline-attenuated token with no session record — it appears here the
            moment it makes its first call, scoped below its parent.
          </p>
        </div>
        <LiveToggle live={live} onToggle={() => setLive((v) => !v)} count={agents.length} />
      </div>

      {!result.ok ? (
        <div className="banner banner-error">
          Cannot reach aboard service. {result.error}
        </div>
      ) : agents.length === 0 ? (
        <div className="empty">
          No agents have called the proxy yet. Run the agent demo, then attenuate
          and call as a sub-agent — rows appear here live.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th></th>
                <th>Role</th>
                <th>Token</th>
                <th>Root id</th>
                <th>Depth</th>
                <th>Effective grant</th>
                <th>Last call</th>
                <th>Seen</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => {
                const active = now - a.lastSeen < ACTIVE_WINDOW_MS
                return (
                  <tr key={a.fingerprint} style={active ? { background: 'rgba(59,130,246,0.10)' } : undefined}>
                    <td>
                      <span
                        title={active ? 'active just now' : 'idle'}
                        style={{
                          display: 'inline-block',
                          width: 8,
                          height: 8,
                          borderRadius: 8,
                          background: active ? '#3b82f6' : '#33394a',
                          boxShadow: active ? '0 0 0 3px rgba(59,130,246,0.25)' : 'none',
                        }}
                      />
                    </td>
                    <td>
                      <span
                        className={`badge ${a.role === 'sub-agent' ? 'badge-kind' : 'badge-forever'}`}
                      >
                        {a.role}
                      </span>
                    </td>
                    <td>
                      <code className="mono">{a.fingerprint}</code>
                    </td>
                    <td>
                      <code className="mono" title={a.rid}>
                        {shortId(a.rid, 10, 6)}
                      </code>
                    </td>
                    <td>{a.depth}</td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {a.grant || <span className="muted">—</span>}
                    </td>
                    <td>
                      {a.lastOp}{' '}
                      <span style={{ color: a.lastDecision === 'allow' ? '#22c55e' : '#ef4444' }}>
                        {a.lastDecision === 'allow' ? '✓' : '✗'}
                      </span>
                    </td>
                    <td>
                      <span title={absoluteFromMs(a.lastSeen)}>{relativeFromMs(a.lastSeen)}</span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function LiveToggle({
  live,
  onToggle,
  count,
}: {
  live: boolean
  onToggle: () => void
  count: number
}) {
  return (
    <button
      onClick={onToggle}
      title={live ? 'Auto-refreshing — click to pause' : 'Paused — click to resume'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        borderRadius: 8,
        border: '1px solid #2a3145',
        background: '#141821',
        color: '#e6e8ee',
        font: 'inherit',
        cursor: 'pointer',
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 8,
          background: live ? '#22c55e' : '#8b93a7',
          boxShadow: live ? '0 0 0 3px rgba(34,197,94,0.25)' : 'none',
        }}
      />
      {live ? 'Live' : 'Paused'}
      <span className="muted" style={{ marginLeft: 4 }}>
        {count} agent{count === 1 ? '' : 's'}
      </span>
    </button>
  )
}
