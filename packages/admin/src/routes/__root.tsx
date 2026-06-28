import type { ReactNode } from 'react'
import {
  Link,
  Outlet,
  createRootRoute,
  HeadContent,
  Scripts,
} from '@tanstack/react-router'
import { getConfig } from '../server/aboard'
import type { AboardConfig } from '../types'
import appCss from '../styles.css?url'

export const Route = createRootRoute({
  // Load the (non-secret) service config once for the whole app so the
  // connection indicator and "not configured" warning render everywhere.
  loader: async (): Promise<AboardConfig> => getConfig(),
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'aboard · admin' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  component: RootComponent,
})

function RootComponent() {
  const config = Route.useLoaderData()
  return (
    <RootDocument>
      <div className="app">
        <TopNav config={config} />
        <main className="main">
          {!config.configured && (
            <div className="banner banner-warn">
              ABOARD_ADMIN_TOKEN is not set. Admin API calls will fail until it
              is configured server-side.
            </div>
          )}
          <Outlet />
        </main>
      </div>
    </RootDocument>
  )
}

function TopNav({ config }: { config: AboardConfig }) {
  return (
    <header className="topnav">
      <div className="brand">
        <span className="brand-mark">aboard</span>
        <span className="brand-sep">·</span>
        <span className="brand-sub">admin</span>
      </div>
      <nav className="nav">
        <Link
          to="/"
          activeOptions={{ exact: true }}
          activeProps={{ className: 'nav-link nav-link-active' }}
          className="nav-link"
        >
          Sessions
        </Link>
        <Link
          to="/agents"
          activeProps={{ className: 'nav-link nav-link-active' }}
          className="nav-link"
        >
          Agents
        </Link>
        <Link
          to="/approvals"
          activeProps={{ className: 'nav-link nav-link-active' }}
          className="nav-link"
        >
          Approvals
        </Link>
        <Link
          to="/revocations"
          activeProps={{ className: 'nav-link nav-link-active' }}
          className="nav-link"
        >
          Revocations
        </Link>
      </nav>
      <div
        className={`conn ${config.configured ? 'conn-ok' : 'conn-warn'}`}
        title={config.configured ? 'Admin token configured' : 'No admin token'}
      >
        <span className="conn-dot" />
        <span className="conn-url">{config.aboardUrl}</span>
      </div>
    </header>
  )
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
