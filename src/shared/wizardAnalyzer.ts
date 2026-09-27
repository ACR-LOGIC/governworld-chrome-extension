// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.

/**
 * Local Logic Wizard — pure deterministic pattern analyzer.
 *
 * Operates entirely on-device. Never touches the network.
 * Never stores or re-emits raw example text — only structural statistics
 * and the derived proposed pattern are returned.
 *
 * Design constraints:
 *   - No browser APIs; fully unit-testable in Node/Vitest.
 *   - No external LLM or AI service dependency.
 *   - Analysis is character-class structural — not semantic.
 *   - All regex proposals are deterministic given the same inputs.
 */

import type { CustomPatternCategory } from "./customPatterns.js";

// ─────────────────────────────────────────────────────────────────────────────
// Public output types
// ─────────────────────────────────────────────────────────────────────────────

export interface WizardCharacteristic {
  /** Short human-readable description of a detected pattern feature. */
  label: string;
  /** Optional supporting detail. */
  detail?: string;
}

export interface WizardMatchResult {
  /** Index into the original examples array. */
  exampleIndex: number;
  matched: boolean;
  /** Number of matches found without returning the matched text. */
  matchCount: number;
}

export interface WizardAnalysis {
  category: CustomPatternCategory;
  /** Synthesized regex source string (without delimiters). */
  proposedPattern: string;
  proposedFlags: string;
  /** Human-readable structural characteristics discovered. */
  characteristics: WizardCharacteristic[];
  /** Per-example match results — indexed parallel to input `examples`. */
  matchResults: WizardMatchResult[];
  /**
   * Fraction of examples matched (0..1).
   * Raw example values are never returned.
   */
  qualityScore: number;
  /** Potential limitations or caveats about the proposed pattern. */
  limitations: string[];
}

export interface PatternTestResult {
  /** Index into the input testCases array. */
  caseIndex: number;
  matched: boolean;
  /** Number of matches found without returning the matched text. */
  matchCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Safety utilities
// ─────────────────────────────────────────────────────────────────────────────

const MAX_PATTERN_LENGTH = 512;
const ALLOWED_FLAGS_RE = /^[gim]*$/;
const SAFE_REGEX_GRAMMAR = /^(?:(?:\\[^\r\n]|[A-Za-z0-9_./:#@,;'"~!$%&+=-]|\[(?:\\.|[^\]\r\n])*\])(?:[*+?]|\{\d+(?:,\d*)?\})?)+$/;

function hasRiskyQuantifiedGroup(source: string): boolean {
  const groups: number[] = [];
  let escaped = false;
  let inClass = false;

  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "[") {
      inClass = true;
      continue;
    }
    if (character === "]") {
      inClass = false;
      continue;
    }
    if (inClass) continue;
    if (character === "(") {
      groups.push(index);
      continue;
    }
    if (character !== ")" || groups.length === 0) continue;
    const start = groups.pop();
    if (start === undefined) continue;
    const next = source[index + 1];
    if (next !== "+" && next !== "*" && !/^\{\d+(?:,\d*)?\}/.test(source.slice(index + 1))) continue;
    const body = source.slice(start + 1, index).replace(/^\?(?:[:=!]|<=[^)]*|<![^)]*)/, "").replace(/\\./g, "");
    if (/[+*?|{]/.test(body) || body.includes("(")) return true;
  }
  return false;
}

function hasAdjacentQuantifiers(source: string): boolean {
  const atom = String.raw`(?:\\[dDwWsSbB]|\[(?:\\.|[^\]])+\]|\\.|[A-Za-z0-9_])`;
  const quantifier = String.raw`(?:[*+?]|\{\d+(?:,\d*)?\})`;
  return new RegExp(`${atom}${quantifier}${atom}${quantifier}`).test(source);
}

function hasBackreferenceOrLookaround(source: string): boolean {
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (escaped) {
      if (/[1-9k]/.test(character)) return true;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (source.startsWith("(?=", index) || source.startsWith("(?!", index) || source.startsWith("(?<=", index) || source.startsWith("(?<!", index)) {
      return true;
    }
  }
  return false;
}

export function isSafeRegex(source: string, flags: string = "g"): boolean {
  if (!source || source.length > MAX_PATTERN_LENGTH) return false;
  if (!SAFE_REGEX_GRAMMAR.test(source)) return false;
  if (!ALLOWED_FLAGS_RE.test(flags)) return false;
  if (hasRiskyQuantifiedGroup(source) || hasAdjacentQuantifiers(source) || hasBackreferenceOrLookaround(source)) return false;
  try {
    const re = new RegExp(source, flags.replace("g", ""));
    if (re.test("")) return false;
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Low-level structural analysis helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Count per-position character class membership across all examples. */
interface CharClassCounts {
  upper: number; // [A-Z]
  lower: number; // [a-z]
  digit: number; // [0-9]
  separator: number; // -./_ and spaces
  other: number;
}

function classifyChar(ch: string): keyof CharClassCounts {
  if (/[A-Z]/.test(ch)) return "upper";
  if (/[a-z]/.test(ch)) return "lower";
  if (/[0-9]/.test(ch)) return "digit";
  if (/[-./_ ]/.test(ch)) return "separator";
  return "other";
}

function dominantClass(counts: CharClassCounts): string {
  const entries = Object.entries(counts) as [keyof CharClassCounts, number][];
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (total === 0) return "other";
  const [cls] = entries.reduce(
    (best, cur) => (cur[1] > best[1] ? cur : best),
    entries[0]
  );
  return cls;
}

function charClassToPattern(cls: string): string {
  switch (cls) {
    case "upper": return "[A-Z]";
    case "lower": return "[a-z]";
    case "digit": return "\\d";
    case "separator": return "[-./_ ]";
    default: return ".";
  }
}

/** Longest common prefix across examples, requiring ≥60% coverage. */
function commonPrefix(examples: string[]): string {
  if (examples.length === 0) return "";
  const threshold = Math.ceil(examples.length * 0.6);
  const shortest = examples.reduce(
    (a, b) => (a.length <= b.length ? a : b),
    examples[0]
  );
  let prefix = "";
  for (let i = 0; i < shortest.length; i++) {
    const ch = shortest[i];
    const count = examples.filter((e) => e[i] === ch).length;
    if (count >= threshold) {
      prefix += ch;
    } else {
      break;
    }
  }
  return prefix;
}

/** Longest common suffix across examples, requiring ≥60% coverage. */
function commonSuffix(examples: string[]): string {
  if (examples.length === 0) return "";
  const reversed = examples.map((e) => [...e].reverse().join(""));
  const rev = commonPrefix(reversed);
  return [...rev].reverse().join("");
}

/** Detect a consistent separator character that appears in most examples. */
function detectSeparator(examples: string[]): string | null {
  const candidates = ["-", ".", "/", "_", " "];
  const threshold = Math.ceil(examples.length * 0.6);
  for (const sep of candidates) {
    const count = examples.filter((e) => e.includes(sep)).length;
    if (count >= threshold) return sep;
  }
  return null;
}

/** Length statistics. */
function lengthStats(examples: string[]): {
  min: number;
  max: number;
  median: number;
} {
  const lengths = examples.map((e) => e.length).sort((a, b) => a - b);
  const min = lengths[0] ?? 0;
  const max = lengths[lengths.length - 1] ?? 0;
  const mid = Math.floor(lengths.length / 2);
  const median = lengths[mid] ?? 0;
  return { min, max, median };
}

/** Escape a literal string for use inside a regex. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function generalizeLiteral(value: string): string {
  return [...value]
    .map((character) => {
      if (/[A-Z]/.test(character)) return "[A-Z]";
      if (/[a-z]/.test(character)) return "[a-z]";
      if (/[0-9]/.test(character)) return "\\d";
      if (/[^\x20-\x7E]/.test(character)) return ".";
      return escapeRegex(character);
    })
    .join("");
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern synthesis
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a regex pattern from structural analysis of the examples.
 *
 * Strategy (deterministic, no AI):
 * 1. If examples have a fixed common prefix, anchor it literally.
 * 2. Detect separator character.
 * 3. Split examples by separator (if found) into segments.
 * 4. For each segment position, determine dominant character class and length.
 * 5. Assemble into a full pattern with optional suffix anchoring.
 */
function synthesizePattern(
  examples: string[],
  prefix: string,
  suffix: string,
  separator: string | null
): { pattern: string; characteristics: WizardCharacteristic[] } {
  const characteristics: WizardCharacteristic[] = [];

  // Strip prefix/suffix before analysing the body.
  const bodies = examples.map((e) => {
    let b = e;
    if (prefix && b.startsWith(prefix)) b = b.slice(prefix.length);
    if (suffix && b.endsWith(suffix)) b = b.slice(0, b.length - suffix.length);
    return b;
  });

  const stats = lengthStats(bodies);
  characteristics.push({
    label: "Length range",
    detail: `${stats.min}–${stats.max} characters (median ${stats.median})`,
  });

  let patternParts: string[] = [];

  if (prefix) {
    patternParts.push(generalizeLiteral(prefix));
    characteristics.push({
      label: "Common prefix",
      detail: `${prefix.length} characters present in ≥60% of examples`,
    });
  }

  if (separator) {
    const sepEsc =
      separator === "-"
        ? "\\-"
        : separator === "."
        ? "\\."
        : escapeRegex(separator);
    // Analyse each segment separately.
    const segments = bodies.map((b) => b.split(separator));
    const maxSegs = segments.reduce((m, s) => Math.max(m, s.length), 0);
    const segPatterns: string[] = [];
    for (let si = 0; si < maxSegs; si++) {
      const segExamples = segments
        .map((s) => s[si] ?? "")
        .filter((s) => s.length > 0);
      if (segExamples.length === 0) continue;
      const segStats = lengthStats(segExamples);
      const counts: CharClassCounts = {
        upper: 0,
        lower: 0,
        digit: 0,
        separator: 0,
        other: 0,
      };
      for (const e of segExamples) {
        for (const ch of e) counts[classifyChar(ch)]++;
      }
      const dom = dominantClass(counts);
      const cls = charClassToPattern(dom);
      if (segStats.min === segStats.max) {
        segPatterns.push(`${cls}{${segStats.min}}`);
      } else {
        segPatterns.push(`${cls}{${segStats.min},${segStats.max}}`);
      }
    }
    patternParts.push(segPatterns.join(sepEsc));
    characteristics.push({
      label: "Separator detected",
      detail: `"${separator}" used as segment delimiter`,
    });
    for (let si = 0; si < segPatterns.length; si++) {
      const segExamples = bodies
        .map((b) => b.split(separator)[si] ?? "")
        .filter((s) => s.length > 0);
      const segStats = lengthStats(segExamples);
      characteristics.push({
        label: `Segment ${si + 1}`,
        detail: `${segStats.min}–${segStats.max} chars`,
      });
    }
  } else {
    // No separator — treat as a single homogeneous token.
    const counts: CharClassCounts = {
      upper: 0,
      lower: 0,
      digit: 0,
      separator: 0,
      other: 0,
    };
    for (const e of bodies) {
      for (const ch of e) counts[classifyChar(ch)]++;
    }
    const dom = dominantClass(counts);
    const cls = charClassToPattern(dom);

    if (stats.min === stats.max) {
      patternParts.push(`${cls}{${stats.min}}`);
      characteristics.push({
        label: "Fixed length",
        detail: `Exactly ${stats.min} characters`,
      });
    } else {
      patternParts.push(`${cls}{${stats.min},${stats.max}}`);
      characteristics.push({
        label: "Variable length",
        detail: `${stats.min}–${stats.max} characters`,
      });
    }
    characteristics.push({
      label: "Character class",
      detail: `Primarily ${dom} characters`,
    });
  }

  if (suffix) {
    patternParts.push(generalizeLiteral(suffix));
    characteristics.push({
      label: "Common suffix",
      detail: `${suffix.length} characters present in ≥60% of examples`,
    });
  }

  return { pattern: patternParts.join(""), characteristics };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyze an array of example strings and produce a proposed detection pattern.
 *
 * CONTRACT: The returned `WizardAnalysis` contains only structural statistics
 * and match counts. Raw example text is not stored or returned in any field
 * of the result.
 */
export function analyzeExamples(
  examples: string[],
  category: CustomPatternCategory,
  negativeExamples: string[] = []
): WizardAnalysis {
  const trimmed = examples
    .map((e) => e.trim())
    .filter((e) => e.length > 0)
    .slice(0, 50); // Hard cap: never process more than 50 examples

  if (trimmed.length === 0) {
    return {
      category,
      proposedPattern: ".+",
      proposedFlags: "g",
      characteristics: [],
      matchResults: [],
      qualityScore: 0,
      limitations: ["No valid examples provided."],
    };
  }

  const prefix = commonPrefix(trimmed);
  const suffix = commonSuffix(trimmed);
  const separator = detectSeparator(
    trimmed.map((e) => {
      let b = e;
      if (prefix && b.startsWith(prefix)) b = b.slice(prefix.length);
      if (suffix && b.endsWith(suffix)) b = b.slice(0, b.length - suffix.length);
      return b;
    })
  );

  const { pattern: bodyPattern, characteristics } = synthesizePattern(
    trimmed,
    prefix,
    suffix,
    separator
  );

  // Wrap with word boundaries for safety.
  const proposedPattern = `\\b${bodyPattern}\\b`;
  const proposedFlags = "gi";

  // Test against examples — capture matched value only, not full example.
  const matchResults: WizardMatchResult[] = trimmed.map((example, i) => {
    if (!isSafeRegex(proposedPattern, proposedFlags)) {
      return { exampleIndex: i, matched: false, matchCount: 0 };
    }
    let matchCount = 0;
    try {
      const re = new RegExp(proposedPattern, proposedFlags);
      let match: RegExpExecArray | null;
      while ((match = re.exec(example)) !== null && matchCount < 1000) {
        matchCount += 1;
        if (match[0].length === 0) re.lastIndex += 1;
      }
    } catch {
      return { exampleIndex: i, matched: false, matchCount: 0 };
    }
    return { exampleIndex: i, matched: matchCount > 0, matchCount };
  });

  const matchCount = matchResults.filter((r) => r.matched).length;
  const qualityScore = trimmed.length > 0 ? matchCount / trimmed.length : 0;
  const negativeMatches = negativeExamples.some((example) =>
    testPattern(proposedPattern, proposedFlags, [example]).some((result) => result.matched)
  );

  const limitations: string[] = [];
  if (qualityScore < 1) {
    limitations.push(
      `The proposed pattern matched ${matchCount} of ${trimmed.length} examples. Review unmatched examples and adjust.`
    );
  }
  if (negativeMatches) {
    limitations.push("The proposed pattern matched at least one negative example. Review it before saving.");
  }
  if (trimmed.length < 5) {
    limitations.push(
      "Fewer than 5 examples were provided. More examples improve pattern quality."
    );
  }
  if (!prefix && !separator) {
    limitations.push(
      "No common prefix or separator was detected. The pattern may have a higher false-positive rate."
    );
  }
  limitations.push(
    "This is a proposed pattern only. Test it thoroughly before adding it to your local logic."
  );

  return {
    category,
    proposedPattern,
    proposedFlags,
    characteristics,
    matchResults,
    qualityScore,
    limitations,
  };
}

/**
 * Test a user-supplied or wizard-proposed pattern against a list of test cases.
 *
 * Returns per-case results. Errors (invalid regex, timeout-heuristic breach)
 * are reported as non-matches rather than exceptions.
 */
export function testPattern(
  patternSource: string,
  flags: string,
  testCases: string[]
): PatternTestResult[] {
  if (!isSafeRegex(patternSource, flags)) {
    return testCases.map((_, i) => ({ caseIndex: i, matched: false, matchCount: 0 }));
  }

  const effectiveFlags = flags.includes("g") ? flags : `${flags}g`;
  let re: RegExp;
  try {
    re = new RegExp(patternSource, effectiveFlags);
  } catch {
    return testCases.map((_, i) => ({ caseIndex: i, matched: false, matchCount: 0 }));
  }

  const results: PatternTestResult[] = [];
  for (let caseIndex = 0; caseIndex < testCases.length; caseIndex++) {
    re.lastIndex = 0;
    let matchCount = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(testCases[caseIndex])) !== null && matchCount < 1000) {
      matchCount += 1;
      if (match[0].length === 0) re.lastIndex += 1;
    }
    results.push({ caseIndex, matched: matchCount > 0, matchCount });
  }
  return results;
}
