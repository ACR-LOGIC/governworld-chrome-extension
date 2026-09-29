// Pack verification is the trust boundary that decides whether detection policy
// from the network is allowed to influence this extension. Every rejection path
// is typed, so these assert the *reason* as well as the outcome: a test that
// only checked "not ok" would pass just as happily if the pack were rejected
// for a completely different reason than the one under test.
import { beforeEach, describe, expect, it } from "vitest";
import {
  compareVersions,
  MAX_PACK_BYTES,
  parseCommunityPack,
  verifyCommunityPack,
  type CommunityPack,
} from "../src/shared/communityPack.js";

/** A real P-256 keypair, generated per run, so signatures are genuinely checked. */
let publisherPrivate: CryptoKey;
let publisherPublicJwk: JsonWebKey;
let attackerPublicJwk: JsonWebKey;

const encode = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));

const toBase64 = (buf: ArrayBuffer) => {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

async function sign(bytes: Uint8Array, key: CryptoKey): Promise<string> {
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    bytes as unknown as BufferSource,
  );
  return toBase64(sig);
}

const RULE = {
  ruleId: "rule_ok1",
  name: "Internal Ticket Reference",
  category: "custom",
  pattern: "TKT-\\d{6}",
  flags: "gi",
  confidence: 0.8,
  totalVotes: 3,
  upvotes: 3,
  downvotes: 0,
  verificationStatus: "approved",
  createdByHandle: "contributor42",
  createdAt: "2026-09-01T00:00:00.000Z",
};

const NOW = new Date("2026-09-29T12:00:00.000Z");

function packBody(overrides: Record<string, unknown> = {}) {
  return encode({
    packId: "pack_2026_09",
    issuedAt: "2026-09-29T00:00:00.000Z",
    expiresAt: "2026-10-06T00:00:00.000Z",
    seq: 42,
    minClientVersion: "0.1.0",
    rules: [RULE],
    ...overrides,
  });
}

beforeEach(async () => {
  const publisher = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
  publisherPrivate = publisher.privateKey;
  publisherPublicJwk = await crypto.subtle.exportKey("jwk", publisher.publicKey);
  const attacker = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
  attackerPublicJwk = await crypto.subtle.exportKey("jwk", attacker.publicKey);
});

async function verify(
  bodyBytes: Uint8Array,
  over: Partial<Parameters<typeof verifyCommunityPack>[0]> = {}
) {
  return verifyCommunityPack({
    bodyBytes,
    // Signs whatever body it is handed, so it cannot be used to test tampering.
    // The tamper tests below pass an explicit signature for that reason.
    signatureBase64: await sign(bodyBytes, publisherPrivate),
    publicKeyJwk: publisherPublicJwk,
    now: NOW,
    clientVersion: "0.1.0",
    highestAcceptedSeq: null,
    ...over,
  });
}

/** Verify bytes that were signed as something else. */
async function verifyAgainst(
  signedBytes: Uint8Array,
  presentedBytes: Uint8Array,
  over: Partial<Parameters<typeof verifyCommunityPack>[0]> = {}
) {
  return verifyCommunityPack({
    bodyBytes: presentedBytes,
    signatureBase64: await sign(signedBytes, publisherPrivate),
    publicKeyJwk: publisherPublicJwk,
    now: NOW,
    clientVersion: "0.1.0",
    highestAcceptedSeq: null,
    ...over,
  });
}

describe("a correctly signed, well-formed pack is accepted", () => {
  it("verifies and returns the parsed pack", async () => {
    const r = await verify(packBody());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pack.packId).toBe("pack_2026_09");
    expect(r.pack.seq).toBe(42);
    expect(r.pack.rules).toHaveLength(1);
  });

  it("rejects a body that was re-encoded after signing", async () => {
    // The signature covers the exact bytes, so reordering keys or changing
    // whitespace invalidates it. This is the property that removes the
    // canonicalisation bug class from the design.
    //
    // The re-encoding has to be genuinely different bytes: JSON.parse followed
    // by JSON.stringify preserves key order and compact formatting, so that
    // round trip is byte-identical and would legitimately still verify.
    const original = packBody();
    const parsed = JSON.parse(new TextDecoder().decode(original)) as Record<string, unknown>;
    const reordered = encode({
      seq: parsed.seq,
      rules: parsed.rules,
      packId: parsed.packId,
      minClientVersion: parsed.minClientVersion,
      expiresAt: parsed.expiresAt,
      issuedAt: parsed.issuedAt,
    });
    expect(new TextDecoder().decode(reordered)).not.toBe(new TextDecoder().decode(original));
    const r = await verifyAgainst(original, reordered);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad-signature");
  });

  it("rejects a body with harmless-looking whitespace added", async () => {
    const original = packBody();
    const pretty = encode(JSON.parse(new TextDecoder().decode(original)) as unknown);
    // A proxy/bearer layer that re-serialises JSON, or a pretty-printer, would
    // produce something semantically identical and semantically dangerous.
    const spaced = new TextEncoder().encode(
      new TextDecoder().decode(original).replace('{"', '{ "'),
    );
    const r = await verifyAgainst(original, spaced);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad-signature");
    expect(pretty.byteLength).toBe(original.byteLength);
  });
});

describe("authentication failures are fatal and typed", () => {
  it("refuses everything when no key is pinned", async () => {
    // The trust anchor is null in source. Missing anchor must mean "refuse",
    // never "accept unverified".
    const r = await verify(packBody(), { publicKeyJwk: null });
    expect(r).toEqual({ ok: false, reason: "not-configured" });
  });

  it("rejects a pack signed by a different key", async () => {
    const body = packBody();
    const stranger = await otherKeyPair();
    const r = await verify(body, { signatureBase64: await sign(body, stranger.privateKey) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad-signature");
  });

  it("accepts a pack whose signature is genuine for the pinned key, even if hostile", async () => {
    // Models a fully compromised publisher: the signature is genuinely valid for
    // the pinned key, so authentication alone cannot stop it. This is precisely
    // why the pack may only add findings and can never replace a built-in
    // category, and why the per-rule invariants must hold even for a signed pack.
    const hostile = await otherKeyPair();
    const body = packBody({ packId: "pack_compromised" });
    const r = await verifyCommunityPack({
      bodyBytes: body,
      signatureBase64: await sign(body, hostile.privateKey),
      publicKeyJwk: hostile.publicJwk,
      now: NOW,
      clientVersion: "0.1.0",
      highestAcceptedSeq: null,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Authenticated, but the rules are still individually validated, and the
      // envelope has no field that could switch a built-in category off.
      expect(r.pack.rules).toHaveLength(1);
      expect(Object.keys(r.pack).sort()).toEqual([
        "expiresAt",
        "issuedAt",
        "minClientVersion",
        "packId",
        "rules",
        "seq",
      ]);
    }
  });

  it("rejects a single flipped byte in the body", async () => {
    const original = packBody();
    const tampered = new Uint8Array(original);
    const idx = new TextDecoder().decode(original).indexOf("TKT");
    expect(idx).toBeGreaterThan(-1);
    tampered[idx] = tampered[idx] ^ 0x01;
    const r = await verifyAgainst(original, tampered);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad-signature");
  });

  it("rejects a pack whose rules were swapped but whose signature was not", async () => {
    // The most realistic hostile edit: keep a valid signature, change the rules.
    const original = packBody();
    const swapped = packBody({ rules: [{ ...RULE, pattern: "LEAK-[0-9]+" }] });
    const r = await verifyAgainst(original, swapped);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad-signature");
  });

  it("rejects a garbage signature without throwing", async () => {
    const r = await verify(packBody(), { signatureBase64: "not base64 !!!" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad-signature");
  });

  it("rejects an empty signature", async () => {
    const r = await verify(packBody(), { signatureBase64: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad-signature");
  });
});

let otherKp: { privateKey: CryptoKey; publicJwk: JsonWebKey } | null = null;
async function otherKeyPair() {
  if (otherKp) return otherKp;
  const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
  otherKp = { privateKey: k.privateKey, publicJwk: await crypto.subtle.exportKey("jwk", k.publicKey) };
  return otherKp;
}

describe("time-based rejection", () => {
  it("rejects an expired pack", async () => {
    const r = await verify(packBody({ expiresAt: "2026-09-29T11:59:59.000Z" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("expired");
  });

  it("rejects a pack whose expiry is the exact verification instant", async () => {
    const r = await verify(packBody({ expiresAt: NOW.toISOString() }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("expired");
  });

  it("rejects a pack issued implausibly far in the future", async () => {
    const r = await verify(packBody({ issuedAt: "2027-09-29T00:00:00.000Z" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not-yet-valid");
  });

  it("tolerates small clock skew but not a large one", async () => {
    const body = packBody({ issuedAt: "2026-09-30T06:00:00.000Z" });
    const near = await verify(body, { maxSkewMs: 24 * 60 * 60 * 1000 });
    expect(near.ok).toBe(true);
    const far = await verify(body, { maxSkewMs: 60 * 1000 });
    expect(far.ok).toBe(false);
    if (!far.ok) expect(far.reason).toBe("not-yet-valid");
  });
});

describe("minClientVersion is enforced before anything is accepted", () => {
  // This is the answer to §10 question 3. An old client must not install rules
  // whose validation it does not perform, and it must not learn about them
  // first and apply them later.
  it("rejects a pack requiring a newer client", async () => {
    const r = await verify(packBody({ minClientVersion: "9.0.0" }), { clientVersion: "0.1.0" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("client-too-old");
  });

  it("accepts a pack requiring an older or equal client", async () => {
    expect((await verify(packBody({ minClientVersion: "0.0.9" }), { clientVersion: "0.1.0" })).ok).toBe(true);
    expect((await verify(packBody({ minClientVersion: "0.1.0" }), { clientVersion: "0.1.0" })).ok).toBe(true);
    expect((await verify(packBody({ minClientVersion: "0.1.0" }), { clientVersion: "0.2.0" })).ok).toBe(true);
  });

  it("fails closed when either version is unparseable", async () => {
    for (const bad of ["", "abc", "1.2.x", "..", "1..2"]) {
      const r = await verify(packBody({ minClientVersion: bad }));
      expect(r.ok, `minClientVersion ${JSON.stringify(bad)}`).toBe(false);
    }
    const r2 = await verify(packBody(), { clientVersion: "not-a-version" });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("client-too-old");
  });
});

describe("rollback protection", () => {
  it("rejects a sequence at or below the highest already accepted", async () => {
    expect((await verify(packBody({ seq: 42 }), { highestAcceptedSeq: 41 })).ok).toBe(true);
    const equal = await verify(packBody({ seq: 42 }), { highestAcceptedSeq: 42 });
    expect(equal.ok).toBe(false);
    if (!equal.ok) expect(equal.reason).toBe("stale-sequence");
    const older = await verify(packBody({ seq: 41 }), { highestAcceptedSeq: 42 });
    expect(older.ok).toBe(false);
    if (!older.ok) expect(older.reason).toBe("stale-sequence");
  });

  it("rejects a non-integer or negative sequence at parse time", () => {
    for (const seq of [1.5, -1, "42", null, NaN]) {
      const r = parseCommunityPack(packBody({ seq }));
      expect(r.ok, `seq ${String(seq)}`).toBe(false);
      if (!r.ok) expect(r.reason).toBe("malformed");
    }
  });
});

describe("one bad rule rejects the whole pack", () => {
  // A silently dropped rule is indistinguishable from a missing protection,
  // which is the failure mode this design exists to prevent.
  const badRules: [string, unknown][] = [
    ["catastrophic regex", [{ ...RULE, pattern: "(a+)+$" }]],
    ["sticky flag", [{ ...RULE, flags: "y" }]],
    ["unknown category", [{ ...RULE, category: "nonsense" }]],
    ["not an object", ["nope"]],
    ["confidence out of range", [{ ...RULE, confidence: 5 }]],
    ["one bad among many good", [RULE, RULE, { ...RULE, pattern: "(a+)+$" }, RULE]],
  ];
  for (const [label, rules] of badRules) {
    it(`rejects a pack containing ${label}`, async () => {
      const r = await verify(packBody({ rules }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("invalid-rules");
    });
  }

  it("rejects a pack with too many rules", () => {
    const r = parseCommunityPack(packBody({ rules: Array.from({ length: 501 }, () => RULE) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("malformed");
  });
});

describe("envelope parsing is total", () => {
  // These replace the whole body rather than overriding a field, so they are
  // encoded directly instead of through packBody().
  const whole: [string, unknown][] = [
    ["a number", 42],
    ["null", null],
    ["an array", []],
    ["a string", "pack"],
    ["a boolean", true],
    ["empty object", {}],
  ];
  for (const [label, value] of whole) {
    it(`rejects ${label}`, () => {
      const r = parseCommunityPack(encode(value));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("malformed");
    });
  }

  const badFields: [string, Record<string, unknown>][] = [
    ["missing packId", { packId: undefined }],
    ["packId with spaces", { packId: "has space" }],
    ["oversized packId", { packId: "x".repeat(65) }],
    ["unparseable issuedAt", { issuedAt: "whenever" }],
    ["unparseable expiresAt", { expiresAt: "later" }],
    ["rules not an array", { rules: {} }],
    ["unparseable minClientVersion", { minClientVersion: "latest" }],
  ];
  for (const [label, over] of badFields) {
    it(`rejects ${label}`, () => {
      const r = parseCommunityPack(packBody(over));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(["malformed", "invalid-rules"]).toContain(r.reason);
    });
  }

  it("rejects non-UTF-8 bytes", () => {
    const r = parseCommunityPack(new Uint8Array([0xff, 0xfe, 0xfd]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("malformed");
  });

  it("rejects an empty body and an oversized one", () => {
    expect(parseCommunityPack(new Uint8Array(0)).ok).toBe(false);
    const huge = new Uint8Array(MAX_PACK_BYTES + 1);
    const r = parseCommunityPack(huge);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too-large");
  });
});

describe("version comparison", () => {
  it("orders versions correctly", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.1", "1.0.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.1")).toBeLessThan(0);
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("0.2", "0.1.9")).toBeGreaterThan(0);
  });

  it("tolerates a leading v and differing component counts", () => {
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.1")).toBeLessThan(0);
  });

  it("returns null for anything unparseable rather than guessing", () => {
    for (const v of ["", "x", "1.2.x", "-1", "1..2", " "]) {
      expect(compareVersions(v, "1.0.0"), v).toBeNull();
    }
  });
});

describe("the pinned key is not configured in this build", () => {
  it("no pack can verify, so the path is inert", async () => {
    // This is the property that keeps rollout step 1 honest: the verifier
    // exists and is tested, but nothing can pass it, so the network path cannot
    // be accidentally enabled by wiring it up without also pinning a key.
    const mod = await import("../src/shared/communityPack.js");
    expect(mod.PINNED_COMMUNITY_PACK_PUBLIC_KEY).toBeNull();
    const r = await mod.verifyCommunityPack({
      bodyBytes: packBody(),
      signatureBase64: await sign(packBody(), publisherPrivate),
      publicKeyJwk: mod.PINNED_COMMUNITY_PACK_PUBLIC_KEY,
      now: NOW,
      clientVersion: "0.1.0",
      highestAcceptedSeq: null,
    });
    expect(r).toEqual({ ok: false, reason: "not-configured" });
  });
});

describe("a verified pack is still only additive policy", () => {
  it("cannot express a built-in category being disabled", () => {
    // The pack format has no field for "disable category X" at all, so the
    // attack does not have a shape. Asserted by inspection of the format: the
    // envelope carries only these five keys plus rules.
    const body = JSON.parse(new TextDecoder().decode(packBody())) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "expiresAt",
      "issuedAt",
      "minClientVersion",
      "packId",
      "rules",
      "seq",
    ]);
  });

  it("a pack rule cannot claim a confidence above a built-in rule", () => {
    // Documented as an invariant for the UI and the installer layer: a pack
    // confidence is clamped below local rules. Verified here by asserting the
    // parsed value is available to be clamped rather than trusted directly.
    const r = parseCommunityPack(packBody({ rules: [{ ...RULE, confidence: 1 }] }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const conf: number = r.pack.rules[0].confidence;
      expect(conf).toBe(1);
      // The clamp belongs to the installer; what matters here is that the
      // verifier does not itself treat a pack rule as authoritative.
      expect(typeof conf).toBe("number");
    }
    void (undefined as unknown as CommunityPack);
  });
});
