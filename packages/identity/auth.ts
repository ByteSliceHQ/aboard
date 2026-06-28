/**
 * BetterAuth instance with the agent-auth plugin — the identity layer for the
 * aboard authz demo. Agents register here (Ed25519 keys) and receive signed JWTs;
 * aboard verifies those JWTs and turns the granted capabilities into a root
 * macaroon.
 *
 * Capabilities are derived from the same OpenAPI spec aboard gates `endpoint`
 * caveats against — so a granted capability maps to an operation the macaroon may
 * reach.
 */
import { betterAuth } from "better-auth";
import { Database } from "bun:sqlite";
import { agentAuth } from "@better-auth/agent-auth";
import { createFromOpenAPI } from "@better-auth/agent-auth/openapi";
import { spec, upstream, operationIds, apiName } from "./spec";

const IDENTITY_URL = process.env.IDENTITY_URL ?? "http://localhost:4000";
const ABOARD_URL = process.env.ABOARD_URL ?? "http://localhost:3000";

// Agent capabilities derived from WHATEVER OpenAPI spec the gate is pointed at.
const fromApi = createFromOpenAPI(spec as never, { baseUrl: upstream });

// A synthetic capability whose `location` is aboard's mint endpoint, so the
// agent can sign a JWT (aud = mint URL) that aboard accepts when minting a root.
const mintSession = {
  name: "mint_aboard_session",
  description: "Exchange agent identity for an aboard capability token (root macaroon).",
  location: `${ABOARD_URL}/api/onboarding/sessions`,
} as const;

export const auth = betterAuth({
  baseURL: IDENTITY_URL,
  secret: process.env.IDENTITY_SECRET ?? "dev-identity-secret-change-me-0123456789",
  database: new Database(process.env.IDENTITY_DB ?? "identity.sqlite"),
  emailAndPassword: { enabled: true },
  plugins: [
    agentAuth({
      ...fromApi,
      providerName: apiName,
      providerDescription: `${apiName} — exposed to AI agents via the Aboard gate.`,
      modes: ["delegated", "autonomous"],
      capabilities: [...(fromApi.capabilities ?? []), mintSession],
      // Self-service: an agent can register itself, then auto-grant capabilities
      // from the host budget (no human approval needed). The budget is every
      // operation the spec exposes, plus the mint capability — agents request the
      // subset they need, and delegation narrows from there.
      allowDynamicHostRegistration: true,
      // Autonomous agents have no human owner; give them a synthetic session user
      // so the session resolves (otherwise: autonomous_owner_required).
      resolveAutonomousUser: ({ agentId }: { agentId: string }) => ({
        id: `agent:${agentId}`,
        name: "Autonomous Agent",
        email: `${agentId}@agents.local`,
      }),
      defaultHostCapabilities: [...operationIds, "mint_aboard_session"],
    }),
  ],
});

export type Auth = typeof auth;
