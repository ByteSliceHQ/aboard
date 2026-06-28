import { useState } from 'react'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { getSessions, revokeSession } from '../server/aboard'
import type { Session } from '../types'
import { relativeFromMs, absoluteFromMs, shortId } from '../lib/format'

export const Route = createFileRoute('/')({
  loader: async () => getSessions(),
  component: SessionsPage,
})

function SessionsPage() {
  const result = Route.useLoaderData()

  if (!result.ok) {
    return (
      <section>
        <PageHeader
          title="Sessions"
          subtitle="Onboarding sessions and their capability tokens."
        />
        <div className="banner banner-error">Cannot reach aboard service. {result.error}</div>
      </section>
    )
  }

  const sessions = result.data

  return (
    <section>
      <PageHeader
        title="Sessions"
        subtitle="Onboarding sessions and their capability tokens."
      />
      {sessions.length === 0 ? (
        <div className="empty">No sessions yet.</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Session</th>
                <th>Status</th>
                <th>Principal</th>
                <th>Capability</th>
                <th>Created</th>
                <th className="col-action" />
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <SessionRow key={s.id} session={s} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function SessionRow({ session }: { session: Session }) {
  const router = useRouter()
  const revoke = useServerFn(revokeSession)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onRevoke() {
    setPending(true)
    setError(null)
    try {
      const res = await revoke({ data: session.id })
      if (!res.ok) {
        setError(res.error)
        return
      }
      // Refetch all loaders so the row flips to "revoked" and the blacklist
      // picks up the new entry.
      await router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <tr>
      <td>
        <code className="mono" title={session.id}>
          {shortId(session.id)}
        </code>
      </td>
      <td>
        <StatusBadge status={session.status} />
      </td>
      <td>
        {session.principal ? (
          <div className="stack">
            <span>{session.principal.subject}</span>
            {session.principal.agentProvider && (
              <span className="muted">{session.principal.agentProvider}</span>
            )}
          </div>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td>
        {session.capability ? (
          <div className="stack">
            <code className="mono" title={session.capability.rid}>
              rid {shortId(session.capability.rid)}
            </code>
            <span className="muted">kid {session.capability.kid}</span>
          </div>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td>
        <span title={absoluteFromMs(session.createdAt)}>
          {relativeFromMs(session.createdAt)}
        </span>
      </td>
      <td className="col-action">
        {session.status === 'active' ? (
          <div className="stack-end">
            <button
              type="button"
              className="btn btn-danger"
              onClick={onRevoke}
              disabled={pending}
            >
              {pending ? 'Revoking…' : 'Revoke'}
            </button>
            {error && <span className="cell-error">{error}</span>}
          </div>
        ) : session.status === 'abandoned' ? (
          <span className="badge badge-revoked">revoked</span>
        ) : null}
      </td>
    </tr>
  )
}

function StatusBadge({ status }: { status: Session['status'] }) {
  const cls =
    status === 'active'
      ? 'badge badge-active'
      : status === 'completed'
        ? 'badge badge-completed'
        : 'badge badge-abandoned'
  return <span className={cls}>{status}</span>
}

function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="page-header">
      <h1>{title}</h1>
      <p className="muted">{subtitle}</p>
    </div>
  )
}
