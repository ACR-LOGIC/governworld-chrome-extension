// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import type { FindingCategory } from "../shared/types.js";
import { isValidSsn, isValidDea, isValidMbi, isValidNpi, isValidLuhn, isNonProviderBound } from "../validators/index.js";

/**
 * Local, deterministic detectors for visible-page text. These run entirely
 * on-device and are intentionally conservative: ambiguous matches are surfaced
 * as "possible sensitive data", never as definitive clinical/legal findings.
 *
 * Hardened identifier validity (SSN, DEA, MBI, NPI checksums, Luhn) is
 * evaluated by the shared `@governworld/identifier-validators` package — the
 * same rules the GovernWorld gateway core uses — so the on-device scanner and
 * the server-side detector can never drift.
 */

import type { CustomPattern } from "../shared/customPatterns.js";
import { isSafeRegex } from "../shared/wizardAnalyzer.js";

export interface RawMatch {
  category: FindingCategory;
  confidence: number; // 0..1
  value: string;
  start: number;
  end: number;
}

const CATEGORY_PRIORITY: FindingCategory[] = [
  "payment_card",
  "ssn",
  "npi",
  "dea",
  "mbi",
  "secrets",
  "email",
  "phone",
  "dob",
  "medical_record_number",
  "member_id",
  "address",
  "custom",
  "possible_name",
];

function priorityOf(category: FindingCategory): number {
  return CATEGORY_PRIORITY.indexOf(category);
}

/** Replace a value with a masked preview that never reveals the full value. */
export function maskValue(category: FindingCategory, value: string): string {
  switch (category) {
    case "email": {
      const at = value.indexOf("@");
      if (at <= 0) return value.replace(/./g, "*");
      const local = value.slice(0, at);
      const domain = value.slice(at + 1);
      const head = local[0] ?? "";
      return `${head}***@${domain}`;
    }
    case "phone": {
      const digits = value.replace(/\D/g, "").replace(/^1/, "");
      if (digits.length < 4) return value.replace(/./g, "*");
      return `***-***-${digits.slice(-4)}`;
    }
    case "ssn": {
      const digits = value.replace(/\D/g, "");
      if (digits.length < 4) return value.replace(/./g, "*");
      return `***-**-${digits.slice(-4)}`;
    }
    case "payment_card": {
      const digits = value.replace(/\D/g, "");
      if (digits.length < 4) return value.replace(/./g, "*");
      return `************${digits.slice(-4)}`;
    }
    case "npi": {
      const digits = value.replace(/\D/g, "");
      if (digits.length < 4) return value.replace(/./g, "*");
      return `******-${digits.slice(-4)}`;
    }
    case "dea":
      return "*********";
    case "mbi": {
      const compact = value.replace(/\D/g, "");
      if (compact.length < 4) return value.replace(/./g, "*");
      return `*******${compact.slice(-4)}`;
    }
    case "dob":
      return "**/**/****";
    case "secrets": {
      // Keep only the first 2 characters of a secret visible so the masked
      // preview stays meaningful (e.g. "sk***"), never the raw value.
      const head = value[0] ?? "";
      return `${head}***`;
    }
    case "possible_name":
      return "********";
    case "custom":
    case "medical_record_number":
    case "member_id":
    case "address":
    default:
      return value.replace(/\S/g, "*");
  }
}

/** Masked, minimized context snippet (~3 tokens around the match). */
export function maskContext(context: string): string {
  const tokens = context.trim().split(/\s+/).filter(Boolean);
  return tokens.map(() => "*").join(" ");
}

/**
 * Short uppercase label shown inside a mask block when mask placeholders are
 * enabled (e.g. "[SSN]", "[API KEY]"). Pure + exported for tests; the content
 * script renders it on the overlay block.
 */
export function placeholderLabelFor(category: FindingCategory): string {
  switch (category) {
    case "email": return "EMAIL";
    case "phone": return "PHONE";
    case "ssn": return "SSN";
    case "dob": return "DOB";
    case "medical_record_number": return "MRN";
    case "member_id": return "MEMBER ID";
    case "npi": return "NPI";
    case "dea": return "DEA";
    case "mbi": return "MBI";
    case "address": return "ADDRESS";
    case "payment_card": return "CARD";
    case "secrets": return "API KEY";
    case "possible_name": return "NAME";
    case "custom": return "CUSTOM";
  }
}

const EMAIL_RE = /\b[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*/g;

function detectEmails(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(EMAIL_RE)) {
    const raw = m[0];
    let end = m.index + raw.length;
    let value = raw;
    while (value.length > 0 && /[.,;:!?()[\]]$/.test(value)) {
      value = value.slice(0, -1);
      end -= 1;
    }
    if (!value.includes(".")) continue;
    if (!/[A-Za-z]/.test(value)) continue;
    out.push({ category: "email", confidence: 0.92, value, start: m.index, end });
  }
  return out;
}

const PHONE_RE =
  /(?<![\dA-Za-z])(?:\+?1[\s.-]?)?(?:\([2-9][0-8][0-9]\)[\s.-]?|[2-9][0-8][0-9][\s.-]?)[2-9][0-9]{2}[\s.-]?[0-9]{4}(?![\dA-Za-z])/g;

function detectPhones(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(PHONE_RE)) {
    const value = m[0];
    const digits = value.replace(/\D/g, "").replace(/^1/, "");
    if (digits.length !== 10) continue;
    const area = digits.slice(0, 3);
    const exchange = digits.slice(3, 6);
    if (area[0] !== "2" && area[0] !== "3" && area[0] !== "4" && area[0] !== "5" && area[0] !== "6" && area[0] !== "7" && area[0] !== "8" && area[0] !== "9") continue;
    if (area[0] === "9" && area[1] === "0" && area[2] === "0") continue;
    if (exchange === "555" && digits.slice(6) === "0100") continue;
    out.push({ category: "phone", confidence: 0.88, value, start: m.index, end: m.index + value.length });
  }
  return out;
}

const SSN_DASH_RE = /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;
const SSN_BARE_RE = /\b(?!000|666|9\d\d)\d{3}(?!00)\d{2}(?!0000)\d{4}\b/g;
const SSN_CUE_RE = /\b(?:ssn|social(?:\s+security)?(?:\s*(?:number|no|#))?)\b/i;

function detectSsns(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(SSN_DASH_RE)) {
    if (!isValidSsn(m[0])) continue;
    out.push({ category: "ssn", confidence: 0.93, value: m[0], start: m.index, end: m.index + m[0].length });
  }
  for (const m of text.matchAll(SSN_BARE_RE)) {
    if (!isValidSsn(m[0])) continue;
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (!SSN_CUE_RE.test(before)) continue;
    out.push({ category: "ssn", confidence: 0.85, value: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

const DOB_RE =
  /\b(0[1-9]|1[0-2])[\/\-](0[1-9]|[12][0-9]|3[01])[\/\-](\d{4}|\d{2})\b|\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b|\b(19|20)\d{2}[\/\-](0[1-9]|1[0-2])[\/\-](0[1-9]|[12][0-9]|3[01])\b/g;
const DOB_CUE_RE = /\b(?:dob|date\s+of\s+birth|born|birth\s*date|birthday|birthdate)\b/i;

function detectDobs(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(DOB_RE)) {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (!DOB_CUE_RE.test(before)) continue;
    out.push({ category: "dob", confidence: 0.8, value: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

const MRN_LABEL_RE =
  /\b(?:mrn|medical\s+record\s*(?:number|no|#)?|record\s*(?:number|no|#))\s*[:#]?\s*(?=\S)/gi;
const IDENTIFIER_RE = /[A-Za-z0-9][A-Za-z0-9_-]{2,20}/;

function detectMrns(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(MRN_LABEL_RE)) {
    const valueStart = m.index + m[0].length;
    const rest = text.slice(valueStart, Math.min(text.length, valueStart + 40));
    const idMatch = rest.match(IDENTIFIER_RE);
    if (!idMatch) continue;
    const rawId = idMatch[0];
    const idStart = idMatch.index ?? 0;
    // "MRN: 123456" is stronger than a bare label.
    const hasColon = /[:#]/.test(m[0]);
    const confidence = hasColon ? 0.82 : 0.72;
    if (/^\d+$/.test(rawId) && rawId.length > 12) continue;
    out.push({
      category: "medical_record_number",
      confidence,
      value: rawId,
      start: valueStart + idStart,
      end: valueStart + idStart + rawId.length,
    });
  }
  return out;
}

const MEMBER_LABEL_RE =
  /\b(?:member\s*(?:id|no|number|#)|patient\s*id|memberid)\s*[:#]?\s*(?=\S)/gi;

function detectMemberIds(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(MEMBER_LABEL_RE)) {
    const valueStart = m.index + m[0].length;
    const rest = text.slice(valueStart, Math.min(text.length, valueStart + 40));
    const idMatch = rest.match(IDENTIFIER_RE);
    if (!idMatch) continue;
    const rawId = idMatch[0];
    const idStart = idMatch.index ?? 0;
    if (/^\d+$/.test(rawId) && rawId.length > 12) continue;
    const hasColon = /[:#]/.test(m[0]);
    out.push({
      category: "member_id",
      confidence: hasColon ? 0.78 : 0.68,
      value: rawId,
      start: valueStart + idStart,
      end: valueStart + idStart + rawId.length,
    });
  }
  return out;
}

const NPI_LABEL_RE =
  /\b(?:npi|national\s+provider\s+(?:id|number|identifier)|provider\s+(?:npi|number|id))\s*[:#]?\s*(?=\S)/gi;
const NPI_RUN_RE = /\b\d{10}\b/g;

function detectNpis(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  // Label-bound NPI: the explicit provider label is the strongest signal.
  for (const m of text.matchAll(NPI_LABEL_RE)) {
    const valueStart = m.index + m[0].length;
    const rest = text.slice(valueStart, Math.min(text.length, valueStart + 24));
    const idMatch = rest.match(NPI_RUN_RE);
    if (!idMatch) continue;
    const rawId = idMatch[0];
    if (!isValidNpi(rawId)) continue;
    const idStart = idMatch.index ?? 0;
    out.push({
      category: "npi",
      confidence: 0.93,
      value: rawId,
      start: valueStart + idStart,
      end: valueStart + idStart + rawId.length,
    });
  }
  // Bare checksum-first fallback (matches the gateway core): a Luhn-valid NPI
  // run with no phone corroboration and no non-provider label binding.
  for (const m of text.matchAll(NPI_RUN_RE)) {
    const value = m[0];
    if (!isValidNpi(value)) continue;
    if (isNonProviderBound(text.slice(Math.max(0, m.index - 48), m.index))) continue;
    if (m.index > 0 && /\d/.test(text[m.index - 1])) continue;
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (/[\s().-]/.test(before)) continue; // phone-shaped punctuation → leave to phone detector
    out.push({ category: "npi", confidence: 0.7, value, start: m.index, end: m.index + value.length });
  }
  return out;
}

const DEA_RE = /\b[A-Z]{2}\d{7}\b/g;

function detectDeas(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(DEA_RE)) {
    if (!isValidDea(m[0])) continue;
    out.push({ category: "dea", confidence: 0.9, value: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

const MBI_LABEL_RE =
  /\b(?:mbi|medicare(?:\s+beneficiary)?(?:\s+(?:id|identifier|number))?|hicn)\s*[:#]?\s*(?=\S)/gi;
const MBI_RUN_RE = /\b[A-Z0-9]{11}\b|\b[A-Z0-9]{4}-[A-Z0-9]{3}-[A-Z0-9]{4}\b/g;

function detectMbis(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(MBI_LABEL_RE)) {
    const valueStart = m.index + m[0].length;
    const rest = text.slice(valueStart, Math.min(text.length, valueStart + 24));
    const idMatch = rest.match(MBI_RUN_RE);
    if (!idMatch) continue;
    const rawId = idMatch[0];
    if (!isValidMbi(rawId)) continue;
    const idStart = idMatch.index ?? 0;
    out.push({
      category: "mbi",
      confidence: 0.92,
      value: rawId,
      start: valueStart + idStart,
      end: valueStart + idStart + rawId.length,
    });
  }
  return out;
}

const SECRET_PATTERNS: { label: string; regex: RegExp; confidence: number }[] = [
  { label: "OpenAI API key", regex: /\bsk-[A-Za-z0-9]{20,}\b/g, confidence: 0.95 },
  { label: "Anthropic API key", regex: /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g, confidence: 0.95 },
  { label: "Google API key", regex: /\bAIza[0-9A-Za-z_\-]{35}\b/g, confidence: 0.95 },
  { label: "Stripe API key", regex: /\b(?:rk|sk|pk)_(?:live|test)_[A-Za-z0-9]{24,48}\b/g, confidence: 0.99 },
  { label: "GitHub token", regex: /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59})\b/g, confidence: 0.99 },
  { label: "Slack token", regex: /\bxox[baprs]-[A-Za-z0-9]{10,48}\b/g, confidence: 0.99 },
  { label: "SendGrid key", regex: /\bSG\.[A-Za-z0-9]{22}\b/g, confidence: 0.99 },
  { label: "npm token", regex: /\bnpm_[A-Za-z0-9]{36}\b/g, confidence: 0.99 },
  { label: "Twilio key", regex: /\bSK[0-9a-fA-F]{32}\b/g, confidence: 0.9 },
  { label: "Databricks token", regex: /\bdapi-[0-9a-fA-F]{32}\b/g, confidence: 0.99 },
  { label: "AWS secret", regex: /\baws_secret_access_key\s*=\s*['"]?([A-Za-z0-9/+=]{40})['"]?/g, confidence: 0.95 },
  { label: "Azure account key", regex: /\bAccountKey\s*=\s*[A-Za-z0-9+/]{86,88}={0,2}/g, confidence: 0.9 },
  { label: "Private key", regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g, confidence: 0.99 },
  { label: "JWT", regex: /\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g, confidence: 0.95 },
  { label: "DB connection string", regex: /\b(?:postgres|mysql|mongodb|redis|amqp|mssql):\/\/[^\s'"<>]*[A-Za-z0-9=/]/gi, confidence: 0.95 },
  { label: "Credential assignment", regex: /(?:token|secret|api[_-]?key|access[_-]?key|auth[_-]?token|password|passwd|pwd)\s*[:=]\s*['"]?([A-Za-z0-9_\-+/=]{16,})['"]?/gi, confidence: 0.8 },
];

const PLACEHOLDER_SECRET_RE = /^(?:example|sample|test|changeme|your_|xxxx|sk_test_[0-9a-z]{6}|ghp_TEST)/i;

function detectSecrets(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  const seen = new Set<number>();
  for (const pat of SECRET_PATTERNS) {
    pat.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.regex.exec(text)) !== null) {
      const value = m[1] ?? m[0];
      if (PLACEHOLDER_SECRET_RE.test(value)) continue;
      const start = m.index + m[0].indexOf(value);
      const end = start + value.length;
      if (seen.has(start)) continue;
      seen.add(start);
      out.push({ category: "secrets", confidence: pat.confidence, value, start, end });
    }
  }
  return out;
}

const STREET_RE =
  /(?<![\dA-Za-z])\d{1,5}[^\S\n]+[A-Za-z][A-Za-z0-9.'-]*(?:[^\S\n]+[A-Za-z0-9.'-]+)*[^\S\n]+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Pl|Place|Way|Ter|Terrace|Cir|Circle|Pkwy|Parkway)(?:\.)?\b/g;
// Optional apt/unit, then city, then state, then ZIP — each bounded by commas
// so the city clause cannot swallow the state abbreviation.
const ADDRESS_TAIL_RE =
  /(?:,[^\S\n]+(?:Apt|Unit|Suite|#|Ste)\.?[^\S\n]*\d+[A-Za-z]?)?(?:,[^\S\n]+[A-Z][a-zA-Z.'-]*(?:[^\S\n]+[A-Z][a-zA-Z.'-]*)*)?(?:,[^\S\n]+[A-Z]{2}(?:\.[^\S\n]+)?)?(?:[^\S\n]+\d{5}(?:-\d{4})?)?/;
const ZIP_RE = /\b\d{5}(?:-\d{4})?\b/;

function detectAddresses(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(STREET_RE)) {
    const streetEnd = m.index + m[0].length;
    const after = text.slice(streetEnd, Math.min(text.length, streetEnd + 120));
    const tailMatch = after.match(ADDRESS_TAIL_RE);
    const tail = tailMatch ? tailMatch[0] : "";
    // Require a city/state/zip tail OR a second address token to reduce noise.
    const hasZip = ZIP_RE.test(tail);
    const hasTail = /\b(?:[A-Z]{2}|[A-Z][a-z]+)\b/.test(tail.slice(0, 60));
    if (!hasZip && !hasTail) continue;
    const value = text.slice(m.index, streetEnd + tail.length).replace(/[,\s]+$/, "");
    out.push({
      category: "address",
      confidence: hasZip ? 0.84 : 0.72,
      value,
      start: m.index,
      end: m.index + value.length,
    });
  }
  return out;
}

function luhnValid(value: string): boolean {
  return isValidLuhn(value);
}

const CARD_RE = /\b(?:\d{4}[\s-]?){3,4}\d{2,4}\b|\b\d{13,19}\b/g;
const CARD_BRAND_RE = /\b(?:visa|mastercard|amex|american\s+express|discover|card)\b/i;

function detectCards(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(CARD_RE)) {
    const value = m[0];
    const digits = value.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    if (!luhnValid(digits)) continue;
    const before = text.slice(Math.max(0, m.index - 30), m.index);
    const confidence = CARD_BRAND_RE.test(before) ? 0.97 : 0.95;
    out.push({ category: "payment_card", confidence, value, start: m.index, end: m.index + value.length });
  }
  return out;
}

// A name label is either (a) at line start, which is how table/field labels
// appear in the extracted text (e.g. "Patient name\nJane Doe"), or (b) a
// mid-line label followed by a colon (e.g. "Patient name: Jane Doe").
const NAME_LABEL_RE =
  /(?<=^|\n)\b(?:patient(?:\s+name)?|member(?:\s+name)?|full\s+name|name)\s*[:.]?\s*(?=\S)|(?<![\w])\b(?:patient(?:\s+name)?|member(?:\s+name)?|full\s+name|name)\s*[:.]\s*(?=\S)/gi;
const NAME_RE = /\b[A-Z][a-zA-Z.'-]*(?:[ \t]+[A-Z][a-zA-Z.'-]*){1,2}\b/;

function detectNames(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(NAME_LABEL_RE)) {
    const valueStart = m.index + m[0].length;
    const rest = text.slice(valueStart, Math.min(text.length, valueStart + 60));
    const nameMatch = rest.match(NAME_RE);
    if (!nameMatch) continue;
    const value = nameMatch[0];
    const nameStart = nameMatch.index ?? 0;
    if (value.length < 3) continue;
    out.push({
      category: "possible_name",
      confidence: 0.52,
      value,
      start: valueStart + nameStart,
      end: valueStart + nameStart + value.length,
    });
  }
  return out;
}

const DETECTORS: Partial<Record<FindingCategory, (text: string) => RawMatch[]>> = {
  email: detectEmails,
  phone: detectPhones,
  ssn: detectSsns,
  dob: detectDobs,
  medical_record_number: detectMrns,
  member_id: detectMemberIds,
  npi: detectNpis,
  dea: detectDeas,
  mbi: detectMbis,
  address: detectAddresses,
  payment_card: detectCards,
  secrets: detectSecrets,
  possible_name: detectNames,
};

/** Resolve overlapping matches keeping the highest-priority, longest span. */
export function resolveOverlaps(matches: RawMatch[]): RawMatch[] {
  const sorted = [...matches].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    const pri = priorityOf(a.category) - priorityOf(b.category);
    if (pri !== 0) return pri;
    const len = b.end - b.start - (a.end - a.start);
    if (len !== 0) return len;
    return b.confidence - a.confidence;
  });

  const merged: RawMatch[] = [];
  for (const m of sorted) {
    const last = merged[merged.length - 1];
    if (last && m.start < last.end) continue; // covered by a higher-priority/longer span
    merged.push(m);
  }
  return merged;
}

export function runCustomPatterns(text: string, patterns: CustomPattern[]): RawMatch[] {
  const matches: RawMatch[] = [];
  if (!text || text.length > 100_000 || !Array.isArray(patterns)) return matches;
  for (const pat of patterns) {
    if (!isSafeRegex(pat.pattern, pat.flags)) continue;
    try {
      const flags = pat.flags.includes("g") ? pat.flags : `${pat.flags}g`;
      const re = new RegExp(pat.pattern, flags);
      let m: RegExpExecArray | null;
      let count = 0;
      while ((m = re.exec(text)) !== null && count++ < 1000) {
        if (!m[0]) {
          re.lastIndex += 1;
          continue;
        }
        matches.push({
          category: pat.category,
          confidence: pat.confidence,
          value: m[0],
          start: m.index,
          end: m.index + m[0].length,
        });
      }
    } catch {
    }
  }
  return matches;
}

export function detect(
  text: string,
  enabledCategories: FindingCategory[],
  customPatterns?: CustomPattern[]
): RawMatch[] {
  const all: RawMatch[] = [];
  for (const category of enabledCategories) {
    const detector = DETECTORS[category];
    if (!detector) continue;
    for (const match of detector(text)) {
      if (match.end <= match.start) continue;
      all.push(match);
    }
  }
  if (customPatterns && customPatterns.length > 0) {
    const activeCustomPatterns = customPatterns.filter((pattern) => enabledCategories.includes(pattern.category));
    const customMatches = runCustomPatterns(text, activeCustomPatterns);
    all.push(...customMatches);
  }
  return resolveOverlaps(all);
}