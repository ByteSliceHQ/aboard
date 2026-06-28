// Production server (Bun).
//
// `vite build` emits two things:
//   - dist/client/  — static assets (JS, CSS) referenced by the rendered HTML
//   - dist/server/server.js — a TanStack Start SSR handler: `{ fetch(req) }`
//
// This wraps both: static files are served straight from dist/client, and
// everything else is handed to the SSR fetch handler. Run with `bun run start`
// after `bun run build`.

// @ts-expect-error - generated at build time, no types emitted
import handler from './dist/server/server.js'

const clientDir = new URL('./dist/client/', import.meta.url)
const port = Number(process.env.PORT ?? 3001)

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url)

    // Serve a built static asset if the path maps to a real file.
    if (url.pathname !== '/') {
      const file = Bun.file(new URL(`.${url.pathname}`, clientDir))
      if (await file.exists()) {
        return new Response(file)
      }
    }

    // Otherwise let TanStack Start render via SSR.
    return handler.fetch(req)
  },
})

console.log(`aboard admin listening on http://localhost:${server.port}`)
