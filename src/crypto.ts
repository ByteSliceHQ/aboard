/**
 * Session token signing — HMAC-SHA256 over a `{ sid, exp }` payload using the
 * Web Crypto API (available in Bun, Node 20+, Deno, and the browser).
 *
 * A token looks like `<base64url-payload>.<base64url-signature>`. The payload
 * carries the session id and an expiry, so tokens are short-lived by default
 * and verification is constant-time and tamper-evident.
 *
 * NOTE: this is a *progress/session* token, not an identity token. Identity
 * (who the user/agent is) is established separately — typically by an
 * `auth.md`/OAuth access token verified via `config.verifyIdentity`.
 */

const encoder = new TextEncoder();

/** Default session-token lifetime: 24 hours. */
export const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24;

export interface SessionTokenPayload {
  /** Session id. */
  sid: string;
  /** Expiry, in seconds since the Unix epoch. */
  exp: number;
}

// The HMAC key is derived solely from `secret`, which is fixed for the life of
// the process — so import it once per secret rather than on every sign/verify
// (verification runs on every authenticated request).
const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    keyCache.set(secret, key);
  }
  return key;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export async function signSessionToken(
  sessionId: string,
  secret: string,
  ttlSeconds: number = DEFAULT_SESSION_TTL_SECONDS,
): Promise<string> {
  const payload: SessionTokenPayload = { sid: sessionId, exp: nowSeconds() + ttlSeconds };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const key = await importKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadB64));
  return `${payloadB64}.${Buffer.from(signature).toString("base64url")}`;
}

/**
 * Returns the session id if the token is valid, untampered, and unexpired;
 * otherwise `null`.
 */
export async function verifySessionToken(token: string, secret: string): Promise<string | null> {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const payloadB64 = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);

  let providedBytes: Uint8Array<ArrayBuffer>;
  try {
    const decoded = Buffer.from(providedSig, "base64url");
    // Copy into a fresh ArrayBuffer-backed view so the type satisfies BufferSource.
    providedBytes = new Uint8Array(decoded.byteLength);
    providedBytes.set(decoded);
  } catch {
    return null;
  }
  if (providedBytes.length === 0) return null;

  const key = await importKey(secret);
  const ok = await crypto.subtle.verify("HMAC", key, providedBytes, encoder.encode(payloadB64));
  if (!ok) return null;

  let payload: SessionTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as SessionTokenPayload;
  } catch {
    return null;
  }
  if (typeof payload?.sid !== "string" || typeof payload?.exp !== "number") return null;
  if (payload.exp <= nowSeconds()) return null; // expired

  return payload.sid;
}
