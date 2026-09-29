// Community rule packs: format and verification.
//
// STEP 1 OF THE ROLLOUT IN docs/community-trust-model.md. The network path is
// still stubbed off in the service worker, and nothing here fetches anything.
// This module is the verification half, written and tested before it is
// connected to anything, so that the hard part is proven before it is wired up.
//
// WHY A SIGNATURE AND NOT JUST HTTPS
// TLS protects the bytes in transit between two endpoints. It does not bind the
// content to a publisher's decision, gives no offline verifiability, offers no
// revocation, and offers nothing at all if the origin is compromised - which is
// the case that matters, because the origin is what we are trying to
// distinguish from an impostor. A signature lets the extension verify a claim
// about the bytes independently of who delivered them.
//
// WHY THE SIGNATURE COVERS THE EXACT RECEIVED BYTES
// Signing a re-serialisation of the parsed object reintroduces a
// canonicalisation problem: key ordering, number formatting, and Unicode
// normalisation can all differ between the server's encoder and the client's,
// so the two can disagree about what was signed while each believes it is
// verifying the same document. Signing the raw body removes that entire class
// of bug. The server must sign exactly what it serves, and the client verifies
// exactly what it received.
//
// WHY EVERY FAILURE IS FATAL TO THE PACK
// A pack is a coherent policy unit. Dropping one bad rule from a validly signed
// pack would leave the user believing they have a protection they do not have,
// which is the same failure mode as a pack that never matches. So an invalid
// rule rejects the whole pack. A signature proves provenance, not quality, so a
// bad rule inside a signed pack is a publisher bug worth failing loudly on.

import { isValidCommunityRule, type CommunityRule } from "./customPatterns.js";

/** Hard ceiling on pack size, so a hostile or broken origin cannot exhaust memory. */
export const MAX_PACK_BYTES = 512 * 1024;

export interface CommunityPack {
  packId: string;
  issuedAt: string;
  expiresAt: string;
  seq: number;
  minClientVersion: string;
  rules: CommunityRule[];
}

export type PackRejection =
  | "not-configured"
  | "too-large"
  | "malformed"
  | "expired"
  | "not-yet-valid"
  | "client-too-old"
  | "bad-signature"
  | "stale-sequence"
  | "invalid-rules";

export type PackVerification =
  | { ok: true; pack: CommunityPack }
  | { ok: false; reason: PackRejection; detail?: string };

export interface VerifyOptions {
  /** The exact response body the publisher signed. Never a re-serialisation. */
  bodyBytes: Uint8Array;
  /** Detached signature, base64. Transported in a header, not in the body. */
  signatureBase64: string;
  /** Publisher public key pinned at build time. Null until a key is provisioned. */
  publicKeyJwk: JsonWebKey | null;
  now: Date;
  /** This extension's version, for the minClientVersion gate. */
  clientVersion: string;
  /** Highest seq already accepted for this packId, or null on first install. */
  highestAcceptedSeq: number | null;
  /** Maximum tolerated clock skew, so a wrong device clock cannot fail-open. */
  maxSkewMs?: number;
}

const DEFAULT_SKEW_MS = 24 * 60 * 60 * 1000;
const PACK_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_RULES_PER_PACK = 500;

/**
 * The publisher public key, pinned in source.
 *
 * Deliberately null. Until a key is actually provisioned and reviewed, there is
 * nothing to verify against, and the correct behaviour for a missing trust
 * anchor is to refuse everything rather than to fall back to an unverified
 * pack. Setting this to a real JWK is the step that makes step 3 possible, and
 * it is a visible diff that goes through review and a store release.
 */
export const PINNED_COMMUNITY_PACK_PUBLIC_KEY: JsonWebKey | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Compare dotted numeric versions. Returns a negative number when `a < b`.
 *
 * Deliberately minimal and total: any component that is not a run of digits
 * makes the version invalid rather than being coerced, because a pack whose
 * version field cannot be parsed must not be silently treated as compatible.
 * A leading "v" is tolerated because it is a common packaging convention.
 */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string): number[] | null => {
    const trimmed = v.trim().replace(/^v/i, "");
    if (!/^\d+(\.\d+)*$/.test(trimmed)) return null;
    return trimmed.split(".").map(Number);
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/** Structural check on the envelope. Does not authenticate anything. */
export function parseCommunityPack(bodyBytes: Uint8Array): PackVerification {
  if (bodyBytes.byteLength === 0) return { ok: false, reason: "malformed" };
  if (bodyBytes.byteLength > MAX_PACK_BYTES) return { ok: false, reason: "too-large" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "malformed" };

  const { packId, issuedAt, expiresAt, seq, minClientVersion, rules } = parsed;
  if (typeof packId !== "string" || !PACK_ID_RE.test(packId)) return { ok: false, reason: "malformed" };
  if (typeof issuedAt !== "string" || Number.isNaN(Date.parse(issuedAt))) {
    return { ok: false, reason: "malformed" };
  }
  if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) {
    return { ok: false, reason: "malformed" };
  }
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
    return { ok: false, reason: "malformed" };
  }
  if (typeof minClientVersion !== "string") return { ok: false, reason: "malformed" };
  if (compareVersions(minClientVersion, "0.0.0") === null) return { ok: false, reason: "malformed" };
  if (!Array.isArray(rules) || rules.length > MAX_RULES_PER_PACK) {
    return { ok: false, reason: "malformed" };
  }
  // Every rule is checked. One invalid rule rejects the whole pack, because a
  // silently dropped rule is indistinguishable from a missing protection.
  const invalid = rules.findIndex((r) => !isValidCommunityRule(r));
  if (invalid !== -1) {
    return { ok: false, reason: "invalid-rules", detail: `rule at index ${invalid}` };
  }

  return {
    ok: true,
    pack: {
      packId,
      issuedAt,
      expiresAt,
      seq,
      minClientVersion,
      rules: rules as CommunityRule[],
    },
  };
}

function base64ToBytes(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function verifySignature(
  bodyBytes: Uint8Array,
  signatureBase64: string,
  publicKeyJwk: JsonWebKey
): Promise<boolean> {
  const signature = base64ToBytes(signatureBase64);
  if (!signature) return false;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      publicKeyJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
  } catch {
    return false;
  }
  try {
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signature as unknown as BufferSource,
      bodyBytes as unknown as BufferSource
    );
  } catch {
    return false;
  }
}

/**
 * Verify a pack end to end. Every rejection is fail-closed and typed, so a
 * caller can tell the user why community rules are unavailable instead of
 * failing silently or, worse, installing the pack anyway.
 */
export async function verifyCommunityPack(options: VerifyOptions): Promise<PackVerification> {
  const { bodyBytes, signatureBase64, publicKeyJwk, now, clientVersion, highestAcceptedSeq } = options;
  const skew = options.maxSkewMs ?? DEFAULT_SKEW_MS;

  // No trust anchor means no pack. Never "accept unverified" as a fallback.
  if (!publicKeyJwk) return { ok: false, reason: "not-configured" };

  const parsed = parseCommunityPack(bodyBytes);
  if (!parsed.ok) return parsed;
  const { pack } = parsed;

  const expires = Date.parse(pack.expiresAt);
  if (!(expires > now.getTime())) return { ok: false, reason: "expired" };
  // A pack issued far in the future is either a broken clock or a pre-signed
  // pack being introduced early. Refuse rather than widen the window.
  if (Date.parse(pack.issuedAt) - skew > now.getTime()) return { ok: false, reason: "not-yet-valid" };

  // Answering §10 question 3: enforce BEFORE anything is staged or installed.
  // An old client must not accept rules whose validation it does not perform,
  // and a "rules unavailable" message is a better failure than a partially
  // understood policy set.
  const versionCmp = compareVersions(clientVersion, pack.minClientVersion);
  if (versionCmp === null) return { ok: false, reason: "client-too-old" };
  if (versionCmp < 0) return { ok: false, reason: "client-too-old" };

  // Authentication happens after the cheap structural gates and before any
  // state is touched. Nothing is persisted before this returns true.
  if (!(await verifySignature(bodyBytes, signatureBase64, publicKeyJwk))) {
    return { ok: false, reason: "bad-signature" };
  }

  if (highestAcceptedSeq !== null && pack.seq <= highestAcceptedSeq) {
    return { ok: false, reason: "stale-sequence" };
  }

  return { ok: true, pack };
}

const ACCEPTED_PACK_KEY = "communityPackAccepted";

/** Highest sequence already accepted for a pack, or null on first install. */
export async function readAcceptedSeq(packId: string): Promise<number | null> {
  const raw = await chrome.storage.local.get(ACCEPTED_PACK_KEY);
  const store = raw[ACCEPTED_PACK_KEY];
  if (!isRecord(store)) return null;
  const entry = store[packId];
  if (!isRecord(entry) || typeof entry.seq !== "number" || !Number.isInteger(entry.seq)) return null;
  return entry.seq;
}

/**
 * Record an accepted pack so a later, older pack cannot be rolled back in.
 * Only ever called after `verifyCommunityPack` returned ok.
 */
export async function recordAcceptedPack(pack: CommunityPack): Promise<void> {
  const raw = await chrome.storage.local.get(ACCEPTED_PACK_KEY);
  const current = isRecord(raw[ACCEPTED_PACK_KEY]) ? { ...raw[ACCEPTED_PACK_KEY] } : {};
  current[pack.packId] = { seq: pack.seq, expiresAt: pack.expiresAt };
  await chrome.storage.local.set({ [ACCEPTED_PACK_KEY]: current });
}
