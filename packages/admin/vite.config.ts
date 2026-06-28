import { defineConfig } from 'vite'
import tsConfigPaths from 'vite-tsconfig-paths'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'

export default defineConfig({
  server: {
    port: 3001,
  },
  plugins: [
    // Resolve imports using the paths defined in tsconfig.json.
    tsConfigPaths(),
    // TanStack Start: wires up SSR, server functions, and file-based routing.
    tanstackStart(),
    // React fast-refresh / JSX transform. Must come after tanstackStart().
    viteReact(),
  ],
})
