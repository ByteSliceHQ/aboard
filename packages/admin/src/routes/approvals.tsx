import { useState } from 'react'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { getApprovals, decideApproval } from '../server/aboard'
import type { ApprovalRequest } from '../types'
import { relativeFromSeconds, absoluteFromMs, shortId } from '../lib/format'

export const Route = createFileRoute('/approvals')({
  loader: async () => getApprovals(),
  component: ApprovalsPage,
})

function ApprovalsPage() {
  const result = Route.useLoaderData()

  return (
    <section>
      <div className="page-header">
        <h1>Approvals</h1>
        <p className="muted">
          Human-in-the-loop sign-off. A token carrying an <code>approval</code>{' '}
          caveat is held until someone here approves it, scoped to the session
          that requested it.
        </p>
      </div>

      {!result.ok ? (
        <div className="banner banner-error">
          Cannot reach aboard service. {result.error}
        </div>
      ) : result.data.length === 0 ? (
        <div className="empty">
          No approval requests yet. Delegate a token that requires approval, then
          have the agent attempt the gated action.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Operation</th>
                <th>Session</th>
                <th>Reason</th>
                <th>Requested</th>
                <th className="col-action" />
              </tr>
            </thead>
            <tbody>
              {result.data.map((a) => (
                <ApprovalRow key={a.id} approval={a} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function ApprovalRow({ approval }: { approval: ApprovalRequest }) {
  const router = useRouter()
  const decide = useServerFn(decideApproval)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onDecide(decision: 'approved' | 'denied') {
    setPending(true)
    setError(null)
    try {
      const res = await decide({ data: { id: approval.id, decision } })
      if (!res.ok) {
        setError(res.error)
        return
      }
      await router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  const badge =
    approval.status === 'pending'
      ? 'badge badge-active'
      : approval.status === 'approved'
        ? 'badge badge-completed'
        : 'badge badge-revoked'

  return (
    <tr>
      <td>
        <span className={badge}>{approval.status}</span>
      </td>
      <td className="mono">{approval.operation ?? <span className="muted">—</span>}</td>
      <td>
        {approval.sid ? (
          <code className="mono" title={approval.sid}>
            {shortId(approval.sid)}
          </code>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td>{approval.reason ?? <span className="muted">—</span>}</td>
      <td>
        <span title={absoluteFromMs(approval.requestedAt * 1000)}>
          {relativeFromSeconds(approval.requestedAt)}
        </span>
      </td>
      <td className="col-action">
        {approval.status === 'pending' ? (
          <div className="stack-end">
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="btn"
                onClick={() => onDecide('approved')}
                disabled={pending}
              >
                {pending ? '…' : 'Approve'}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => onDecide('denied')}
                disabled={pending}
              >
                Deny
              </button>
            </div>
            {error && <span className="cell-error">{error}</span>}
          </div>
        ) : (
          <span className="muted">
            {approval.decidedBy ? `by ${approval.decidedBy}` : 'decided'}
          </span>
        )}
      </td>
    </tr>
  )
}
