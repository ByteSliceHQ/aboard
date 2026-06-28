# aboard · admin

An operator dashboard for the **aboard** macaroon-based capability-token
service. It is a thin frontend over the aboard service's HTTP admin API — it
never touches a database directly.

Built with **TanStack Start** (React, Vite-based): TanStack Router loaders for
data fetching and `createServerFn` server functions for every API call.

## What it does

- **Sessions** (`/`) — every onboarding session with its status, principal,
  and capability token (`rid` / `kid`). Each active session has a **Revoke**
  button. Revoking blacklists the session's macaroon root id (`rid`), which
  kills the entire delegation lineage — including offline-derived sub-agent
  tokens — and flips the session to `abandoned` ("revoked").
- **Revocations** (`/revocations`) — the blacklist: revoked key, kind
  (`rid` / `tid`), reason, when it was revoked, and how long it must stay
  blacklisted (or `forever`).
- A connection indicator in the top nav shows the configured `ABOARD_URL`.
- **Graceful degradation** — if the aboard service is unreachable or the admin
  token is unset, the app still builds, loads, and renders a clear banner
  instead of crashing.

## Security

The admin bearer token (`ABOARD_ADMIN_TOKEN`) is read from server-side
`process.env` and used **only** inside `createServerFn` handlers, which run
exclusively on the server. It is never sent to the browser.

## Environment variables

All are read server-side only.

| Variable             | Default                 | Description                                                        |
| -------------------- | ----------------------- | ------------------------------------------------------------------ |
| `ABOARD_URL`         | `http://localhost:3000` | Origin of the aboard service.                                      |
| `BASE_PATH`          | `/api/onboarding`       | Path the admin API is mounted at. Calls go to `${ABOARD_URL}${BASE_PATH}`. |
| `ABOARD_ADMIN_TOKEN` | _(none)_                | Bearer token for admin calls. **Required** for any call to succeed. |
| `PORT`               | `3001`                  | Port for the production server (`bun run start`).                  |

Copy `.env.example` to `.env` and fill in `ABOARD_ADMIN_TOKEN`. Bun loads
`.env` automatically.

## Commands

```sh
# Install (from the repo root — this is a workspace package)
bun install

# Dev server with HMR on http://localhost:3001
bun run --cwd packages/admin dev

# Type-check
bun run --cwd packages/admin typecheck

# Production build -> dist/client + dist/server
bun run --cwd packages/admin build

# Serve the production build on http://localhost:3001 (PORT overrides)
bun run --cwd packages/admin start
```

From inside `packages/admin/` you can drop the `--cwd packages/admin` and run
`bun run dev`, `bun run build`, etc.

## API contract

The app calls these endpoints at `${ABOARD_URL}${BASE_PATH}` with
`Authorization: Bearer ${ABOARD_ADMIN_TOKEN}`:

- `GET  /sessions` → `{ sessions: Session[] }`
- `GET  /revocations` → `{ revocations: Revocation[] }`
- `POST /sessions/:id/revoke` → `{ ok: true, status: "abandoned" }`

(`GET /sessions/:id` for session detail/events is part of the contract but not
yet surfaced in the UI.)

## How the production build is served

`vite build` emits `dist/client/` (static assets) and `dist/server/server.js`
(a TanStack Start SSR fetch handler — `{ fetch(req) }`, not a standalone
listener). `serve.ts` wraps both with `Bun.serve`: static files are served from
`dist/client`, everything else is handed to the SSR handler. `bun run start`
runs it.
