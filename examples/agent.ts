/**
 * Example agent: onboards itself to the Swirls demo server by following the
 * aboard protocol — discover the descriptor, register, start a session,
 * then walk every step in order. This is what a real coding agent does after
 * reading the generated prompt.
 *
 *   bun run examples/server.ts    # in one terminal
 *   bun run examples/agent.ts     # in another
 */
const ORIGIN = process.env.TARGET ?? 'http://localhost:4319'

// The inputs an agent would infer from each step's description.
const INPUTS: Record<string, unknown> = {
  create_org: { name: 'Demo Org' },
  create_project: { project: 'first-project' },
  deploy: { confirmed: true },
}

interface Descriptor {
  name: string
  session_endpoint: string
  step_endpoint_template: string
  auth: { required: boolean; discovery?: string }
  steps: { id: string }[]
}

async function getDemoToken(discovery: string | undefined): Promise<string> {
  // The demo's auth.md embeds the token on a line that starts with whitespace.
  if (process.env.SWIRLS_DEMO_TOKEN) return process.env.SWIRLS_DEMO_TOKEN
  if (!discovery) return ''
  const md = await (await fetch(discovery)).text()
  const line = md.split('\n').find((l) => /^\s{2,}\S/.test(l))
  return line ? line.trim() : 'demo-agent-token'
}

async function main() {
  // 1. Discover the flow.
  const descriptor = (await (await fetch(`${ORIGIN}/.well-known/agent-onboarding`)).json()) as Descriptor
  console.log(`Onboarding "${descriptor.name}" — ${descriptor.steps.length} steps, auth required: ${descriptor.auth.required}`)

  // 2. Register / obtain an access token (per the auth.md discovery URL).
  const accessToken = descriptor.auth.required ? await getDemoToken(descriptor.auth.discovery) : ''
  if (descriptor.auth.required) console.log(`Registered via ${descriptor.auth.discovery} → access token acquired`)

  // 3. Start a session, presenting the access token.
  const startRes = await fetch(descriptor.session_endpoint, {
    method: 'POST',
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
  })
  const created = (await startRes.json()) as { sessionId?: string; sessionToken?: string; next?: string; error?: string }
  if (!startRes.ok || !created.sessionToken) throw new Error(`session start failed (${startRes.status}): ${JSON.stringify(created)}`)
  const sessionHeaders = { authorization: `Bearer ${created.sessionToken}` }
  console.log(`Session ${created.sessionId} started; first step: ${created.next}`)

  // 4. Walk the steps in order, following `next` each time.
  let next = created.next ?? null
  while (next) {
    const url = descriptor.step_endpoint_template.replace('{id}', next)
    const input = INPUTS[next]
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...sessionHeaders, ...(input ? { 'content-type': 'application/json' } : {}) },
      body: input ? JSON.stringify(input) : undefined,
    })
    const data = (await res.json()) as {
      status?: string
      next?: string | null
      error?: string
      progress?: { completed: number; total: number }
      artifact?: { name: string; url: string } | null
    }
    if (!res.ok) {
      console.error(`  ✗ ${next} failed (${res.status}): ${data.error}`)
      process.exit(1)
    }
    if (data.artifact) {
      const kit = await (await fetch(data.artifact.url)).json()
      console.log(`  ↓ fetched artifact "${data.artifact.name}":`, JSON.stringify(kit))
    }
    console.log(`  ✓ ${next} (${data.progress?.completed}/${data.progress?.total})`)
    next = data.next ?? null
  }

  console.log('Onboarding complete ✅')
}

main().catch((err) => {
  console.error('Agent error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
