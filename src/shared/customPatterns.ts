// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { isRecord } from "./types.js";
import { isCategory } from "./settings.js";
import { isSafeRegex } from "./wizardAnalyzer.js";
import {
  isValidAadhaar,
  isValidAustralianTfn,
  isValidCanadianSin,
  isValidCpf,
  isValidCusip,
  isValidDea,
  isValidIsin,
  isValidItin,
  isValidLoinc,
  isValidMbi,
  isValidNhsNumber,
  isValidNpi,
  isValidPanIndia,
  isValidSedol,
  isValidSsn,
  luhnValid,
} from "../validators/index.js";
import type { FindingCategory } from "./types.js";

/**
 * Custom user-authored detection patterns for the Logic Wizard.
 *
 * A CustomPattern is a user-approved regex + category binding that integrates
 * into the existing detection pipeline without creating a second engine.
 *
 * Privacy invariants enforced here:
 *   - Raw example text is NEVER stored in a CustomPattern.
 *   - Contribution payloads strip identity and timestamp fields.
 *   - Community tokens live in chrome.storage.session (not at rest).
 */

export type CustomPatternCategory = FindingCategory | "custom";

export type ContributionStatus =
  | "local_only"
  | "submitted"
  | "under_review"
  | "accepted"
  | "rejected";

export interface CustomPattern {
  /** Stable per-device UUID. Never sent as part of a contribution. */
  id: string;
  /** User-visible label (1–80 chars). */
  name: string;
  /** Which category lane this pattern serves. */
  category: CustomPatternCategory;
  /** Regex source string (max 512 chars, user-reviewed). */
  pattern: string;
  /** Allowed flags: g, i, m only. */
  flags: string;
  /** Which capture group holds the sensitive value (0 = full match). */
  captureGroup: number;
  /** 0..1 — user-set after testing. */
  confidence: number;
  /** Optional nearby-keyword hints (max 10 items, max 40 chars each). */
  contextCues?: string[];
  /** Optional length bounds for the captured value. */
  minLength?: number;
  maxLength?: number;
  /** ISO-8601 creation timestamp. Never sent as part of a contribution. */
  createdAt: string;
  /** "local" = wizard-authored; "community" = received via rule update. */
  source: "local" | "community";
  /** Lifecycle tracking for the optional contribution flow. */
  contributionStatus: ContributionStatus;
  /** Server-assigned ID returned after a successful contribution POST. */
  contributionId?: string;
}

/** Lightweight free-account metadata. Tokens are kept in session storage. */
export interface CommunityAccount {
  /**
   * Opaque local identifier. Locally generated, NOT server-assigned: linking
   * performs no server transaction, so nothing here has been attested by one.
   */
  id: string;
  /** Always empty for a locally linked identity; a server-issued account would fill it. */
  email: string;
  /** Non-sensitive display label. Must not imply authentication. */
  displayLabel: string;
  /** When true, the extension may auto-retrieve community rule pack updates. */
  autoUpdateEnabled: boolean;
  /** Running count of contributed patterns (metadata only). */
  contributionCount: number;
  /** ISO-8601 timestamp of local linkage on this device. */
  linkedAt: string;
  /**
   * False for a locally linked identity. A server must reject any submission
   * from an unverified identity rather than trusting a flag the client set.
   */
  verified: boolean;
  /**
   * "local-unsigned" for a locally linked identity, "server-issued" once a real
   * backend has authenticated one. Present so the distinction survives in
   * storage and can be enforced server-side rather than inferred from the UI.
   */
  authority: "local-unsigned" | "server-issued";
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage keys
// ─────────────────────────────────────────────────────────────────────────────

export const CUSTOM_PATTERNS_KEY = "customPatterns";
export const COMMUNITY_ACCOUNT_KEY = "communityAccount";
/**
 * Community token lives in session storage (never persisted at rest), mirroring
 * the gateway API key pattern already established in the extension.
 */
export const COMMUNITY_TOKEN_SESSION_KEY = "communityToken";

// ─────────────────────────────────────────────────────────────────────────────
// Validation constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_PATTERN_SOURCE = 512;
const MAX_PATTERN_NAME = 80;
const ALLOWED_FLAGS = /^[gim]*$/;
const MAX_CONTEXT_CUES = 10;
const MAX_CUE_LENGTH = 40;
const MAX_PATTERNS = 200;

/**
 * Server-issued community token format: gw_free_<32 alphanum chars>.
 *
 * Retained only for validating a token a real backend would issue. Nothing in
 * the extension mints one any more: linkFreeCommunityAccount() performs no
 * server transaction, so it cannot be handed a credential.
 */
export const COMMUNITY_TOKEN_RE = /^gw_free_[A-Za-z0-9]{32}$/;

const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Random identifier from a CSPRNG, with modulo-rejection sampling.
 *
 * `chars[floor(Math.random() * n)]` is biased: Math.random is not uniform over
 * bits, and the bias is worst for the largest alphabets. Rejection sampling
 * discards the tail of the range so every character is equally likely, which
 * matters for a value that is used as a unique handle.
 */
function randomAlphanumeric(length: number): string {
  const alphabet = TOKEN_ALPHABET.length;
  // Largest multiple of the alphabet that fits in a byte; values at or above it
  // would bias toward the first characters, so they are rejected.
  const limit = 256 - (256 % alphabet);
  const out: string[] = [];
  const buf = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && out.length < length; i++) {
      if (buf[i] < limit) out.push(TOKEN_ALPHABET.charAt(buf[i] % alphabet));
    }
  }
  return out.join("");
}

function isValidFlags(flags: string): boolean {
  return ALLOWED_FLAGS.test(flags) && flags.length <= 4;
}

function isCustomCategory(value: unknown): value is CustomPatternCategory {
  return value === "custom" || isCategory(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser / validator
// ─────────────────────────────────────────────────────────────────────────────

export type ParseCustomPatternResult =
  | { ok: true; pattern: CustomPattern }
  | { ok: false; error: string };

export function parseCustomPattern(raw: unknown): ParseCustomPatternResult {
  if (!isRecord(raw)) return { ok: false, error: "Not an object" };

  if (typeof raw.id !== "string" || !/^[0-9a-f-]{36}$/.test(raw.id))
    return { ok: false, error: "id must be a UUID string" };

  if (
    typeof raw.name !== "string" ||
    raw.name.length === 0 ||
    raw.name.length > MAX_PATTERN_NAME
  )
    return { ok: false, error: `name must be 1–${MAX_PATTERN_NAME} chars` };

  if (!isCustomCategory(raw.category))
    return { ok: false, error: `Unknown category: ${String(raw.category)}` };

  if (
    typeof raw.pattern !== "string" ||
    raw.pattern.length === 0 ||
    raw.pattern.length > MAX_PATTERN_SOURCE
  )
    return {
      ok: false,
      error: `pattern must be 1–${MAX_PATTERN_SOURCE} chars`,
    };

  if (typeof raw.flags !== "string" || !isValidFlags(raw.flags))
    return {
      ok: false,
      error: "flags must contain only g, i, m (no s, u, d, v)",
    };

  try {
    new RegExp(raw.pattern, raw.flags);
  } catch {
    return { ok: false, error: "pattern is not a valid regular expression" };
  }
  if (!isSafeRegex(raw.pattern, raw.flags)) {
    return { ok: false, error: "pattern is not safe to execute" };
  }

  const captureGroup =
    typeof raw.captureGroup === "number" &&
    Number.isInteger(raw.captureGroup) &&
    raw.captureGroup >= 0 &&
    raw.captureGroup <= 9
      ? raw.captureGroup
      : 0;

  if (
    typeof raw.confidence !== "number" ||
    !Number.isFinite(raw.confidence) ||
    raw.confidence < 0 ||
    raw.confidence > 1
  )
    return { ok: false, error: "confidence must be a number between 0 and 1" };

  let contextCues: string[] | undefined;
  if (raw.contextCues !== undefined) {
    if (
      !Array.isArray(raw.contextCues) ||
      raw.contextCues.length > MAX_CONTEXT_CUES ||
      !raw.contextCues.every(
        (c) => typeof c === "string" && c.length > 0 && c.length <= MAX_CUE_LENGTH
      )
    )
      return {
        ok: false,
        error: `contextCues must be up to ${MAX_CONTEXT_CUES} strings of max ${MAX_CUE_LENGTH} chars`,
      };
    contextCues = raw.contextCues as string[];
  }

  let minLength: number | undefined;
  let maxLength: number | undefined;
  if (raw.minLength !== undefined) {
    if (
      typeof raw.minLength !== "number" ||
      !Number.isInteger(raw.minLength) ||
      raw.minLength < 1
    )
      return { ok: false, error: "minLength must be a positive integer" };
    minLength = raw.minLength;
  }
  if (raw.maxLength !== undefined) {
    if (
      typeof raw.maxLength !== "number" ||
      !Number.isInteger(raw.maxLength) ||
      raw.maxLength < 1
    )
      return { ok: false, error: "maxLength must be a positive integer" };
    maxLength = raw.maxLength;
  }
  if (
    minLength !== undefined &&
    maxLength !== undefined &&
    minLength > maxLength
  )
    return { ok: false, error: "minLength must not exceed maxLength" };

  if (typeof raw.createdAt !== "string" || raw.createdAt.length === 0)
    return { ok: false, error: "createdAt must be a non-empty string" };

  if (raw.source !== "local" && raw.source !== "community")
    return { ok: false, error: "source must be 'local' or 'community'" };

  const validStatuses: ContributionStatus[] = [
    "local_only",
    "submitted",
    "under_review",
    "accepted",
    "rejected",
  ];
  const contributionStatus = validStatuses.includes(
    raw.contributionStatus as ContributionStatus
  )
    ? (raw.contributionStatus as ContributionStatus)
    : "local_only";

  const contributionId =
    typeof raw.contributionId === "string" &&
    raw.contributionId.length > 0 &&
    raw.contributionId.length <= 128
      ? raw.contributionId
      : undefined;

  return {
    ok: true,
    pattern: {
      id: raw.id,
      name: raw.name,
      category: raw.category as CustomPatternCategory,
      pattern: raw.pattern,
      flags: raw.flags,
      captureGroup,
      confidence: raw.confidence,
      ...(contextCues ? { contextCues } : {}),
      ...(minLength !== undefined ? { minLength } : {}),
      ...(maxLength !== undefined ? { maxLength } : {}),
      createdAt: raw.createdAt,
      source: raw.source,
      contributionStatus,
      ...(contributionId ? { contributionId } : {}),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Contribution payload — strips identity + timestamps, NEVER includes examples
// ─────────────────────────────────────────────────────────────────────────────

export interface ContributionPayload {
  name: string;
  category: CustomPatternCategory;
  pattern: string;
  flags: string;
  captureGroup: number;
  confidence: number;
  contextCues?: string[];
  minLength?: number;
  maxLength?: number;
}

/**
 * Result of screening a contribution before it leaves the device.
 */
export interface ContributionScreenResult {
  safe: true;
  payload: ContributionPayload;
}
export interface ContributionBlocked {
  safe: false;
  /** Field the offending literal was found in, for a message the user can act on. */
  field: string;
  /** Category of value found, never the value itself. */
  kind: string;
}

/**
 * Screen a contribution for literal personal data.
 *
 * PRIVACY.md promises "your contribution is the logic, not the source data", and
 * the example text never being stored in `CustomPattern` is what makes that
 * structurally true for the wizard's own output. It is not true for the fields
 * a human types: a user can paste `219-09-9999` straight into `pattern`, name a
 * real patient's MRN in a `name`, or leave a colleague's address as a context
 * cue. A structural argument about where examples live does not cover a
 * free-text field, so the free-text fields are screened directly.
 *
 * Detection is by checksum wherever one exists (Luhn, SSN, ITIN, DEA, MBI, NHS,
 * NPI, CUSIP, ISIN, SEDOL, LOINC, SIN, Aadhaar, PAN, TFN, CPF). A match is
 * overwhelmingly likely to be real data rather than logic: no useful detection
 * rule hard-codes a checksum-valid identifier, because that would only ever match
 * that one record. A false positive costs the user one edit to the pattern; a
 * false negative publishes someone's SSN to a public rule pack permanently.
 *
 * The value is never included in the result — only the field and the category —
 * so a rejection cannot itself leak the data it caught.
 */
export function screenContributionPayload(
  pattern: CustomPattern
): ContributionScreenResult | ContributionBlocked {
  const screened: Array<{ field: string; text: string }> = [
    { field: "name", text: pattern.name },
    { field: "pattern", text: pattern.pattern },
  ];
  for (const cue of pattern.contextCues ?? []) screened.push({ field: "contextCue", text: cue });

  for (const { field, text } of screened) {
    if (text.length === 0) continue;
    // Only the screening copy is folded. `text` itself, and the payload built
    // below, stay byte-for-byte what the user typed and tested.
    const scan = normaliseForScan(text);
    if (EMAIL_LITERAL_RE.test(scan)) return { safe: false, field, kind: "email address" };
    for (const m of scan.matchAll(DEA_LITERAL_RE)) {
      if (isValidDea(m[0])) return { safe: false, field, kind: "provider identifier" };
    }
    for (const m of scan.matchAll(NUMERIC_ID_RE)) {
      const digits = m[0].replace(/[./-]/g, "");
      if (digits.length < NUMERIC_ID_MIN_DIGITS || digits.length > NUMERIC_ID_MAX_DIGITS) continue;
      if (
        isValidSsn(digits) ||
        isValidItin(digits) ||
        isValidMbi(digits) ||
        isValidNhsNumber(digits) ||
        isValidNpi(digits) ||
        isValidCusip(digits) ||
        isValidIsin(digits) ||
        isValidSedol(digits) ||
        isValidLoinc(digits) ||
        isValidCanadianSin(digits) ||
        isValidAadhaar(digits) ||
        isValidPanIndia(digits) ||
        isValidAustralianTfn(digits) ||
        isValidCpf(digits) ||
        /^\d{13,19}$/.test(digits) && luhnValid(digits)
      ) {
        return { safe: false, field, kind: "government or provider identifier" };
      }
    }
  }
  return { safe: true, payload: buildContributionPayload(pattern) };
}

const EMAIL_LITERAL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/u;
/**
 * DEA registration numbers are letter-prefixed, so the digit-run scan misses
 * them; the checksum is still what confirms the value is a real identifier.
 */
const DEA_LITERAL_RE = /\b[A-Za-z][A-Za-z0-9]{8,10}\b/g;
/**
 * Candidate identifier runs: digits, optionally separated by punctuation.
 *
 * The separator matters. SSNs and payment cards are habitually written
 * `219-09-9999` and `4111 1111 4111 1111`, so a scan for a *contiguous* run of
 * six or more digits never sees them and passes them straight through. The
 * separators are stripped before the checksum runs, because the checksum is
 * defined over digits.
 *
 * Structure is not matched: a quantifier or character class (`\d{3}`,
 * `[0-9]{10}`, `\d{6,19}`) leaves digit groups too short to reach the length
 * floor, so rules that are purely structural still pass.
 *
 * Every separator here is either a plain hyphen produced by `normaliseForScan`
 * or a dot or solidus, which it does not fold, so dot- and slash-separated
 * identifiers are still seen as one run.
 */
const NUMERIC_ID_RE = /-?\d[\d./-]{4,24}\d|\d{6,19}/g;
const NUMERIC_ID_MIN_DIGITS = 6;
const NUMERIC_ID_MAX_DIGITS = 19;

/**
 * Fold a string into the ASCII shape the identifier checksums are defined over.
 *
 * An independent review flagged separator and normalisation gaps, and they were
 * real: the scan only understood ASCII digits with `-` or space between them.
 * Everything below passed straight through a screener that is supposed to be
 * the last thing standing between a user's real data and a public rule pack:
 *
 *   - Unicode decimal digits. NFKC folds the fullwidth forms (U+FF10-FF19),
 *     which is the case that actually occurs, from a system that renders digits
 *     in fullwidth style.
 *
 * Arabic-Indic, Devanagari and similar digits are deliberately NOT folded, and
 * this is a reasoned decision rather than an oversight. Every identifier
 * covered here - SSN, ITIN, MBI, NHS, NPI, CUSIP, ISIN, SEDOL, LOINC, SIN,
 * Aadhaar, PAN, TFN, CPF, and Luhn payment cards - is a format defined over
 * ASCII digits. A string written in another script is not a malformed instance
 * of any of them; it is simply not one of them, so there is no checksum to
 * satisfy and nothing for this screener to catch. Folding them would also
 * require a per-script zero-offset table, and `Number()` is not a shortcut
 * here: it parses only ASCII, so it returns NaN for U+0669 and would rewrite
 * the text to the literal string "NaN".
 *
 * Dot and solidus separated SSNs, which some legacy systems emit, are handled
 * in the identifier pattern itself rather than by folding those characters
 * here. Folding them broke the email check, which depends on a dot separating
 * the domain from the top-level name: `a.b@realco.com` was being folded to
 * `a-b@realco-com` and stopped looking like an address at all.
 *
 * This is applied ONLY to the screening copy. The submitted rule is the user's
 * own text, byte for byte, because normalising it would silently rewrite
 * someone's pattern - and a rewritten regex is a different rule from the one
 * they tested. Folding the scan copy does not widen what the detector will
 * later run: a pattern containing fullwidth digits still will not match ASCII
 * input.
 */
function normaliseForScan(text: string): string {
  return text.normalize("NFKC").replace(/[\s‐-―−⁃]+/g, "-");
}

/**
 * Build the payload that may be sent to GovernWorld for community review.
 *
 * The `id`, `createdAt`, and `source` fields are stripped. The wizard's example
 * text is held in memory only and is never part of `CustomPattern`, so it cannot
 * appear here — but the free-text fields the user types are screened by
 * `screenContributionPayload` before this is called.
 */
export function buildContributionPayload(
  pattern: CustomPattern
): ContributionPayload {
  const payload: ContributionPayload = {
    name: pattern.name,
    category: pattern.category,
    pattern: pattern.pattern,
    flags: pattern.flags,
    captureGroup: pattern.captureGroup,
    confidence: pattern.confidence,
  };
  if (pattern.contextCues) payload.contextCues = pattern.contextCues;
  if (pattern.minLength !== undefined) payload.minLength = pattern.minLength;
  if (pattern.maxLength !== undefined) payload.maxLength = pattern.maxLength;
  return payload;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chrome storage helpers
// ─────────────────────────────────────────────────────────────────────────────

export async function loadCustomPatterns(): Promise<CustomPattern[]> {
  const raw = await chrome.storage.local.get(CUSTOM_PATTERNS_KEY);
  const arr = raw[CUSTOM_PATTERNS_KEY];
  if (!Array.isArray(arr)) return [];
  const valid: CustomPattern[] = [];
  for (const item of arr) {
    const result = parseCustomPattern(item);
    if (result.ok) valid.push(result.pattern);
  }
  return valid;
}

export async function saveCustomPatterns(
  patterns: CustomPattern[]
): Promise<void> {
  // Hard cap to prevent storage quota exhaustion.
  const capped = patterns.slice(0, MAX_PATTERNS);
  await chrome.storage.local.set({ [CUSTOM_PATTERNS_KEY]: capped });
}

export async function loadCommunityAccount(): Promise<CommunityAccount | null> {
  const raw = await chrome.storage.local.get(COMMUNITY_ACCOUNT_KEY);
  const value = raw[COMMUNITY_ACCOUNT_KEY];
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.email !== "string" ||
    typeof value.displayLabel !== "string" ||
    typeof value.autoUpdateEnabled !== "boolean" ||
    typeof value.contributionCount !== "number" ||
    typeof value.linkedAt !== "string"
  )
    return null;
  // An account stored before these fields existed predates the notion of a
  // verified identity, so it defaults to unverified rather than being trusted
  // by omission. A client-set flag proves nothing; only a server that issued
  // the account can set `authority: "server-issued"`.
  const serverIssued = value.verified === true && value.authority === "server-issued";
  return {
    id: value.id,
    email: value.email,
    displayLabel: value.displayLabel,
    autoUpdateEnabled: value.autoUpdateEnabled === true,
    contributionCount: typeof value.contributionCount === "number" ? value.contributionCount : 0,
    linkedAt: value.linkedAt,
    verified: serverIssued,
    authority: serverIssued ? "server-issued" : "local-unsigned",
  };
}

export async function saveCommunityAccount(
  account: CommunityAccount
): Promise<void> {
  await chrome.storage.local.set({ [COMMUNITY_ACCOUNT_KEY]: account });
}

export async function clearCommunityAccount(): Promise<void> {
  await chrome.storage.local.remove(COMMUNITY_ACCOUNT_KEY);
  await chrome.storage.session.remove(COMMUNITY_TOKEN_SESSION_KEY);
}

export async function readCommunityToken(): Promise<string | null> {
  const raw = await chrome.storage.session.get(COMMUNITY_TOKEN_SESSION_KEY);
  const token = raw[COMMUNITY_TOKEN_SESSION_KEY];
  if (typeof token !== "string" || !COMMUNITY_TOKEN_RE.test(token)) return null;
  return token;
}

export async function writeCommunityToken(token: string): Promise<void> {
  await chrome.storage.session.set({ [COMMUNITY_TOKEN_SESSION_KEY]: token });
}

export async function saveCustomPattern(pattern: CustomPattern): Promise<CustomPattern[]> {
  const existing = await loadCustomPatterns();
  const idx = existing.findIndex((p) => p.id === pattern.id);
  if (idx >= 0) {
    existing[idx] = pattern;
  } else {
    existing.push(pattern);
  }
  await saveCustomPatterns(existing);
  return existing;
}

export async function deleteCustomPattern(id: string): Promise<CustomPattern[]> {
  const existing = await loadCustomPatterns();
  const filtered = existing.filter((p) => p.id !== id);
  await saveCustomPatterns(filtered);
  return filtered;
}

/**
 * Establish a local contributor identity.
 *
 * This is NOT authentication and must never be presented as such. It creates a
 * local identifier so the UI can label a contributor and count their rules; it
 * performs no server transaction, so the server has no record of it and cannot
 * have granted it any authority. The previous version generated a value named
 * `token` with `Math.random()` and a `community_user@governworld.local` address
 * and returned it as though an account had been linked, which is the worst of
 * both worlds: it looked authenticated in the UI and it was not.
 *
 * Two consequences are made explicit rather than implied:
 *   - the local id is generated with a CSPRNG, not Math.random, because it is
 *     still a unique handle and Math.random is not suitable for identifiers;
 *   - `verified` is false and `authority` is "local-unsigned", so a future
 *     backend can tell an unverified local identity from one it issued, and can
 *     refuse it. The extension is not the security boundary; the server must be.
 */
export async function linkFreeCommunityAccount(): Promise<CommunityAccount> {
  const id = `comm_${randomAlphanumeric(8)}`;
  const account: CommunityAccount = {
    id,
    email: "",
    displayLabel: `Local Contributor (${id.slice(0, 10)})`,
    autoUpdateEnabled: true,
    contributionCount: 0,
    linkedAt: new Date().toISOString(),
    verified: false,
    authority: "local-unsigned",
  };
  await saveCommunityAccount(account);
  return account;
}

export async function unlinkCommunityAccount(): Promise<void> {
  await clearCommunityAccount();
}

export interface CommunityRule {
  ruleId: string;
  name: string;
  category: CustomPatternCategory;
  pattern: string;
  flags: string;
  confidence: number;
  totalVotes: number;
  upvotes: number;
  downvotes: number;
  verificationStatus: string;
  createdByHandle: string;
  createdAt: string;
}

/**
 * Structural check for a rule arriving from the community service.
 *
 * Community rules are detection *policy*, not data: a bad pattern degrades
 * every scan the user runs afterwards, so the boundary deserves the same care as
 * the document pipeline. Each field is type- and range-checked and every regex
 * goes through the same isSafeRegex gate the local wizard uses, so a hostile or
 * merely broken server cannot install a catastrophic-backtracking pattern into
 * the detector.
 *
 * This is input validation, not authentication. It does not establish that the
 * service is GovernWorld's. Only a signature over the pack, verified against a
 * key pinned in the extension, can do that, and no such signature exists yet —
 * until it does, community rules must be treated as untrusted suggestions.
 */
export function isValidCommunityRule(raw: unknown): raw is CommunityRule {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as Record<string, unknown>;
  if (typeof r.ruleId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(r.ruleId)) return false;
  if (typeof r.name !== "string" || r.name.length === 0 || r.name.length > 120) return false;
  // An unknown category would reach code that switches on it; the detector
  // routes findings by category, so a typo'd value silently drops the finding
  // rather than showing it. Validate against the same set the wizard uses.
  if (!isCustomCategory(r.category)) return false;
  if (typeof r.pattern !== "string" || r.pattern.length === 0 || r.pattern.length > 500) return false;
  // Same allowlist as local rules. It is deliberately narrower than /^[gimsuy]*$/:
  // `y` (sticky) makes a match depend on the previous match's end position, so a
  // rule authored against one text could quietly match nothing in the next scan.
  if (typeof r.flags !== "string" || !isValidFlags(r.flags)) return false;
  if (typeof r.confidence !== "number" || !Number.isFinite(r.confidence) || r.confidence < 0 || r.confidence > 1) {
    return false;
  }
  for (const key of ["totalVotes", "upvotes", "downvotes"] as const) {
    const v = r[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1_000_000) return false;
  }
  if (typeof r.createdByHandle !== "string" || r.createdByHandle.length > 64) return false;
  if (typeof r.createdAt !== "string" || Number.isNaN(Date.parse(r.createdAt))) return false;
  if (typeof r.verificationStatus !== "string" || r.verificationStatus.length > 32) return false;
  // The pattern must be one the detector is willing to run.
  return isSafeRegex(r.pattern, r.flags);
}

export async function fetchCommunityRules(): Promise<CommunityRule[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch("https://community.governworld.acrlogic.com/v1/community/rules", {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const json: unknown = await res.json();
    if (typeof json !== "object" || json === null) return [];
    const rules = (json as Record<string, unknown>).rules;
    if (!Array.isArray(rules)) return [];
    // Drop anything that does not validate rather than failing the whole fetch:
    // one malformed rule should not cost the user the rest of the pack.
    return rules.filter(isValidCommunityRule).slice(0, 500);
  } catch {
    return [];
  }
}
