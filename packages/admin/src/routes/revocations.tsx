import { createFileRoute } from '@tanstack/react-router'
import { getRevocations } from '../server/aboard'
import { relativeFromSeconds, absoluteFromMs, shortId } from '../lib/format'

export const Route = createFileRoute('/revocations')({
  loader: async () => getRevocations(),
  component: RevocationsPage,
})

function RevocationsPage() {
  const result = Route.useLoaderData()

  return (
    <section>
      <div className="page-header">
        <h1>Revocations</h1>
        <p className="muted">
          Revoking a session blacklists its root id; every macaroon in that
          lineage — including offline-derived sub-agent tokens — is dead.
        </p>
      </div>

      {!result.ok ? (
        <div className="banner banner-error">
          Cannot reach aboard service. {result.error}
        </div>
      ) : result.data.length === 0 ? (
        <div className="empty">The blacklist is empty.</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Kind</th>
                <th>Reason</th>
                <th>Revoked</th>
                <th>Required until</th>
              </tr>
            </thead>
            <tbody>
              {result.data.map((r) => (
                <tr key={`${r.kind}:${r.key}`}>
                  <td>
                    <code className="mono" title={r.key}>
                      {shortId(r.key, 10, 6)}
                    </code>
                  </td>
                  <td>
                    <span className="badge badge-kind">{r.kind}</span>
                  </td>
                  <td>{r.reason ? r.reason : <span className="muted">—</span>}</td>
                  <td>
                    <span title={absoluteFromMs(r.revokedAt * 1000)}>
                      {relativeFromSeconds(r.revokedAt)}
                    </span>
                  </td>
                  <td>
                    {r.requiredUntil === null ? (
                      <span className="badge badge-forever">forever</span>
                    ) : (
                      <span title={absoluteFromMs(r.requiredUntil * 1000)}>
                        {relativeFromSeconds(r.requiredUntil)}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
