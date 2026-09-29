// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Shared hardened identifier validators.
 *
 * Single source of truth for SSN / ITIN / card-expiry / DEA / MBI validity and
 * the numeric identifier primitives (Luhn, NPI checksum, NPI demotion labels).
 * Both the GovernWorld core (`src/classification/`) and the redaction extension
 * (`apps/redaction-extension/`) evaluate the SAME rules here so detection can
 * never drift between the gateway and the on-device scanner.
 */

/**
 * Validates a US SSN shape (`XXX-XX-XXXX`, `XXX XX XXXX`).
 * Rejects structurally impossible values: area 000, 666, or 900-999
 * (never issued), group 00, and serial 0000.
 */
export function isValidSsn(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 9) return false;
  const area = Number(digits.slice(0, 3));
  const group = Number(digits.slice(3, 5));
  const serial = Number(digits.slice(5));
  if (area === 0 || area === 666 || area > 899) return false;
  if (group === 0 || serial === 0) return false;
  return true;
}

/**
 * Validates a US ITIN shape (`9XX-XX-XXXX`).
 * ITINs are 9xx area; the group (YY) is restricted to 50-65, 70-88, 90-92 and
 * 94-99, and the serial (NNNN) is never 0000. A bare 9xx-xx-xxxx SSN-shaped value
 * with an invalid group (e.g. 900-00-0000) is not an ITIN.
 *
 * The 50-65 range is not optional. IRS Publication 4757 and the ITIN
 * specification both list 50-65 as valid 4th/5th-digit groups; those are the
 * ITINs issued from 1993, and omitting the range rejected every one of them
 * while the doc comment above still claimed 70-99 was the rule.
 */
export function isValidItin(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 9) return false;
  const area = digits.slice(0, 3);
  const group = Number(digits.slice(3, 5));
  const serial = Number(digits.slice(5));
  if (!area.startsWith('9')) return false;
  const inRange = (group >= 50 && group <= 65)
    || (group >= 70 && group <= 88)
    || (group >= 90 && group <= 92)
    || (group >= 94 && group <= 99);
  if (!inRange) return false;
  if (serial === 0) return false;
  return true;
}

/**
 * Validates a card-expiry shape (`MM/YY`, `MM/YYYY`).
 * Rejects implausible values: month out of range, or a year outside the
 * current..current+15 window (01/2099 is not a near-future card expiry).
 */
export function isValidCardExpiry(value: string): boolean {
  const [month, yearRaw] = value.split('/');
  const year = yearRaw.length === 2 ? 2000 + Number(yearRaw) : Number(yearRaw);
  const currentYear = new Date().getFullYear();
  return Number(month) >= 1 && Number(month) <= 12 && year >= currentYear && year <= currentYear + 15;
}

/**
 * Validates a US DEA registration number (`XX1234563`: 2 letters + 6 digits +
 * 1 check digit).
 *
 * The first letter is a registrant-type code (A/B/C/D/E/F/G/H/J/K/L/M/P/R/S/
 * T/U/X); the second letter is the registrant's last-name initial or "9" for
 * business-address registrants. The check digit is computed from the six
 * numeric digits:
 *   CALC(1,3,5) = digit1 + digit3 + digit5
 *   CALC(2,4,6) = (digit2 + digit4 + digit6) * 2
 *   CHECK       = CALC(1,3,5) + CALC(2,4,6)
 *   check digit = CHECK % 10
 * (DEA number construction — US DOJ / Wikipedia.)
 *
 * The first-letter registrant-code gate plus the check digit rejects random
 * letter+7-digit runs (account refs, order codes, serials) that merely match
 * the loose `[A-Z]{2}\d{7}` shape.
 */
export function isValidDea(value: string): boolean {
  const normalized = value.replace(/[\s-]/g, '');
  if (!/^[A-Z]{2}\d{7}$/.test(normalized)) return false;
  const first = normalized[0];
  // Registrant types per DEA/21 CFR 1301.36: A/B/C/D/E/F/G/H/J/K/L/M are
  // practitioners, P and R are Narcotic Treatment Programs, S and T are
  // mid-level practitioners, U is data-waiver, X is manufacturer/distributor.
  // P/R/S/T/U were missing from this set, so no valid number existed for any of
  // those five prefixes even though the doc comment above already listed them.
  const REGISTRANT_CODES = new Set('ABCDEFGHJKLMPRSTUX');
  if (!REGISTRANT_CODES.has(first)) return false;
  const digits = normalized.slice(2).split('').map(Number);
  const calc135 = digits[0] + digits[2] + digits[4];
  const calc246 = (digits[1] + digits[3] + digits[5]) * 2;
  const check = (calc135 + calc246) % 10;
  return check === digits[6];
}

/**
 * Validates a Medicare Beneficiary Identifier (MBI) shape.
 *
 * The MBI replaced the HICN on Medicare cards. It is exactly 11 characters
 * (CMS spec, format C A AN N A AN N A A N N):
 *   position 1:  numeric (0-9)
 *   position 2:  alphabetic (A-Z excluding S, L, O, I, B, Z)
 *   positions 3, 6: alphanumeric (0-9 or A-Z excluding S, L, O, I, B, Z)
 *   position 4, 7, 10, 11: numeric (0-9)
 *   positions 5, 8, 9: alphabetic (A-Z excluding S, L, O, I, B, Z)
 * (CMS MBI specification; mirrors the Presidio US_MBI recognizer.)
 * Hyphenated form (e.g. `1EG4-TE5-MK73`) is accepted. There is no check
 * digit; the excluded-letter/digit-position constraints reject generic 11-char
 * alphanumeric lookalikes.
 */
export function isValidMbi(value: string): boolean {
  const compact = value.replace(/[\s-]/g, '');
  if (!/^[A-Z0-9]{11}$/.test(compact)) return false;
  const forbidden = new Set(['S', 'L', 'O', 'I', 'B', 'Z']);
  const allowedLetter = (c: string): boolean => /[A-Z]/.test(c) && !forbidden.has(c);
  const allowedAlnum = (c: string): boolean => /[0-9A-Z]/.test(c) && !forbidden.has(c);
  const isNum = (c: string): boolean => /[0-9]/.test(c);

  const plan = [
    'num', 'alpha', 'alnum', 'num', 'alpha', 'alnum',
    'num', 'alpha', 'alpha', 'num', 'num'
  ] as const;
  for (let i = 0; i < 11; i++) {
    const c = compact[i];
    const kind = plan[i];
    if (kind === 'num' && !isNum(c)) return false;
    if (kind === 'alpha' && !allowedLetter(c)) return false;
    if (kind === 'alnum' && !allowedAlnum(c)) return false;
  }
  return true;
}

/**
 * NPI check digit: prepend the card-issuer prefix '80840' (80 = health
 * application, 840 = United States) to the 10 digits and validate the full
 * value with the Luhn modulus-10 check digit (CMS NPI check-digit spec).
 * This proves syntactic validity only; verifying the NPI was actually issued
 * or that it belongs to the named provider is a separate NPPES lookup.
 */
export const NPI_RE = /^\d{10}$/;

/** Luhn modulus-10 check on 13-19 digit card-number-shaped values. */
export function luhnValid(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) return false;
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

export const isValidLuhn = (value: string): boolean => luhnValid(value);

export function isValidNpi(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  return NPI_RE.test(digits) && luhnValid(`80840${digits}`);
}

/**
 * Non-provider identifier labels are strong counter-evidence against the bare
 * checksum-first NPI fallback. A run bound to "asset tag", "serial number",
 * "tracking number", "batch", "reference", "order number", "invoice",
 * "part number", "SKU", "UPC", "barcode", or "internal id" is an inventory /
 * logistics / document identifier, not a healthcare provider NPI. This only
 * demotes the bare fallback (which is checksum-only — no label evidence); a
 * bound or nearby NPI label (or an NPI-typed schema field) still wins because
 * the label evidence above already outranks the demotion.
 */
export const NON_PROVIDER_LABEL_RE = /\b(?:asset\s*tag|serial(?:\s+number)?|tracking(?:\s+number)?|batch(?:\s+(?:id|number))?|reference(?:\s+number)?|order\s+number|invoice(?:\s+number)?|part\s+number|sku|upc|barcode|internal\s+id)\b/i;

/** True when the text immediately preceding a numeric run marks it as a non-provider identifier. */
export function isNonProviderBound(preceding: string): boolean {
  return NON_PROVIDER_LABEL_RE.test(preceding.slice(-48));
}

/**
 * Validates a CUSIP (Committee on Uniform Securities Identification Procedures).
 * 9 alphanumeric characters: 8 identifier chars + 1 check digit.
 * Character values: 0-9 = 0-9, A-Z = 10-35, * = 36, @ = 37, # = 38.
 * Odd positions weighted by 1, even positions weighted by 2.
 * Check digit = (10 - (sum of digits of products % 10)) % 10.
 */
export function isValidCusip(value: string): boolean {
  const clean = value.trim().toUpperCase();
  if (!/^[0-9A-Z*@#]{9}$/.test(clean)) return false;
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    const ch = clean[i];
    let val: number;
    if (ch >= '0' && ch <= '9') val = Number(ch);
    else if (ch >= 'A' && ch <= 'Z') val = ch.charCodeAt(0) - 55;
    else if (ch === '*') val = 36;
    else if (ch === '@') val = 37;
    else if (ch === '#') val = 38;
    else return false;

    const weight = (i % 2 === 0) ? 1 : 2;
    const prod = val * weight;
    sum += Math.floor(prod / 10) + (prod % 10);
  }
  const check = (10 - (sum % 10)) % 10;
  return check === Number(clean[8]);
}

/**
 * Validates an ISIN (International Securities Identification Number - ISO 6166).
 * 12 characters: 2-letter country code, 9 alphanumeric characters, 1 check digit.
 * Converts letters to two-digit numbers (A=10..Z=35), then applies Luhn mod-10 double-add-double from right.
 */
export function isValidIsin(value: string): boolean {
  const clean = value.trim().toUpperCase();
  if (!/^[A-Z]{2}[0-9A-Z]{9}\d$/.test(clean)) return false;
  let expanded = '';
  for (let i = 0; i < 11; i++) {
    const ch = clean[i];
    if (ch >= 'A' && ch <= 'Z') {
      expanded += String(ch.charCodeAt(0) - 55);
    } else {
      expanded += ch;
    }
  }
  // Double-add-double from right to left
  let sum = 0;
  let double = true;
  for (let i = expanded.length - 1; i >= 0; i--) {
    let digit = Number(expanded[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === Number(clean[11]);
}

/**
 * Validates a SEDOL (Stock Exchange Daily Official List) 7-character code.
 * Letters exclude vowels (A, E, I, O, U).
 * Weights: [1, 3, 1, 7, 3, 9, 1].
 */
export function isValidSedol(value: string): boolean {
  const clean = value.trim().toUpperCase();
  if (!/^[0-9B-DF-HJ-NP-TV-Z]{6}\d$/.test(clean)) return false;
  const weights = [1, 3, 1, 7, 3, 9];
  let sum = 0;
  for (let i = 0; i < 6; i++) {
    const ch = clean[i];
    const val = (ch >= '0' && ch <= '9') ? Number(ch) : ch.charCodeAt(0) - 55;
    sum += val * weights[i];
  }
  const check = (10 - (sum % 10)) % 10;
  return check === Number(clean[6]);
}

/**
 * Validates a LOINC lab/clinical observation code (format: \d{3,5}-\d).
 * Uses standard LOINC Mod-10 check digit algorithm (Luhn weighting from right on digits before hyphen).
 */
export function isValidLoinc(value: string): boolean {
  const clean = value.trim();
  const match = /^(\d{3,5})-(\d)$/.exec(clean);
  if (!match) return false;
  const numPart = match[1];
  const expectedCheck = Number(match[2]);
  let sum = 0;
  let double = true; // start with weight 2 for last digit before hyphen
  for (let i = numPart.length - 1; i >= 0; i--) {
    let d = Number(numPart[i]);
    if (double) {
      d *= 2;
      if (d > 9) d = Math.floor(d / 10) + (d % 10);
    }
    sum += d;
    double = !double;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === expectedCheck;
}

/**
 * Validates a Canadian Social Insurance Number (SIN).
 * 9 digits with Luhn algorithm; first digit cannot be 0 or 8.
 */
export function isValidCanadianSin(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 9) return false;
  const first = Number(digits[0]);
  if (first === 0 || first === 8) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) return false;
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

/**
 * Validates an Indian Aadhaar number.
 * 12 digits, does not start with 0 or 1, validated via Verhoeff algorithm.
 */
export function isValidAadhaar(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 12) return false;
  if (digits[0] === '0' || digits[0] === '1') return false;

  // Verhoeff multiplication table
  const d = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
    [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
    [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
  ];
  // Verhoeff permutation table
  const p = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]
  ];

  let c = 0;
  const reversed = digits.split('').reverse().map(Number);
  for (let i = 0; i < reversed.length; i++) {
    c = d[c][p[i % 8][reversed[i]]];
  }
  return c === 0;
}

/**
 * Validates an Indian Permanent Account Number (PAN).
 * Format: 5 uppercase letters + 4 digits + 1 uppercase letter.
 * 4th character must be one of: P, C, H, A, B, G, J, L, F, T.
 */
export function isValidPanIndia(value: string): boolean {
  const clean = value.trim().toUpperCase();
  if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(clean)) return false;
  const statusChar = clean[3];
  return 'PCHABGJLFT'.includes(statusChar);
}

/**
 * Validates a UK NHS Number (10 digits).
 * Modulus 11 algorithm with weights 10, 9, 8, 7, 6, 5, 4, 3, 2.
 */
export function isValidNhsNumber(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 10) return false;
  const weights = [10, 9, 8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += Number(digits[i]) * weights[i];
  }
  const remainder = sum % 11;
  const check = 11 - remainder;
  const checkDigit = check === 11 ? 0 : check;
  if (checkDigit === 10) return false; // Invalid NHS number
  return checkDigit === Number(digits[9]);
}

/**
 * Validates an Australian Tax File Number (TFN) - 8 or 9 digits.
 */
export function isValidAustralianTfn(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 9) {
    const weights = [1, 4, 3, 7, 5, 8, 6, 9, 10];
    let sum = 0;
    for (let i = 0; i < 9; i++) {
      sum += Number(digits[i]) * weights[i];
    }
    return sum % 11 === 0;
  }
  if (digits.length === 8) {
    const weights = [4, 3, 7, 5, 8, 6, 9, 10];
    let sum = 0;
    for (let i = 0; i < 8; i++) {
      sum += Number(digits[i]) * weights[i];
    }
    return sum % 11 === 0;
  }
  return false;
}

/**
 * Validates a Brazilian CPF (Cadastro de Pessoas Físicas).
 * 11 digits with dual modulo-11 check digits.
 */
export function isValidCpf(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 11) return false;
  // Reject identical digits (00000000000, 11111111111, etc.)
  if (/^(\d)\1{10}$/.test(digits)) return false;

  // First check digit
  let sum1 = 0;
  for (let i = 0; i < 9; i++) {
    sum1 += Number(digits[i]) * (10 - i);
  }
  let rem1 = (sum1 * 10) % 11;
  if (rem1 === 10 || rem1 === 11) rem1 = 0;
  if (rem1 !== Number(digits[9])) return false;

  // Second check digit
  let sum2 = 0;
  for (let i = 0; i < 10; i++) {
    sum2 += Number(digits[i]) * (11 - i);
  }
  let rem2 = (sum2 * 10) % 11;
  if (rem2 === 10 || rem2 === 11) rem2 = 0;
  return rem2 === Number(digits[10]);
}

