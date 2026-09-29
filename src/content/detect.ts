// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import type { FindingCategory } from "../shared/types.js";
import {
  isValidSsn,
  isValidDea,
  isValidMbi,
  isValidNpi,
  isValidLuhn,
  isNonProviderBound,
  isValidCanadianSin,
  isValidNhsNumber,
  isValidAadhaar,
  isValidPanIndia,
  isValidAustralianTfn,
  isValidCpf,
  isValidItin,
} from "../validators/index.js";

/**
 * Local, deterministic detectors for visible-page text. These run entirely
 * on-device and are intentionally conservative: ambiguous matches are surfaced
 * as "possible sensitive data", never as definitive clinical/legal findings.
 *
 * Hardened identifier validity (SSN, DEA, MBI, NPI checksums, Luhn, international
 * tax/health IDs) is evaluated by the shared validator rules so detection can
 * never drift between the gateway and the on-device scanner.
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
  "canadian_sin",
  "uk_nhs",
  "aadhaar",
  "pan_india",
  "australian_tfn",
  "cpf",
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
    case "canadian_sin": {
      const digits = value.replace(/\D/g, "");
      if (digits.length < 3) return value.replace(/./g, "*");
      return `***-***-${digits.slice(-3)}`;
    }
    case "uk_nhs": {
      const digits = value.replace(/\D/g, "");
      if (digits.length < 4) return value.replace(/./g, "*");
      return `***-***-${digits.slice(-4)}`;
    }
    case "aadhaar": {
      const digits = value.replace(/\D/g, "");
      if (digits.length < 4) return value.replace(/./g, "*");
      return `****-****-${digits.slice(-4)}`;
    }
    case "pan_india": {
      const clean = value.replace(/[\s-]/g, "").toUpperCase();
      if (clean.length < 5) return value.replace(/./g, "*");
      return `*****${clean.slice(5)}`;
    }
    case "australian_tfn": {
      const digits = value.replace(/\D/g, "");
      if (digits.length < 3) return value.replace(/./g, "*");
      return `***-***-${digits.slice(-3)}`;
    }
    case "cpf": {
      const digits = value.replace(/\D/g, "");
      if (digits.length < 2) return value.replace(/./g, "*");
      return `***.***.***-${digits.slice(-2)}`;
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
    case "canadian_sin": return "SIN";
    case "uk_nhs": return "NHS";
    case "aadhaar": return "AADHAAR";
    case "pan_india": return "PAN";
    case "australian_tfn": return "TFN";
    case "cpf": return "CPF";
  }
}

/**
 * Email matcher.
 *
 * The local part is matched lazily against a bounded run of characters that
 * must be followed by `@`, rather than as an unbounded `[...]+@`.
 *
 * The unbounded form is polynomial, not exponential, but that is still a denial
 * of service in a content script: `\b[...]+@` starts a scan at every word
 * boundary (every `.`, `-`, `/`) and backtracks the whole remaining run looking
 * for an `@` that is not there. Measured on this machine against a run of
 * in-class characters with no `@`: 25k -> 0.9s, 50k -> 3.8s, 100k -> 15s, 250k
 * -> 94s. A `<pre>` block of minified JavaScript or a `data:` URI is enough to
 * produce one of those, and `detect()` is called on unsized page and OCR text.
 *
 * Two changes remove the cost. The local part is capped at the 64 characters
 * RFC 5321 allows, which bounds the backtracking per attempt, and the whole
 * detector returns immediately when the text contains no `@` at all, which is
 * the case for the overwhelming majority of nodes.
 */
const EMAIL_RE = /\b[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]{1,64}(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]{1,63})*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*/g;

function detectEmails(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  if (!text.includes("@")) return out;
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
// "social" on its own is an ordinary English word, so any page containing the
// word next to a 9-digit number produced an SSN — "Join our social 123456789
// community" was enough. The full phrase is required.
const SSN_CUE_RE = /\b(?:ssn|social\s+security(?:\s*(?:number|no|#))?)\b/i;
const ITIN_CUE_RE = /\b(?:itin|individual\s+taxpayer(?:\s+identification)?(?:\s*(?:number|no|#))?)\b/i;
const ITIN_RE = /\b9\d{2}[- ]\d{2}[- ]\d{4}\b|\b9\d{8}\b/g;

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
  for (const m of text.matchAll(ITIN_RE)) {
    if (!isValidItin(m[0])) continue;
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (ITIN_CUE_RE.test(before) || SSN_CUE_RE.test(before)) {
      out.push({ category: "ssn", confidence: 0.88, value: m[0], start: m.index, end: m.index + m[0].length });
    }
  }
  return out;
}

// Canadian SIN
const CANADIAN_SIN_DASH_RE = /\b(?!0|8)\d{3}[ -]\d{3}[ -]\d{3}\b/g;
const CANADIAN_SIN_BARE_RE = /\b(?!0|8)\d{9}\b/g;
const CANADIAN_SIN_CUE_RE = /\b(?:sin|social\s+insurance(?:\s*(?:number|no|#))?|nas|num[ée]ro\s+d['’]assurance\s+sociale)\b/i;

function detectCanadianSins(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(CANADIAN_SIN_DASH_RE)) {
    if (!isValidCanadianSin(m[0])) continue;
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    const hasCue = CANADIAN_SIN_CUE_RE.test(before);
    out.push({
      category: "canadian_sin",
      confidence: hasCue ? 0.95 : 0.90,
      value: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  for (const m of text.matchAll(CANADIAN_SIN_BARE_RE)) {
    if (!isValidCanadianSin(m[0])) continue;
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (!CANADIAN_SIN_CUE_RE.test(before)) continue;
    out.push({
      category: "canadian_sin",
      confidence: 0.85,
      value: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

// UK NHS Number
const UK_NHS_FORMATTED_RE = /\b\d{3}[ -]\d{3}[ -]\d{4}\b/g;
const UK_NHS_BARE_RE = /\b\d{10}\b/g;
const UK_NHS_CUE_RE = /\b(?:nhs(?:\s*(?:number|no|#))?|national\s+health\s+service)\b/i;

function detectUkNhs(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(UK_NHS_FORMATTED_RE)) {
    if (!isValidNhsNumber(m[0])) continue;
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    const hasCue = UK_NHS_CUE_RE.test(before);
    out.push({
      category: "uk_nhs",
      confidence: hasCue ? 0.95 : 0.90,
      value: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  for (const m of text.matchAll(UK_NHS_BARE_RE)) {
    if (!isValidNhsNumber(m[0])) continue;
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (!UK_NHS_CUE_RE.test(before)) continue;
    out.push({
      category: "uk_nhs",
      confidence: 0.85,
      value: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

// Indian Aadhaar
const AADHAAR_FORMATTED_RE = /\b[2-9]\d{3}[ -]\d{4}[ -]\d{4}\b/g;
const AADHAAR_BARE_RE = /\b[2-9]\d{11}\b/g;
const AADHAAR_CUE_RE = /\b(?:aadhaar|aadhar|uidai)(?:\s*(?:number|no|#))?\b/i;

function detectAadhaar(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(AADHAAR_FORMATTED_RE)) {
    if (!isValidAadhaar(m[0])) continue;
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    const hasCue = AADHAAR_CUE_RE.test(before);
    out.push({
      category: "aadhaar",
      confidence: hasCue ? 0.95 : 0.92,
      value: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  for (const m of text.matchAll(AADHAAR_BARE_RE)) {
    if (!isValidAadhaar(m[0])) continue;
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (!AADHAAR_CUE_RE.test(before)) continue;
    out.push({
      category: "aadhaar",
      confidence: 0.85,
      value: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

// Indian PAN
const PAN_INDIA_RE = /\b[A-Z]{5}\d{4}[A-Z]\b/g;
const PAN_INDIA_CUE_RE = /\b(?:pan(?:\s*(?:card|number|no|#))?|permanent\s+account\s+number)\b/i;

function detectPanIndia(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(PAN_INDIA_RE)) {
    if (!isValidPanIndia(m[0])) continue;
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    const hasCue = PAN_INDIA_CUE_RE.test(before);
    out.push({
      category: "pan_india",
      confidence: hasCue ? 0.95 : 0.90,
      value: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

// Australian TFN (Tax File Number)
const AUSTRALIAN_TFN_FORMATTED_RE = /\b\d{3}[ -]\d{3}[ -]\d{2,3}\b/g;
const AUSTRALIAN_TFN_BARE_RE = /\b\d{8,9}\b/g;
const AUSTRALIAN_TFN_CUE_RE = /\b(?:tfn|tax\s+file\s+number)\b/i;

function detectAustralianTfn(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(AUSTRALIAN_TFN_FORMATTED_RE)) {
    if (!isValidAustralianTfn(m[0])) continue;
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    const hasCue = AUSTRALIAN_TFN_CUE_RE.test(before);
    out.push({
      category: "australian_tfn",
      confidence: hasCue ? 0.95 : 0.88,
      value: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  for (const m of text.matchAll(AUSTRALIAN_TFN_BARE_RE)) {
    if (!isValidAustralianTfn(m[0])) continue;
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (!AUSTRALIAN_TFN_CUE_RE.test(before)) continue;
    out.push({
      category: "australian_tfn",
      confidence: 0.85,
      value: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

// Brazilian CPF
const CPF_FORMATTED_RE = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g;
const CPF_BARE_RE = /\b\d{11}\b/g;
const CPF_CUE_RE = /\b(?:cpf|cadastro\s+de\s+pessoas?\s+f[íi]sicas?)\b/i;

function detectCpf(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(CPF_FORMATTED_RE)) {
    if (!isValidCpf(m[0])) continue;
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    const hasCue = CPF_CUE_RE.test(before);
    out.push({
      category: "cpf",
      confidence: hasCue ? 0.95 : 0.92,
      value: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  for (const m of text.matchAll(CPF_BARE_RE)) {
    if (!isValidCpf(m[0])) continue;
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (!CPF_CUE_RE.test(before)) continue;
    out.push({
      category: "cpf",
      confidence: 0.85,
      value: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
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

/**
 * Pull a record or member identifier out from just after its label.
 *
 * The identifier must contain a digit. `IDENTIFIER_RE` alone accepts any run of
 * letters, so a label followed by ordinary prose produced findings: "MRN pending
 * review." masked "pending", "The record number is protected health information"
 * masked "protected", and "Patient ID unknown at admission" masked "unknown".
 * In clinical and legal prose those phrases are common, so every one of them
 * masked a random word in the document.
 *
 * Medical record numbers and member IDs are alphanumeric in practice and
 * essentially always carry at least one digit, so requiring one removes the
 * false positives without losing a real identifier.
 */
function identifierAfterLabel(rest: string): { id: string; offset: number } | null {
  const m = rest.match(IDENTIFIER_RE);
  if (!m) return null;
  const id = m[0];
  if (!/\d/.test(id)) return null;
  if (/^\d+$/.test(id) && id.length > 12) return null;
  return { id, offset: m.index ?? 0 };
}

function detectMrns(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(MRN_LABEL_RE)) {
    const valueStart = m.index + m[0].length;
    const rest = text.slice(valueStart, Math.min(text.length, valueStart + 40));
    const found = identifierAfterLabel(rest);
    if (!found) continue;
    // "MRN: 123456" is stronger than a bare label.
    const hasColon = /[:#]/.test(m[0]);
    const confidence = hasColon ? 0.82 : 0.72;
    out.push({
      category: "medical_record_number",
      confidence,
      value: found.id,
      start: valueStart + found.offset,
      end: valueStart + found.offset + found.id.length,
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
    const found = identifierAfterLabel(rest);
    if (!found) continue;
    const hasColon = /[:#]/.test(m[0]);
    out.push({
      category: "member_id",
      confidence: hasColon ? 0.78 : 0.68,
      value: found.id,
      start: valueStart + found.offset,
      end: valueStart + found.offset + found.id.length,
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
  // OpenAI. `sk-proj-` is the current project-key form and contains a hyphen
  // after `sk-`, so the older `[A-Za-z0-9]{20,}` class stopped at the hyphen and
  // missed every project key outright. The hyphenated prefix is matched first,
  // then the plain legacy form.
  { label: "OpenAI API key", regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, confidence: 0.95 },
  { label: "Anthropic API key", regex: /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g, confidence: 0.95 },
  { label: "Google API key", regex: /\bAIza[0-9A-Za-z_\-]{35}\b/g, confidence: 0.95 },
  { label: "Stripe API key", regex: /\b(?:rk|sk|pk)_(?:live|test)_[A-Za-z0-9]{24,48}\b/g, confidence: 0.99 },
  { label: "GitHub token", regex: /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59})\b/g, confidence: 0.99 },
  // Slack tokens are hyphen-separated groups: xoxb-<team>-<bot>-<secret>. The
  // single-segment form matched only the first group and left the rest of the
  // credential sitting in plain text next to the mask, which is the opposite of
  // what this tool is for.
  { label: "Slack token", regex: /\bxox[baprs](?:-[A-Za-z0-9]{10,48}){1,4}/g, confidence: 0.99 },
  // SendGrid is SG.<22>.<43>. Matching only the first group left the 43-character
  // signature visible.
  { label: "SendGrid key", regex: /\bSG\.[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{16,64}\b/g, confidence: 0.99 },
  { label: "npm token", regex: /\bnpm_[A-Za-z0-9]{36}\b/g, confidence: 0.99 },
  { label: "Twilio key", regex: /\bSK[0-9a-fA-F]{32}\b/g, confidence: 0.9 },
  // Databricks tokens are `dapi` followed by 32 hex characters with no hyphen.
  // Requiring one meant the pattern never fired and real tokens fell through to
  // the generic credential-assignment rule at 0.8 confidence.
  { label: "Databricks token", regex: /\bdapi-?[0-9a-fA-F]{32}\b/g, confidence: 0.99 },
  // AWS access key IDs. These are the most commonly leaked cloud secret and
  // were previously undetected: the old rules only covered the secret half of
  // the pair, and the generic credential-assignment rule could not reach
  // `aws_access_key_id` because `access_key` is followed by `_id=` before the `=`.
  { label: "AWS access key ID", regex: /\b(?:AKIA|ASIA|AROA|AIDA|ANPA|AGPA|AIPA|ANVA|ABIA|ACCA)[A-Z0-9]{16}\b/g, confidence: 0.99 },
  { label: "AWS secret", regex: /\baws_secret_access_key\s*=\s*['"]?([A-Za-z0-9/+=]{40})['"]?/g, confidence: 0.95 },
  { label: "Azure account key", regex: /\bAccountKey\s*=\s*[A-Za-z0-9+/]{86,88}={0,2}/g, confidence: 0.9 },
  // A PEM block including its body. The old pattern matched only the 30-character
  // header, which meant the key itself — the part that must never be published —
  // was left in plain text directly below the mask.
  { label: "Private key", regex: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g, confidence: 0.99 },
  { label: "PuTTY private key", regex: /PuTTY-User-Key-File-\d+:[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g, confidence: 0.99 },
  { label: "JWT", regex: /\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g, confidence: 0.95 },
  { label: "GitLab token", regex: /\bglpat-[A-Za-z0-9_\-]{20,}\b/g, confidence: 0.99 },
  { label: "HuggingFace token", regex: /\bhf_[A-Za-z0-9]{30,}\b/g, confidence: 0.95 },
  { label: "Discord bot token", regex: /\b(?:Bot\s+)?M[A-Za-z0-9_\-]{23}\.[A-Za-z0-9_\-]{6}\.[A-Za-z0-9_\-]{27}\b/g, confidence: 0.99 },
  { label: "Telegram bot token", regex: /\b\d{8,10}:AA[A-Za-z0-9_\-]{33}\b/g, confidence: 0.95 },
  // A lookbehind anchors the match to the token so the reported span excludes
  // the scheme word: the redacted text still reads "Bearer [REDACTED]", and a
  // specific rule for the token itself (an OpenAI key, say) wins the overlap on
  // its own merits rather than losing to a longer span that swallowed "Bearer".
  { label: "Bearer token", regex: /(?<=Bearer\s)[A-Za-z0-9._~+/=-]{20,}/g, confidence: 0.95 },
  { label: "Slack webhook", regex: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9+\/=_-]{10,}/g, confidence: 0.99 },
  // Shared Access Signature: a capability URL, so the sig alone grants access.
  { label: "Azure SAS signature", regex: /[?&]sig=[A-Za-z0-9%+/=]{20,}/g, confidence: 0.95 },
  // Credentials embedded in a URL. Previously the userinfo was skipped entirely
  // and the value after the `@` was reported as an email address, so the
  // username stayed visible and the credential was mislabelled.
  //
  // The scheme quantifier is capped at 31 characters. Unbounded, this is
  // quadratic on text with no `://` in it: `[a-z][a-z0-9+.-]*` starts a scan at
  // every word boundary and backtracks the whole remaining run. No real URL
  // scheme comes close to 31 characters (the longest registered is `ms-access-control').
  { label: "URL with credentials", regex: /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s/:@]{1,64}:[^\s/:@]{3,128}@[^\s"'<>`]+/gi, confidence: 0.99 },
  { label: "HTTP Basic auth", regex: /\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}/g, confidence: 0.95 },
  { label: "DB connection string", regex: /\b(?:postgres|mysql|mongodb|redis|amqp|mssql):\/\/[^\s'"<>]*[A-Za-z0-9=/]/gi, confidence: 0.95 },
  // The capture class previously omitted `.`, so any value containing a dot was
  // not matched at all — including every `client_secret`, most passwords, and
  // every `.env` value that resembles a hostname.
  { label: "Credential assignment", regex: /(?:token|secret|api[_-]?key|access[_-]?key(?:[_-]?id)?|auth[_-]?token|password|passwd|pwd|client[_-]?secret)\s*[:=]\s*['"]?([A-Za-z0-9._\-+/=%]{16,})['"]?/gi, confidence: 0.8 },
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
      if (isPlaceholder(pat, value)) continue;
      const start = m.index + m[0].indexOf(value);
      const end = start + value.length;
      if (seen.has(start)) continue;
      seen.add(start);
      out.push({ category: "secrets", confidence: pat.confidence, value, start, end });
    }
  }
  return out;
}

/**
 * Decide whether a match is documentation filler rather than a real credential.
 *
 * Only the two low-confidence generic rules can be filtered. A structurally
 * specific rule (Stripe, GitHub, AWS key IDs, Slack webhooks) constrains its
 * own shape so tightly that a placeholder cannot match it — and applying a
 * prefix filter to those would silently drop a genuine secret that happened to
 * begin with "test" or "example", which is the one failure a redaction tool
 * must never have.
 *
 * For the generic rules, over-flagging is the safe error: masking
 * `postgres://example:example@localhost/db` in a README costs nothing, while
 * missing a live credential ships it.
 */
function isPlaceholder(pat: { confidence: number }, value: string): boolean {
  if (pat.confidence > 0.8) return false;
  if (PLACEHOLDER_SECRET_RE.test(value)) return true;
  // A reference to an environment variable is the opposite of a credential:
  // there is no secret in `process.env.API_KEY`, only the name of one. The
  // capture class accepts dots and `$` so that real dotted values are matched,
  // which makes this check necessary — otherwise every `KEY = os.environ[...]`
  // line in a code review or a log dump is reported as a leaked secret.
  if (/^(?:process\.env\.|os\.environ|ENV\[|env:|\$\{?[A-Z][A-Z0-9_]*\}?$)/.test(value)) return true;
  // Connection strings pointing at reserved/example hosts or default ports with
  // default credentials are documentation, not configuration.
  if (/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|example\.(?:com|test|org)|host\.docker\.internal)\b/i.test(value)) {
    return /[:@](?:example|sample|test|changeme|password|root|admin|postgres|redis|mongo)?[:@]?/i.test(value);
  }
  return false;
}

const STREET_RE =
  /(?<![\dA-Za-z])\d{1,5}[^\S\n]+[A-Za-z][A-Za-z0-9.'-]*(?:[^\S\n]+[A-Za-z0-9.'-]+)*[^\S\n]+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Pl|Place|Way|Ter|Terrace|Cir|Circle|Pkwy|Parkway)(?:\.)?\b/g;
// Optional apt/unit, then city, then state, then ZIP — each bounded by commas
// so the city clause cannot swallow the state abbreviation.
//
// The ZIP group is followed by a negative lookahead on a digit. Without it the
// optional group matched the first five digits of any longer run, so in
// "5 Ocean Rd 4111111111111611" the address span ended at "...Rd 41111" and the
// card match was then discarded as an overlap. A ZIP is exactly five digits;
// five digits that are part of a longer run are not a ZIP.
const ADDRESS_TAIL_RE =
  /(?:,[^\S\n]+(?:Apt|Unit|Suite|#|Ste)\.?[^\S\n]*\d+[A-Za-z]?)?(?:,[^\S\n]+[A-Z][a-zA-Z.'-]*(?:[^\S\n]+[A-Z][a-zA-Z.'-]*)*)?(?:,[^\S\n]+[A-Z]{2}(?:\.[^\S\n]+)?)?(?:[^\S\n]+\d{5}(?:-\d{4})?(?!\d))?/;
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
  canadian_sin: detectCanadianSins,
  uk_nhs: detectUkNhs,
  aadhaar: detectAadhaar,
  pan_india: detectPanIndia,
  australian_tfn: detectAustralianTfn,
  cpf: detectCpf,
};

/**
 * Resolve overlapping matches.
 *
 * Group every set of matches that overlap into a cluster, then keep ONE winner
 * per cluster: highest category priority first, then the longest span, then the
 * most confident.
 *
 * Priority must dominate position. The previous version sorted by start offset
 * and simply dropped anything that started inside an already-kept span, so an
 * `address` match beginning at offset 0 beat a `payment_card` match beginning
 * at offset 11 and the card was discarded — leaving the last 11 digits of a real
 * card number visible in the page. Sorting by position also meant priority was
 * only ever consulted for matches at an identical offset, which made the whole
 * priority table nearly dead.
 *
 * `payment_card` is the highest-priority category, so a cluster containing a
 * card now always resolves to the card and the full number is masked. The
 * address fragment loses its own label rather than the card losing its mask.
 */
export function resolveOverlaps(matches: RawMatch[]): RawMatch[] {
  if (matches.length === 0) return [];
  const sorted = [...matches].sort((a, b) => a.start - b.start || a.end - b.end);
  const winners: RawMatch[] = [];
  let cluster: RawMatch[] = [];

  const better = (a: RawMatch, b: RawMatch): number => {
    const pri = priorityOf(a.category) - priorityOf(b.category);
    if (pri !== 0) return pri;
    const len = b.end - b.start - (a.end - a.start);
    if (len !== 0) return len;
    return b.confidence - a.confidence;
  };

  const flush = () => {
    if (cluster.length === 0) return;
    winners.push(cluster.reduce((best, m) => (better(m, best) < 0 ? m : best)));
    cluster = [];
  };

  let clusterEnd = -1;
  for (const m of sorted) {
    if (cluster.length > 0 && m.start >= clusterEnd) {
      flush();
    }
    cluster.push(m);
    // A cluster is a maximal run of overlaps: it stays open while the next
    // match starts before the furthest end seen so far.
    clusterEnd = cluster.length === 1 ? m.end : Math.max(clusterEnd, m.end);
  }
  flush();

  return winners.sort((a, b) => a.start - b.start);
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