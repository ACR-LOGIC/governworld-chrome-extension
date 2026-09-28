// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { isRecord } from "./types.js";
import { isCategory } from "./settings.js";
import { isSafeRegex } from "./wizardAnalyzer.js";
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
  /** Server-assigned account ID (opaque string). */
  id: string;
  email: string;
  /** Non-sensitive display label cached from the server. */
  displayLabel: string;
  /** When true, the extension may auto-retrieve community rule pack updates. */
  autoUpdateEnabled: boolean;
  /** Running count of contributed patterns (metadata only). */
  contributionCount: number;
  /** ISO-8601 timestamp of account linkage on this device. */
  linkedAt: string;
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

/** Community free-account token format: gw_free_<32 alphanum chars> */
export const COMMUNITY_TOKEN_RE = /^gw_free_[A-Za-z0-9]{32}$/;

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
 * Build the payload that may be sent to GovernWorld for community review.
 *
 * Critically: the `id`, `createdAt`, and `source` fields are stripped.
 * Raw example text was never stored in `CustomPattern` and therefore
 * cannot be present here — it was held in wizard memory only.
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
  return {
    id: value.id,
    email: value.email,
    displayLabel: value.displayLabel,
    autoUpdateEnabled: value.autoUpdateEnabled === true,
    contributionCount:
      typeof value.contributionCount === "number" ? value.contributionCount : 0,
    linkedAt: value.linkedAt,
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

export async function linkFreeCommunityAccount(): Promise<CommunityAccount> {
  const id = `comm_${crypto.randomUUID().slice(0, 8)}`;
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let rand = "";
  for (let i = 0; i < 32; i++) {
    rand += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  const token = `gw_free_${rand}`;
  const account: CommunityAccount = {
    id,
    email: "community_user@governworld.local",
    displayLabel: `Community Contributor (${id.slice(0, 10)})`,
    autoUpdateEnabled: true,
    contributionCount: 0,
    linkedAt: new Date().toISOString(),
  };
  await saveCommunityAccount(account);
  await writeCommunityToken(token);
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
    const json = await res.json();
    return Array.isArray(json.rules) ? json.rules : [];
  } catch {
    return [];
  }
}
