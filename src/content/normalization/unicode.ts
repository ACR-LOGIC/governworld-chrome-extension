// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.

export interface UnicodeMapping {
  normalizedIndex: number;
  originalIndex: number;
}

export interface UnicodeNormalizationResult {
  original: string;
  normalized: string;
  mappings: UnicodeMapping[];
  changed: boolean;
}

const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;
const NBSP_RE = /\u00A0/g;
const MULTI_SPACE_RE = / {2,}/g;

export function normalizeUnicodeWithMapping(text: string): UnicodeNormalizationResult {
  const mappings: UnicodeMapping[] = [];
  let normalized = "";
  let originalIndex = 0;
  let changed = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const code = char.codePointAt(0) ?? 0;

    if (ZERO_WIDTH_RE.test(char)) {
      changed = true;
      originalIndex++;
      continue;
    }

    if (NBSP_RE.test(char)) {
      normalized += " ";
      mappings.push({ normalizedIndex: normalized.length - 1, originalIndex });
      originalIndex++;
      changed = true;
      continue;
    }

    if (char === " " && normalized.endsWith(" ")) {
      changed = true;
      originalIndex++;
      continue;
    }

    normalized += char;
    mappings.push({ normalizedIndex: normalized.length - 1, originalIndex });
    originalIndex++;
  }

  return { original: text, normalized, mappings, changed };
}

export function mapNormalizedToOriginalOffset(mapping: UnicodeMapping[], normalizedOffset: number): number {
  if (mapping.length === 0) return normalizedOffset;
  if (normalizedOffset <= 0) return mapping[0]?.originalIndex ?? 0;
  if (normalizedOffset >= mapping.length) return mapping[mapping.length - 1]?.originalIndex ?? 0;
  return mapping[normalizedOffset]?.originalIndex ?? normalizedOffset;
}

export function mapOriginalToNormalizedOffset(mapping: UnicodeMapping[], originalOffset: number): number {
  if (mapping.length === 0) return originalOffset;
  for (let i = 0; i < mapping.length; i++) {
    if (mapping[i].originalIndex === originalOffset) {
      return mapping[i].normalizedIndex;
    }
  }
  return originalOffset;
}
