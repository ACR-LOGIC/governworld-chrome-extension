// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { isRecord } from "./types.js";
import type { FindingCategory, ScanMode } from "./types.js";
export type { FindingCategory, ScanMode };

export const ALL_CATEGORIES: FindingCategory[] = [
  "email",
  "phone",
  "ssn",
  "dob",
  "medical_record_number",
  "member_id",
  "npi",
  "dea",
  "mbi",
  "address",
  "payment_card",
  "secrets",
  "possible_name",
  "custom",
  "canadian_sin",
  "uk_nhs",
  "aadhaar",
  "pan_india",
  "australian_tfn",
  "cpf",
];

export type PresetId =
  | "custom"
  | "hipaa"
  | "pci"
  | "gdpr"
  | "developer"
  | "pipeda"
  | "uk_gdpr"
  | "india_dpdp"
  | "australia_privacy"
  | "brazil_lgpd";

export const PRESET_CATEGORIES: Record<Exclude<PresetId, "custom">, FindingCategory[]> = {
  hipaa: [
    "medical_record_number",
    "member_id",
    "npi",
    "dea",
    "mbi",
    "ssn",
    "dob",
    "address",
    "phone",
    "email",
    "possible_name",
  ],
  pci: [
    "payment_card",
    "ssn",
    "address",
    "phone",
    "email",
  ],
  gdpr: [
    "email",
    "phone",
    "address",
    "ssn",
    "dob",
    "possible_name",
    "medical_record_number",
    "member_id",
  ],
  developer: [
    "secrets",
    "email",
    "phone",
  ],
  pipeda: [
    "canadian_sin",
    "email",
    "phone",
    "address",
    "dob",
    "possible_name",
    "payment_card",
  ],
  uk_gdpr: [
    "uk_nhs",
    "email",
    "phone",
    "address",
    "dob",
    "possible_name",
    "medical_record_number",
    "member_id",
    "payment_card",
  ],
  india_dpdp: [
    "aadhaar",
    "pan_india",
    "email",
    "phone",
    "address",
    "dob",
    "possible_name",
    "payment_card",
  ],
  australia_privacy: [
    "australian_tfn",
    "email",
    "phone",
    "address",
    "dob",
    "possible_name",
    "payment_card",
  ],
  brazil_lgpd: [
    "cpf",
    "email",
    "phone",
    "address",
    "dob",
    "possible_name",
    "payment_card",
  ],
};

export const PRESET_LABELS: Record<PresetId, string> = {
  custom: "Custom",
  hipaa: "HIPAA (Healthcare)",
  pci: "PCI DSS (Payments)",
  gdpr: "GDPR (EU Personal Data)",
  developer: "Developer (API keys & secrets)",
  pipeda: "PIPEDA (Canada Personal Data)",
  uk_gdpr: "UK GDPR / NHS (United Kingdom)",
  india_dpdp: "DPDP Act (India Privacy)",
  australia_privacy: "Privacy Act (Australia)",
  brazil_lgpd: "LGPD (Brazil Personal Data)",
};

export const CONSENT_VERSION = "1";

export interface Settings {
  mode: ScanMode;
  enabledCategories: FindingCategory[];
  /** Minimum confidence (0..1) a finding must meet to be surfaced, per category. 0 = show all. */
  confidenceThresholds: Record<FindingCategory, number>;
  /** Padding (px) added around applied masks to prevent edge leakage. */
  maskPadding: number;
  /** When true, applied masks show a short placeholder label (e.g. [SSN]) in white on the block. */
  maskPlaceholders: boolean;
  /** When true, inspects pasted text on input fields and alerts before sensitive data leaks. */
  pasteGuardEnabled: boolean;
  /** Max visible characters scanned per page before a graceful stop. */
  maxVisibleChars: number;
  /** Per-node character cap. */
  maxNodeChars: number;
  /** Allowlisted gateway origin, or null when cloud is fully disabled. */
  gatewayOrigin: string | null;
  /** True once the user has seen the local-first disclosure at least once. */
  disclosureAcknowledged: boolean;
  /** True once the user has seen the "verify your work" accuracy notice. */
  verificationNoticeAcknowledged: boolean;
  /** When true, a scan that finds sensitive data raises a Chrome notification (optional permission). */
  notificationsEnabled: boolean;
  /** Human-readable label cached from the linked gateway account (never a secret). */
  accountLabel?: string;
  consentVersion: string;
  /** Selectable OCR recognition language code ('eng', 'spa', 'fra', 'deu', 'jpn', 'por'). */
  ocrLanguage: string;
}

function defaultThresholds(): Record<FindingCategory, number> {
  const out = {} as Record<FindingCategory, number>;
  for (const c of ALL_CATEGORIES) out[c] = 0;
  return out;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: "local",
  // All categories enabled by default: for a redaction tool, failing to
  // redact (under-detection) leaks sensitive data, which is worse than an
  // occasional conservative over-flag. Card-like numbers are Luhn-validated
  // before detection.
  enabledCategories: [
    "email",
    "phone",
    "ssn",
    "dob",
    "medical_record_number",
    "member_id",
    "npi",
    "dea",
    "mbi",
    "address",
    "payment_card",
    "secrets",
    "possible_name",
    "canadian_sin",
    "uk_nhs",
    "aadhaar",
    "pan_india",
    "australian_tfn",
    "cpf",
  ],
  confidenceThresholds: defaultThresholds(),
  maskPadding: 4,
  maskPlaceholders: false,
  pasteGuardEnabled: true,
  maxVisibleChars: 250_000,
  maxNodeChars: 10_000,
  gatewayOrigin: null,
  disclosureAcknowledged: false,
  verificationNoticeAcknowledged: false,
  notificationsEnabled: false,
  consentVersion: CONSENT_VERSION,
  ocrLanguage: "eng",
};

export function isCategory(value: unknown): value is FindingCategory {
  return typeof value === "string" && (ALL_CATEGORIES as string[]).includes(value);
}

/** Coerce an unknown stored blob into a safe Settings value (fail closed). */
export function normalizeSettings(raw: unknown): Settings {
  const base = { ...DEFAULT_SETTINGS };
  if (!isRecord(raw)) return base;

  const mode = raw.mode === "cloud" ? "cloud" : "local";
  const enabledCategories = Array.isArray(raw.enabledCategories)
    ? raw.enabledCategories.filter(isCategory)
    : base.enabledCategories;

  const confidenceThresholds = defaultThresholds();
  if (isRecord(raw.confidenceThresholds)) {
    for (const c of ALL_CATEGORIES) {
      const v = (raw.confidenceThresholds as Record<string, unknown>)[c];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1) {
        confidenceThresholds[c] = v;
      }
    }
  }

  const maskPadding = typeof raw.maskPadding === "number" && Number.isFinite(raw.maskPadding) && raw.maskPadding >= 0 ? raw.maskPadding : base.maskPadding;
  const maskPlaceholders = raw.maskPlaceholders === true;
  const pasteGuardEnabled = typeof raw.pasteGuardEnabled === "boolean" ? raw.pasteGuardEnabled : base.pasteGuardEnabled;
  const maxVisibleChars =
    typeof raw.maxVisibleChars === "number" && Number.isFinite(raw.maxVisibleChars) && raw.maxVisibleChars >= 100
      ? raw.maxVisibleChars
      : base.maxVisibleChars;
  const maxNodeChars =
    typeof raw.maxNodeChars === "number" && Number.isFinite(raw.maxNodeChars) && raw.maxNodeChars >= 10
      ? raw.maxNodeChars
      : base.maxNodeChars;
  const gatewayOrigin =
    typeof raw.gatewayOrigin === "string" && isAllowedGatewayOrigin(raw.gatewayOrigin) ? raw.gatewayOrigin : null;
  const consentVersion =
    typeof raw.consentVersion === "string" && raw.consentVersion.length > 0 ? raw.consentVersion : CONSENT_VERSION;
  const disclosureAcknowledged = raw.disclosureAcknowledged === true;
  const verificationNoticeAcknowledged = raw.verificationNoticeAcknowledged === true;
  const notificationsEnabled = raw.notificationsEnabled === true;
  const accountLabel =
    typeof raw.accountLabel === "string" && raw.accountLabel.length > 0 && raw.accountLabel.length <= 200
      ? raw.accountLabel
      : undefined;
  const ocrLanguage =
    typeof raw.ocrLanguage === "string" && ["eng", "spa", "fra", "deu", "jpn", "por"].includes(raw.ocrLanguage)
      ? raw.ocrLanguage
      : base.ocrLanguage;

  return {
    mode,
    enabledCategories,
    confidenceThresholds,
    maskPadding,
    maskPlaceholders,
    pasteGuardEnabled,
    maxVisibleChars,
    maxNodeChars,
    gatewayOrigin,
    consentVersion,
    disclosureAcknowledged,
    verificationNoticeAcknowledged,
    notificationsEnabled,
    ...(accountLabel !== undefined ? { accountLabel } : {}),
    ocrLanguage,
  };
}

export const SETTINGS_KEY = "settings";

export async function loadSettings(): Promise<Settings> {
  const raw = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(raw[SETTINGS_KEY]);
}

export async function saveSettings(settings: Settings): Promise<void> {
  const sanitized = {
    ...settings,
    // Never persist anything sensitive: only preferences and config.
    enabledCategories: settings.enabledCategories.filter(isCategory),
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: sanitized });
}

/**
 * Consent gate. Cloud scanning must be impossible unless the user has
 * explicitly opted in (mode === "cloud") AND a gateway origin is configured.
 * Local mode never produces a network request; callers must check this before
 * any transmission attempt.
 */
export function isCloudAllowed(settings: Settings): boolean {
  return settings.mode === "cloud" && settings.gatewayOrigin !== null;
}

/**
 * Origin must be an https origin with no path, query, or fragment. Any other
 * shape (http, javascript:, relative path, trailing path) is rejected so the
 * future cloud seam can never be pointed at a non-HTTPS or malformed target.
 */
export function isHttpsOrigin(value: string): boolean {
  if (value.length === 0 || value.length > 2048) return false;
  if (!value.startsWith("https://")) return false;
  const rest = value.slice("https://".length);
  const authority = rest.split(/[/?#]/, 1)[0] ?? "";
  if (authority.length === 0) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname.length > 0 &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

const ALLOWED_GATEWAY_HOSTS = new Set(["api.governworld.acrlogic.com"]);

export function isAllowedGatewayOrigin(value: string): boolean {
  if (!isHttpsOrigin(value)) return false;
  const hostname = new URL(value).hostname.toLowerCase();
  return ALLOWED_GATEWAY_HOSTS.has(hostname);
}

export function isCategoryEnabled(settings: Settings, category: FindingCategory): boolean {
  return settings.enabledCategories.includes(category);
}

/** A finding surfaces only when its confidence meets the per-category threshold. */
export function meetsThreshold(settings: Settings, category: FindingCategory, confidence: number): boolean {
  return confidence >= (settings.confidenceThresholds[category] ?? 0);
}