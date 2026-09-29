// Rule-acceptance gate. Enforces the thresholds decided in
// docs/community-trust-model.md section 10.4, so they are a mechanism rather
// than a sentence in a document that nothing reads.
//
// This is publisher-side tooling: it runs before a rule is allowed into a
// community pack. It is not shipped in the extension and imports nothing from
// it, deliberately - the gate must be able to fail closed even if the detector
// has a bug, so it does not depend on the detector to decide what is safe.
//
//   node scripts/rule-gate.mjs <rule.json>
//
// Rule file shape:
//   { "label": "...", "category": "...", "pattern": "...", "flags": "gi",
//     "confidence": 0.8,
//     "labelledPositive": ["strings that should match"],
//     "labelledNegative": ["strings that must not match"],
//     "benignCorpus": ["ordinary documents that contain nothing sensitive"],
//     "distinctRealExamples": 40,
//     "reportedFalsePositive": false }
//
// Exit code 0 only if every gate passes.

import { readFileSync } from "node:fs";

export const THRESHOLDS = {
  /** Fraction of labelled positives that must be a true positive. */
  minPrecision: 0.98,
  /** Benign documents allowed to match, per 20,000 for ordinary categories. */
  maxBenignFalsePositivesPer20k: 1,
  /** Stricter for `secrets`: a false positive there corrupts config files. */
  maxBenignFalsePositivesPer20kSecrets: 0.1,
  /** A rule matching fewer distinct real examples is tuned to one sample. */
  minDistinctRealExamples: 25,
  /** Budget for a 200k-character hostile input. */
  redosBudgetMs: 250,
  /** Constructs refused outright, at any confidence. */
  prohibitedConstructs: [
    { name: "lookbehind", re: /\(\?<[=!]/ },
    { name: "backreference", re: /\\[1-9]/ },
    { name: "nested quantifier", re: /\((?:[^()]*[+*][^()]*)\)[+*]/ },
  ],
};

const HOSTILE_INPUTS = [
  "a".repeat(200_000),
  "a.".repeat(100_000),
  "a-".repeat(100_000),
  "a@b.".repeat(50_000),
  "(" .repeat(2_000) + "a" + ")".repeat(2_000),
  "1".repeat(200_000),
  "AKIA" + "A".repeat(200_000),
  "https://hooks.slack.com/services/" + "a".repeat(200_000),
  "TKT-" + "9".repeat(200_000),
  "\\".repeat(50_000),
];

export function evaluateGates(rule) {
  const failures = [];
  const notes = [];

  // ── static shape ──────────────────────────────────────────────────────────
  for (const { name, re } of THRESHOLDS.prohibitedConstructs) {
    if (re.test(rule.pattern)) failures.push(`prohibited construct: ${name}`);
  }
  if (typeof rule.confidence !== "number" || rule.confidence < 0 || rule.confidence > 1) {
    failures.push("confidence must be a number in [0,1]");
  }

  // ── labelled precision ────────────────────────────────────────────────────
  const positives = Array.isArray(rule.labelledPositive) ? rule.labelledPositive : [];
  const negatives = Array.isArray(rule.labelledNegative) ? rule.labelledNegative : [];
  if (positives.length === 0) failures.push("no labelled positives supplied");

  let re = null;
  try {
    re = new RegExp(rule.pattern, rule.flags ?? "g");
  } catch (e) {
    failures.push(`pattern does not compile: ${e.message}`);
  }

  if (re) {
    let hits = 0;
    for (const s of positives) if (new RegExp(rule.pattern, rule.flags ?? "g").test(s)) hits++;
    const precision = positives.length ? hits / positives.length : 0;
    notes.push(`precision ${(precision * 100).toFixed(2)}% (${hits}/${positives.length})`);
    if (precision < THRESHOLDS.minPrecision) {
      failures.push(
        `precision ${(precision * 100).toFixed(2)}% is below the ${(THRESHOLDS.minPrecision * 100).toFixed(0)}% floor`,
      );
    }

    // A labelled negative that matches is a known false positive. Measured
    // precision above does not account for it, and it is the most actionable
    // signal a rule author has.
    const falseNegatives = negatives.filter((s) => new RegExp(rule.pattern, rule.flags ?? "g").test(s));
    if (falseNegatives.length > 0) {
      failures.push(`matches ${falseNegatives.length} labelled negative(s)`);
    }

    // ── benign corpus ───────────────────────────────────────────────────────
    const benign = Array.isArray(rule.benignCorpus) ? rule.benignCorpus : [];
    if (benign.length === 0) {
      failures.push("no benign corpus supplied; the false-positive rate cannot be measured");
    } else {
      const budget =
        rule.category === "secrets"
          ? THRESHOLDS.maxBenignFalsePositivesPer20kSecrets
          : THRESHOLDS.maxBenignFalsePositivesPer20k;
      const rate = (benign.length * 20_000) / budget;
      const fp = benign.filter((s) => new RegExp(rule.pattern, rule.flags ?? "g").test(s)).length;
      notes.push(
        `benign FP ${fp}/${benign.length}` +
          ` = ${((fp / benign.length) * 20000).toFixed(2)} per 20k` +
          ` (budget ${budget})`,
      );
      if (fp / benign.length > budget / 20_000) {
        failures.push(
          `benign false-positive rate exceeds the budget of ${budget} per 20,000`,
        );
      }
      void rate;
    }
  }

  // ── sample sufficiency ────────────────────────────────────────────────────
  const distinct = Number(rule.distinctRealExamples ?? 0);
  if (distinct < THRESHOLDS.minDistinctRealExamples) {
    failures.push(
      `only ${distinct} distinct real examples; ${THRESHOLDS.minDistinctRealExamples} required`,
    );
  }

  // ── ReDoS, measured ───────────────────────────────────────────────────────
  if (re) {
    let worst = 0;
    for (const input of HOSTILE_INPUTS) {
      const t0 = Date.now();
      try {
        new RegExp(rule.pattern, rule.flags ?? "g").test(input);
      } catch {
        /* a throw on hostile input is a failure too, handled below */
      }
      worst = Math.max(worst, Date.now() - t0);
    }
    notes.push(`worst hostile-input time ${worst}ms (budget ${THRESHOLDS.redosBudgetMs}ms)`);
    if (worst > THRESHOLDS.redosBudgetMs) {
      failures.push(`ReDoS: ${worst}ms on a 200k hostile input, budget is ${THRESHOLDS.redosBudgetMs}ms`);
    }
  }

  // ── process gate ──────────────────────────────────────────────────────────
  if (rule.reportedFalsePositive === true) {
    failures.push("a user has reported this rule as a false positive; it needs review, not publishing");
  }

  return { failures, notes };
}

// CLI
if (process.argv[1] && process.argv[1].endsWith("rule-gate.mjs")) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node scripts/rule-gate.mjs <rule.json>");
    process.exit(2);
  }
  const rule = JSON.parse(readFileSync(file, "utf8"));
  const { failures, notes } = evaluateGates(rule);
  for (const n of notes) console.log(`  note: ${n}`);
  for (const f of failures) console.log(`  FAIL: ${f}`);
  if (failures.length === 0) {
    console.log(`\nPASS: "${rule.label}" meets every acceptance gate.`);
    process.exit(0);
  }
  console.log(`\n${failures.length} gate(s) failed: "${rule.label}" is not publishable.`);
  process.exit(1);
}
