// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect } from "vitest";
import { analyzeExamples, testPattern, isSafeRegex } from "../src/shared/wizardAnalyzer.js";

describe("wizardAnalyzer", () => {
  describe("isSafeRegex", () => {
    it("accepts valid, safe regular expressions", () => {
      expect(isSafeRegex("POL-\\d{6}")).toBe(true);
      expect(isSafeRegex("[A-Z]{3}-\\d{4}")).toBe(true);
      expect(isSafeRegex("ACC-[0-9]{8,12}")).toBe(true);
    });

    it("rejects dangerous or catastrophic backtracking patterns", () => {
      expect(isSafeRegex("(a+)+")).toBe(false);
      expect(isSafeRegex("(a*)*")).toBe(false);
      expect(isSafeRegex("(.*)*")).toBe(false);
      expect(isSafeRegex("a+a+a+a+a+a+a+a+a+a+b")).toBe(false);
      expect(isSafeRegex("(a+)\\1+$")).toBe(false);
      expect(isSafeRegex("a(?=b)")).toBe(false);
      expect(isSafeRegex("a|b")).toBe(false);
      expect(isSafeRegex("(?:ab)+")).toBe(false);
      expect(isSafeRegex("")).toBe(false);
    });

    it("rejects oversized regex strings (>512 chars)", () => {
      const huge = "a".repeat(513);
      expect(isSafeRegex(huge)).toBe(false);
    });
  });

  describe("analyzeExamples", () => {
    it("produces a deterministic pattern for uniform examples", () => {
      const examples = ["POL-123456", "POL-987654", "POL-456789"];
      const analysis = analyzeExamples(examples, "custom");
      expect(analysis.proposedPattern).toBe("\\b[A-Z][A-Z][A-Z]-\\d{6}\\b");
      expect(analysis.qualityScore).toBe(1);
      expect(analysis.matchResults.every((result) => result.matchCount === 1)).toBe(true);
    });

    it("detects common prefix and suffix", () => {
      const examples = ["CLAIM-001-A", "CLAIM-002-A", "CLAIM-003-A"];
      const analysis = analyzeExamples(examples, "custom");
      expect(analysis.proposedPattern).not.toContain("CLAIM");
      expect(analysis.proposedPattern).toContain("[A-Z]");
    });

    it("does not serialize example literals into the proposed pattern", () => {
      const analysis = analyzeExamples(["PRIVATE-123456", "PRIVATE-654321"], "custom");
      expect(analysis.proposedPattern).not.toContain("PRIVATE");
      expect(JSON.stringify(analysis)).not.toContain("PRIVATE");
    });

    it("generalizes non-ASCII example characters", () => {
      const analysis = analyzeExamples(["Ω-样本"], "custom");
      expect(analysis.proposedPattern).not.toContain("Ω");
      expect(analysis.proposedPattern).not.toContain("样本");
    });

    it("returns fallback when no examples are supplied", () => {
      const analysis = analyzeExamples([], "custom");
      expect(analysis.proposedPattern).toBe(".+");
    });
  });

  describe("testPattern", () => {
    it("matches pattern against multiple test strings", () => {
      const pattern = "POL-\\d{6}";
      const flags = "g";
      const cases = [
        "Customer policy POL-123456 and secondary POL-987654.",
        "No match here",
      ];
      const results = testPattern(pattern, flags, cases);
      expect(results).toHaveLength(2);
      expect(results[0].matchCount).toBe(2);
      expect(results[1].matchCount).toBe(0);
      expect(JSON.stringify(results)).not.toContain("POL-123456");
      expect(JSON.stringify(results)).not.toContain("POL-987654");
    });

    it("handles invalid regex syntax gracefully", () => {
      const results = testPattern("POL-[123", "g", ["Sample text"]);
      // All results should be non‑matches
      expect(results.every(r => !r.matched)).toBe(true);
    });

    it("enforces a safe match cap", () => {
      const pattern = "POL-\\d{6}";
      const flags = "g";
      const text = "POL-123456 ".repeat(1500);
      const results = testPattern(pattern, flags, [text]);
      expect(results[0].matchCount).toBe(1000);
    });
  });
});
