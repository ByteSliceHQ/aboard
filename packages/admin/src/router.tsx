import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

// TanStack Start discovers this factory (default export name: getRouter) to
// build a fresh router per request on the server and once on the client.
export function getRouter() {
  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
    // Loaders return ApiResult and render banners themselves, so a stale
    // error never needs to be retried automatically on every navigation.
    defaultStaleTime: 5_000,
  })
  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
