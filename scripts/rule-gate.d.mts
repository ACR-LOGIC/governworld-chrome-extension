// Type declarations for the publisher-side rule gate. The implementation is
// plain .mjs to match the other scripts/ tooling; this exists so the test that
// imports it typechecks under `tsc --noEmit`.

export interface RuleCandidate {
  label: string;
  category: string;
  pattern: string;
  flags?: string;
  confidence: number;
  /** Strings the rule is expected to match. */
  labelledPositive?: string[];
  /** Strings the rule must not match. */
  labelledNegative?: string[];
  /** Ordinary documents containing nothing sensitive. */
  benignCorpus?: string[];
  /** How many distinct real-world examples the rule was derived from. */
  distinctRealExamples?: number;
  /** True once a user has reported the rule as a false positive. */
  reportedFalsePositive?: boolean;
}

export interface GateThresholds {
  minPrecision: number;
  maxBenignFalsePositivesPer20k: number;
  maxBenignFalsePositivesPer20kSecrets: number;
  minDistinctRealExamples: number;
  redosBudgetMs: number;
  prohibitedConstructs: { name: string; re: RegExp }[];
}

export declare const THRESHOLDS: GateThresholds;

/** Runs every acceptance gate. Returns the failures and the measurements taken. */
export declare function evaluateGates(rule: RuleCandidate): {
  failures: string[];
  notes: string[];
};
