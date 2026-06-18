/**
 * Example: a self-contained "Swirls" agent-onboarding server using the v0.1
 * spec — identity verification, a machine-readable descriptor, artifacts, a
 * stuck webhook, and the admin read endpoint.
 *
 *   bun run examples/server.ts
 *
 * Discover the flow:
 *   curl http://localhost:4319/.well-known/agent-onboarding          # JSON descriptor
 *   curl http://localhost:4319/.well-known/agent-onboarding/default  # markdown prompt
 *
 * Then drive it with the example agent:
 *   bun run examples/agent.ts
 */
import { aboard } from '../src/index'
import { sqliteAdapter } from '../src/adapters/sqlite'

const PORT = Number(process.env.PORT ?? 4319)
const ORIGIN = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`
// In production this is a real auth.md / OAuth access token. For the demo we
// accept one well-known token (handed out by the /auth.md route below).
const DEMO_TOKEN = process.env.SWIRLS_DEMO_TOKEN ?? 'demo-agent-token'
const ADMIN_TOKEN = process.env.ABOARD_ADMIN_TOKEN ?? 'demo-admin-token'

// A tiny fake "Swirls" backend the onboarding steps actually operate on, so the
// flow does observable work rather than just marking steps done.
const swirls = {
  orgs: new Map<string, unknown>(),
  projects: new Map<string, unknown>(),
}

const ab = aboard({
  database: sqliteAdapter(process.env.ABOARD_DB ?? ':memory:'),
  secret: process.env.ABOARD_SECRET ?? 'dev-secret-change-me',
  name: 'Swirls',
  baseUrl: ORIGIN,
  adminToken: ADMIN_TOKEN,
  auth: {
    discovery: `${ORIGIN}/auth.md`,
    description: "Send the user's Swirls access token as a Bearer token when starting the session.",
  },
  // Establish identity from the incoming access token. Production code would
  // verify an auth.md / OAuth token (signature, audience, expiry) here.
  verifyIdentity: (token) => {
    if (token !== DEMO_TOKEN) return null
    return { subject: 'user_demo', agentProvider: 'anthropic', scopes: ['onboard'] }
  },
  onStuck: { afterAttempts: 2, webhook: `${ORIGIN}/internal/stuck` },
  onEvent: (e) => console.log(`[event] ${e.type}${e.stepId ? ' ' + e.stepId : ''}`),
  steps: [
    {
      id: 'create_org',
      description: 'Provision the user\'s Swirls workspace. JSON body: { "name": string }.',
      run: ({ body, principal, setMetadata }) => {
        const name = (body as { name?: string } | undefined)?.name
        if (!name) throw new Error('Provide an org `name` in the JSON body.')
        const id = `org_${swirls.orgs.size + 1}`
        swirls.orgs.set(id, { id, name, owner: principal?.subject })
        setMetadata({ orgId: id })
        return { orgId: id, name }
      },
    },
    {
      id: 'create_project',
      description: 'Create the first project in the workspace. JSON body: { "project": string }.',
      run: ({ body, session, setMetadata }) => {
        const orgId = session.metadata.orgId
        if (!orgId) throw new Error('No workspace yet — complete create_org first.')
        const project = (body as { project?: string } | undefined)?.project
        if (!project) throw new Error('Provide a `project` name in the JSON body.')
        const id = `proj_${swirls.projects.size + 1}`
        swirls.projects.set(id, { id, orgId, name: project })
        setMetadata({ projectId: id })
        return { projectId: id }
      },
    },
    {
      id: 'starter_kit',
      description: 'Download the Swirls starter kit from the artifact URL, then call this step to acknowledge it.',
      artifact: {
        name: 'swirls-starter-kit',
        url: `${ORIGIN}/downloads/starter-kit.json`,
        description: 'Project scaffold and example .swirls files.',
      },
    },
    {
      id: 'deploy',
      description: 'Deploy the project with the Swirls CLI, then confirm. JSON body: { "confirmed": true }.',
      run: ({ body }) => {
        if ((body as { confirmed?: boolean } | undefined)?.confirmed !== true) {
          throw new Error('Run the deploy command, then call again with { "confirmed": true }.')
        }
        return { deployed: true, url: 'https://demo.swirls.dev' }
      },
    },
  ],
})

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const { pathname } = new URL(request.url)

    // App-owned routes the example serves itself (not part of aboard):
    if (pathname === '/auth.md') {
      return new Response(
        `# Swirls — Agent Registration (demo)\n\n` +
          `This demo skips real OAuth. Use the well-known demo access token:\n\n` +
          `    ${DEMO_TOKEN}\n\n` +
          `Present it as \`Authorization: Bearer ${DEMO_TOKEN}\` when you start an ` +
          `onboarding session, then follow ${ORIGIN}/.well-known/agent-onboarding/default.\n`,
        { headers: { 'content-type': 'text/markdown; charset=utf-8' } },
      )
    }
    if (pathname === '/downloads/starter-kit.json') {
      return Response.json({ files: ['swirls.config.json', 'examples/hello.swirls'], note: 'demo artifact' })
    }
    if (pathname === '/internal/stuck') {
      console.log('[stuck webhook]', await request.text())
      return new Response('ok')
    }

    // Everything else is handled by aboard.
    const res = await ab.handler(request)
    if (res.status === 404) return new Response('Not found', { status: 404 })
    return res
  },
})

console.log(`Swirls onboarding demo running at ${server.url}`)
console.log(`  registration (auth.md): ${ORIGIN}/auth.md`)
console.log(`  descriptor (JSON):      ${ORIGIN}/.well-known/agent-onboarding`)
console.log(`  prompt (markdown):      ${ORIGIN}/.well-known/agent-onboarding/default`)
console.log(`  demo access token:      ${DEMO_TOKEN}`)
