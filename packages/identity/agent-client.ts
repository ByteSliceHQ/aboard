/**
 * Reference **agent client** for the BetterAuth agent-auth protocol — the code an
 * agent runs to register ITSELF and obtain an aboard capability token (macaroon),
 * with no human in the loop. Reverse-engineered from @better-auth/agent-auth and
 * verified end-to-end (see verify-roundtrip.ts).
 *
 * The chain:
 *   1. sign up a user            POST /api/auth/sign-up/email   (-> session cookie)
 *   2. create a host (Ed25519)   POST /api/auth/host/create     (session; host budget)
 *   3. register an agent         POST /api/auth/agent/register   (Bearer host+jwt;
 *                                  the agent's public key rides in the host JWT as
 *                                  the `agent_public_key` claim)
 *   4. request capabilities      POST /api/auth/agent/request-capability
 *                                  (Bearer agent+jwt; auto-granted from host budget)
 *   5. mint the macaroon         POST /api/onboarding/sessions   (Bearer agent+jwt
 *                                  aud = the mint capability's location)
 *
 * JWT facts (from the plugin source): header `typ` is `host+jwt`/`agent+jwt`,
 * `alg` EdDSA. Host JWT: `iss`=hostId, `aud`=origin, `jti`, plus `agent_public_key`.
 * Agent JWT: `sub`=agentId, `aud`=origin (or the capability `location` when the
 * `capabilities` claim names exactly one), `jti`.
 */
import { generateKeyPair, exportJWK, SignJWT, type JWK } from "jose";

export interface AgentClientOptions {
  /** Identity/aboard origin, e.g. http://localhost:3000. */
  origin: string;
  /** Capabilities the agent wants (must be within the host's default budget). */
  capabilities: string[];
  /** The mint capability's location (aud for the mint JWT). Default: `${origin}/api/onboarding/sessions`. */
  mintLocation?: string;
  /** Agent display name. */
  name?: string;
}

interface KeyPairJWK {
  privateKey: CryptoKey;
  publicJwk: JWK;
}

async function ed25519(kid: string): Promise<KeyPairJWK> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: "EdDSA", use: "sig" };
  return { privateKey, publicJwk };
}

function rand(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

async function jsonOrThrow(res: Response, step: string): Promise<any> {
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${step} failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

/** A registered agent able to sign request JWTs and mint a macaroon. */
export interface RegisteredAgent {
  agentId: string;
  hostId: string;
  /** Sign an `agent+jwt` for a request. `aud` defaults to the origin. */
  signJwt(opts?: { aud?: string; capabilities?: string[]; ttl?: number }): Promise<string>;
  /** Exchange identity for an aboard capability token (root macaroon). */
  mintMacaroon(): Promise<string>;
}

export async function registerAgent(opts: AgentClientOptions): Promise<RegisteredAgent> {
  const origin = opts.origin.replace(/\/$/, "");
  const mintLocation = opts.mintLocation ?? `${origin}/api/onboarding/sessions`;
  const name = opts.name ?? "demo-agent";

  // 1+2. Dynamic host + autonomous agent registration in one shot. No user, no
  //   host/create: the host JWT carries BOTH the host public key (so the server
  //   can create the host on the fly, userId=null → autonomous) and the agent
  //   public key (`agent_public_key`, which becomes the agent's key). The host's
  //   budget = the server's `defaultHostCapabilities`.
  const hostKid = `host-${rand().slice(0, 8)}`;
  const host = await ed25519(hostKid);
  const agent = await ed25519(`agent-${rand().slice(0, 8)}`);
  const hostJwt = await new SignJWT({
    host_public_key: host.publicJwk,
    agent_public_key: agent.publicJwk,
    host_name: "demo-host",
  })
    .setProtectedHeader({ alg: "EdDSA", typ: "host+jwt", kid: hostKid })
    .setIssuer(hostKid) // host doesn't exist yet — iss is the key id
    .setAudience(origin)
    .setJti(rand())
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(host.privateKey);

  // 3. Register (autonomous). The server creates the host + agent, both active.
  const regRes = await fetch(`${origin}/api/auth/agent/register`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${hostJwt}`, origin },
    body: JSON.stringify({ name, mode: "autonomous", capabilities: opts.capabilities }),
  });
  const regBody = await jsonOrThrow(regRes, "agent/register");
  // Autonomous registration auto-grants the budgeted capabilities immediately
  // (regBody.agent_capability_grants are already "active") — no separate
  // request-capability / approval step needed.
  const agentId: string = regBody.agent_id ?? regBody.agent?.id ?? regBody.id;
  const hostId: string | undefined = regBody.host_id ?? regBody.agent?.hostId;
  if (!agentId) throw new Error(`register: no agent id in ${JSON.stringify(regBody)}`);

  const signJwt: RegisteredAgent["signJwt"] = async (o = {}) => {
    const jwt = new SignJWT(o.capabilities ? { capabilities: o.capabilities } : {})
      .setProtectedHeader({ alg: "EdDSA", typ: "agent+jwt" })
      .setSubject(agentId)
      .setAudience(o.aud ?? origin)
      .setJti(rand())
      .setIssuedAt()
      .setExpirationTime(`${o.ttl ?? 120}s`);
    if (hostId) jwt.setIssuer(hostId);
    return jwt.sign(agent.privateKey);
  };

  const mintMacaroon: RegisteredAgent["mintMacaroon"] = async () => {
    // No `capabilities` claim: getAgentSession returns ALL active grants
    // (capabilityGrants = active DB grants ∩ JWT capabilities claim), so aboard's
    // rootAuthority sees the full set. aud = origin (accepted by the verifier).
    const jwt = await signJwt({ aud: origin });
    const res = await fetch(mintLocation, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${jwt}`, origin },
    });
    const body = await jsonOrThrow(res, "mint (POST /sessions)");
    if (!body.capabilityToken) throw new Error(`mint: no capabilityToken in ${JSON.stringify(body)}`);
    return body.capabilityToken as string;
  };

  return { agentId, hostId: hostId ?? "", signJwt, mintMacaroon };
}
