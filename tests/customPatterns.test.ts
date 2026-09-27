// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect, beforeEach } from "vitest";
import {
  parseCustomPattern,
  buildContributionPayload,
  COMMUNITY_TOKEN_RE,
  type CustomPattern,
} from "../src/shared/customPatterns.js";

describe("customPatterns", () => {
  const validUUID = "123e4567-e89b-12d3-a456-426614174000";

  const validPatternRaw = {
    id: validUUID,
    name: "Policy Number",
    category: "custom",
    pattern: "POL-\\d{6}",
    flags: "gi",
    captureGroup: 0,
    confidence: 0.9,
    createdAt: "2026-09-23T12:00:00.000Z",
    source: "local",
    contributionStatus: "local_only",
  };

  describe("parseCustomPattern", () => {
    it("parses a valid custom pattern object", () => {
      const res = parseCustomPattern(validPatternRaw);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.pattern.name).toBe("Policy Number");
        expect(res.pattern.pattern).toBe("POL-\\d{6}");
        expect(res.pattern.category).toBe("custom");
      }
    });

    it("rejects non-object or invalid UUIDs", () => {
      expect(parseCustomPattern(null).ok).toBe(false);
      expect(parseCustomPattern("string").ok).toBe(false);
      expect(parseCustomPattern({ ...validPatternRaw, id: "invalid-id" }).ok).toBe(false);
    });

    it("rejects invalid or unsafe regex patterns and flags", () => {
      expect(parseCustomPattern({ ...validPatternRaw, pattern: "POL-[123" }).ok).toBe(false);
      expect(parseCustomPattern({ ...validPatternRaw, pattern: "(a+)+" }).ok).toBe(false);
      expect(parseCustomPattern({ ...validPatternRaw, flags: "gix" }).ok).toBe(false);
    });

    it("rejects out-of-bound confidence scores", () => {
      expect(parseCustomPattern({ ...validPatternRaw, confidence: -0.1 }).ok).toBe(false);
      expect(parseCustomPattern({ ...validPatternRaw, confidence: 1.5 }).ok).toBe(false);
    });
  });

  describe("buildContributionPayload", () => {
    it("strips id, createdAt, and source from contribution payload", () => {
      const patternResult = parseCustomPattern(validPatternRaw);
      expect(patternResult.ok).toBe(true);
      if (patternResult.ok) {
        const payload = buildContributionPayload(patternResult.pattern);
        expect((payload as any).id).toBeUndefined();
        expect((payload as any).createdAt).toBeUndefined();
        expect((payload as any).source).toBeUndefined();
        expect((payload as any).contributionStatus).toBeUndefined();
        expect(payload.name).toBe("Policy Number");
        expect(payload.pattern).toBe("POL-\\d{6}");
      }
    });
  });

  describe("COMMUNITY_TOKEN_RE", () => {
    it("validates free community token format (gw_free_<32 alphanumeric chars>)", () => {
      const validToken = "gw_free_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";
      expect(COMMUNITY_TOKEN_RE.test(validToken)).toBe(true);

      expect(COMMUNITY_TOKEN_RE.test("gw_live_12345678")).toBe(false);
      expect(COMMUNITY_TOKEN_RE.test("gw_free_short")).toBe(false);
      expect(COMMUNITY_TOKEN_RE.test("gw_free_!@#$%^&*()!@#$%^&*()!@#$%^&*()!")).toBe(false);
    });
  });
});
