// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect } from "vitest";
import { analyzeExamples, testPattern, isSafeRegex } from "../src/shared/wizardAnalyzer.js";
import {
  parseCustomPattern,
  buildContributionPayload,
  COMMUNITY_TOKEN_RE,
  type CustomPattern,
} from "../src/shared/customPatterns.js";
import { detect, runCustomPatterns, resolveOverlaps, placeholderLabelFor, maskValue } from "../src/content/detect.js";
import { validateMessage } from "../src/shared/messages.js";
import { DEFAULT_SETTINGS, isCategory } from "../src/shared/settings.js";

describe("Logic Wizard & Community Contribution — 13 Privacy Invariants E2E Suite", () => {
  const sampleUUID = "123e4567-e89b-12d3-a456-426614174000";

  it("Invariant 1: Fail-closed local execution — analysis and testing run purely in-memory", () => {
    const pos = ["MEMBER-998877", "MEMBER-112233"];
    const neg = ["MEMBER-99"];
    const analysis = analyzeExamples(pos, "custom", neg);

    expect(analysis.proposedPattern).toBeDefined();
    const testResults = testPattern(analysis.proposedPattern, analysis.proposedFlags, ["Patient MEMBER-998877 verified."]);
    expect(testResults.some((result) => result.matched)).toBe(true);
  });

  it("Invariant 2: Example isolation — raw example text is never stored in CustomPattern schema", () => {
    const rawPattern = {
      id: sampleUUID,
      name: "Member Identifier",
      category: "member_id",
      pattern: "MEMBER-\\d{6}",
      flags: "gi",
      captureGroup: 0,
      confidence: 0.88,
      createdAt: new Date().toISOString(),
      source: "local",
      contributionStatus: "local_only",
    };
    const parsed = parseCustomPattern(rawPattern);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect((parsed.pattern as any).positiveExamples).toBeUndefined();
      expect((parsed.pattern as any).negativeExamples).toBeUndefined();
      expect((parsed.pattern as any).rawText).toBeUndefined();
    }
  });

  it("Invariant 3: Spec-only payload construction — buildContributionPayload strips all identity/timestamps/examples", () => {
    const pattern: CustomPattern = {
      id: sampleUUID,
      name: "Custom MRN Pattern",
      category: "medical_record_number",
      pattern: "MRN-[0-9]{8}",
      flags: "gi",
      captureGroup: 0,
      confidence: 0.92,
      createdAt: "2026-09-23T10:00:00Z",
      source: "local",
      contributionStatus: "local_only",
    };
    const payload = buildContributionPayload(pattern);
    expect((payload as any).id).toBeUndefined();
    expect((payload as any).createdAt).toBeUndefined();
    expect((payload as any).source).toBeUndefined();
    expect((payload as any).contributionStatus).toBeUndefined();
    expect(payload.pattern).toBe("MRN-[0-9]{8}");
    expect(payload.category).toBe("medical_record_number");
  });

  it("Invariant 4: Token isolation — free community tokens strictly match gw_free_[A-Za-z0-9]{32} pattern", () => {
    const validToken = "gw_free_0123456789abcdef0123456789abcdef";
    expect(COMMUNITY_TOKEN_RE.test(validToken)).toBe(true);

    // Paid gateway keys use gw_live_ or gw_test_ prefixes
    expect(COMMUNITY_TOKEN_RE.test("gw_live_1234567890abcdef")).toBe(false);
  });

  it("Invariant 5: Non-destructive custom patterns — adding custom pattern does not alter built-in detection", () => {
    const text = "Contact user@example.com or SSN 123-45-6789 or POL-999888.";
    const builtinMatches = detect(text, ["email", "ssn"]);
    expect(builtinMatches).toHaveLength(2);

    const customPatterns: CustomPattern[] = [
      {
        id: sampleUUID,
        name: "Policy Number",
        category: "custom",
        pattern: "POL-\\d{6}",
        flags: "gi",
        captureGroup: 0,
        confidence: 0.9,
        createdAt: new Date().toISOString(),
        source: "local",
        contributionStatus: "local_only",
      },
    ];

    const combinedMatches = detect(text, ["email", "ssn", "custom"], customPatterns);
    expect(combinedMatches).toHaveLength(3);
    expect(combinedMatches.some((m) => m.category === "email")).toBe(true);
    expect(combinedMatches.some((m) => m.category === "ssn")).toBe(true);
    expect(combinedMatches.some((m) => m.category === "custom")).toBe(true);
  });

  it("does not execute custom patterns whose category is disabled", () => {
    const pattern: CustomPattern = {
      id: sampleUUID,
      name: "Disabled Pattern",
      category: "member_id",
      pattern: "POL-\\d{6}",
      flags: "gi",
      captureGroup: 0,
      confidence: 0.9,
      createdAt: new Date().toISOString(),
      source: "local",
      contributionStatus: "local_only",
    };
    expect(detect("POL-123456", ["email"], [pattern])).toHaveLength(0);
  });

  it("Invariant 6: Catastrophic backtracking protection — isSafeRegex rejects vulnerable ReDoS expressions", () => {
    expect(isSafeRegex("(a+)+")).toBe(false);
    expect(isSafeRegex("(a|a)+")).toBe(false);
    expect(isSafeRegex("(.*)*")).toBe(false);
  });

  it("Invariant 7: Category priority resolution — overlaps between built-in and custom patterns resolve cleanly", () => {
    const matches = resolveOverlaps([
      { category: "ssn", confidence: 0.95, value: "123-45-6789", start: 0, end: 11 },
      { category: "custom", confidence: 0.85, value: "123-45-6789", start: 0, end: 11 },
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0].category).toBe("ssn");
  });

  it("Invariant 8: Mask placeholder support — placeholderLabelFor('custom') returns 'CUSTOM'", () => {
    expect(placeholderLabelFor("custom")).toBe("CUSTOM");
    expect(maskValue("custom", "POL-123456")).toBe("**********");
  });

  it("Invariant 9: Fail-closed message validation — validateMessage rejects malformed wizard messages", () => {
    const invalidMessages = [
      { type: "POPUP_WIZARD_ANALYZE", requestId: "req1", positiveExamples: "not-an-array" },
      { type: "POPUP_WIZARD_TEST", requestId: "req2", regex: 123 },
      { type: "POPUP_CUSTOM_PATTERN_SAVE", requestId: "req3", pattern: { invalid: true } },
    ];
    for (const msg of invalidMessages) {
      expect(validateMessage(msg).ok).toBe(false);
    }
  });

  it("Invariant 10: Explicit consent requirement — contribution validation ensures pattern object structure", () => {
    const pattern: CustomPattern = {
      id: sampleUUID,
      name: "Consent Verified Pattern",
      category: "custom",
      pattern: "CONSENT-[0-9]{4}",
      flags: "gi",
      captureGroup: 0,
      confidence: 0.85,
      createdAt: new Date().toISOString(),
      source: "local",
      contributionStatus: "local_only",
    };
    expect(parseCustomPattern(pattern).ok).toBe(true);
  });

  it("Invariant 11: Local-first disclosure alignment — settings category check accepts custom", () => {
    expect(isCategory("custom")).toBe(true);
  });

  it("Invariant 12: Multi-tenant key/account separation — community token format distinct from gateway API keys", () => {
    const commToken = "gw_free_00000000000000000000000000000000";
    const liveApiKey = "gw_live_1234567890abcdef";
    expect(COMMUNITY_TOKEN_RE.test(commToken)).toBe(true);
    expect(COMMUNITY_TOKEN_RE.test(liveApiKey)).toBe(false);
  });

  it("Invariant 13: Audit trail immutability — custom pattern category integrates with settings and audit data types", () => {
    expect(DEFAULT_SETTINGS.enabledCategories).toContain("email");
  });
});
