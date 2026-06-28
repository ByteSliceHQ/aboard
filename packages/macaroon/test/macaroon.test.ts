import { test, expect, describe } from "bun:test";
import {
  mint,
  attenuate,
  verify,
  parseToken,
  revocationKeys,
  createRegistry,
  hexKeystore,
  inspect,
  explain,
  type CaveatChecker,
  type Registry,
} from "../src/index";

const KEY = "a".repeat(64); // 32 bytes hex
const LOC = "https://api.example.com";

function keystore() {
  return hexKeystore(KEY);
}

// A toy `tool` checker so we can exercise the registry end-to-end.
const toolChecker: CaveatChecker = {
  check: (c, ctx) =>
    (c.allow as string[]).includes(ctx.tool as string)
      ? { ok: true }
      : { ok: false, reason: "tool_not_allowed" },
  describe: (c) => `may only call: ${(c.allow as string[]).join(", ")}`,
};
const registry: Registry = createRegistry({ tool: toolChecker });

describe("mint + verify", () => {
  test("a freshly minted root verifies", async () => {
    const ks = keystore();
    const token = await mint(ks, {
      location: LOC,
      caveats: [{ type: "exp", exp: 9_999_999_999 }],
    });
    const result = await verify(token, { now: 1000 }, { keystore: ks });
    expect(result.ok).toBe(true);
  });

  test("expired caveat denies with the right reason", async () => {
    const ks = keystore();
    const token = await mint(ks, { location: LOC, caveats: [{ type: "exp", exp: 500 }] });
    const result = await verify(token, { now: 1000 }, { keystore: ks });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("caveat_expired");
      expect(result.denied?.caveat.type).toBe("exp");
    }
  });

  test("wrong audience is rejected before caveats", async () => {
    const ks = keystore();
    const token = await mint(ks, { location: LOC, caveats: [] });
    const result = await verify(
      token,
      { now: 1000 },
      { keystore: ks, expectedLocation: "https://evil.com" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad_audience");
  });

  test("a token signed by a different key fails integrity", async () => {
    const token = await mint(keystore(), { location: LOC, caveats: [] });
    const other = hexKeystore("b".repeat(64));
    const result = await verify(token, { now: 1000 }, { keystore: other });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_capability_token");
  });
});

describe("attenuation (offline, monotonic)", () => {
  test("a narrower child still verifies and enforces the new caveat", async () => {
    const ks = keystore();
    const root = await mint(ks, {
      location: LOC,
      caveats: [{ type: "tool", allow: ["read", "write"] }],
    });
    const child = attenuate(root, [{ type: "tool", allow: ["read"] }]);

    // child can read...
    expect((await verify(child, { now: 1, tool: "read" }, { keystore: ks, registry })).ok).toBe(true);
    // ...but not write — the appended caveat narrows it.
    const denied = await verify(child, { now: 1, tool: "write" }, { keystore: ks, registry });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe("tool_not_allowed");
  });

  test("attenuation is keyless and synchronous (a sub-agent narrows offline)", async () => {
    const ks = keystore();
    const root = await mint(ks, { location: LOC, caveats: [{ type: "tool", allow: ["read", "write"] }] });
    // No await, no keystore — the whole point of offline delegation.
    const child = attenuate(root, [{ type: "exp", exp: 9_999_999_999 }]);
    const parsed = parseToken(child);
    expect(parsed.caveats).toHaveLength(2);
    expect(parsed.root.loc).toBe(LOC);
    // And it still verifies against the issuer.
    expect((await verify(child, { now: 1, tool: "read" }, { keystore: ks, registry })).ok).toBe(true);
  });

  test("tampering with a caveat segment breaks the tag", async () => {
    const ks = keystore();
    const root = await mint(ks, {
      location: LOC,
      caveats: [{ type: "tool", allow: ["read"] }],
    });
    // Forge a wider caveat by swapping the segment but keeping the tag.
    const parts = root.split(".");
    const forgedCaveat = Buffer.from(JSON.stringify({ type: "tool", allow: ["read", "admin"] })).toString(
      "base64url",
    );
    parts[2] = forgedCaveat;
    const forged = parts.join(".");
    const result = await verify(forged, { now: 1, tool: "admin" }, { keystore: ks, registry });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_capability_token");
  });

  test("dropping a caveat to widen authority breaks the tag", async () => {
    const ks = keystore();
    const root = await mint(ks, { location: LOC, caveats: [{ type: "tool", allow: ["read"] }] });
    const child = attenuate(root, [{ type: "tool", allow: [] }]); // useless child
    // Try to strip the child's restricting caveat back off, keeping the child tag.
    const parts = child.split(".");
    const stripped = [parts[0], parts[1], parts[2], parts[parts.length - 1]].join(".");
    const result = await verify(stripped, { now: 1, tool: "read" }, { keystore: ks, registry });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_capability_token");
  });
});

describe("fail-closed on unknown caveats (DESIGN P5)", () => {
  test("an unregistered caveat type denies", async () => {
    const ks = keystore();
    // Mint with a caveat the verifier's registry won't know.
    const token = await mint(ks, { location: LOC, caveats: [{ type: "from_the_future", x: 1 }] });
    const result = await verify(token, { now: 1 }, { keystore: ks }); // default registry: no such type
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("caveat_unknown");
  });
});

describe("revocation keys", () => {
  test("rid plus any tid predicate caveat", async () => {
    const ks = keystore();
    const root = await mint(ks, {
      location: LOC,
      rid: "k1.rootnonce",
      caveats: [{ type: "predicate", key: "tid", op: "eq", value: "branch_7" }],
    });
    expect(revocationKeys(root)).toEqual(["k1.rootnonce", "branch_7"]);
  });
});

describe("human-facing validation (DESIGN P11)", () => {
  test("inspect decodes a token to plain English, marked unverified", async () => {
    const ks = keystore();
    const token = await mint(ks, {
      location: LOC,
      caveats: [{ type: "tool", allow: ["read"] }, { type: "exp", exp: 9_999_999_999 }],
    });
    const ins = inspect(token, registry);
    expect(ins.verified).toBe(false);
    expect(ins.location).toBe(LOC);
    expect(ins.depth).toBe(2);
    expect(ins.caveats[0]!.describe).toContain("may only call: read");
  });

  test("explain renders a denial trace", async () => {
    const ks = keystore();
    const token = await mint(ks, { location: LOC, caveats: [{ type: "tool", allow: ["read"] }] });
    const result = await verify(token, { now: 1, tool: "write" }, { keystore: ks, registry });
    const text = explain(result);
    expect(text).toContain("DENIED");
    expect(text).toContain("tool_not_allowed");
  });
});
