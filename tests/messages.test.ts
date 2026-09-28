// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect } from "vitest";
import { validateMessage } from "../src/shared/messages.js";
import type { Finding } from "../src/shared/types.js";

function sampleFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    category: "email",
    confidence: 0.92,
    source: "local-rules",
    preview: "j***@example.com",
    nodeId: "seg_0",
    startOffset: 0,
    endOffset: 16,
    rects: [{ x: 0, y: 0, width: 100, height: 20 }],
    selected: true,
    ...overrides,
  };
}

describe("validateMessage", () => {
  it("accepts a well-formed SCAN_PAGE message", () => {
    const result = validateMessage({
      type: "SCAN_PAGE",
      requestId: "req-1",
      mode: "local",
      sessionId: "sess-1",
      settings: { enabledCategories: ["email"], maxVisibleChars: 100, maxNodeChars: 50, maskPlaceholders: true, sessionTimeoutMs: 900000 },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects SCAN_PAGE without the maskPlaceholders flag", () => {
    const result = validateMessage({
      type: "SCAN_PAGE",
      requestId: "req-1",
      mode: "local",
      sessionId: "sess-1",
      settings: { enabledCategories: ["email"], maxVisibleChars: 100, maxNodeChars: 50 },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects unknown message types", () => {
    const result = validateMessage({ type: "TOTALLY_MADE_UP", requestId: "r" });
    expect(result.ok).toBe(false);
  });

  it("rejects malformed findings", () => {
    const result = validateMessage({
      type: "SCAN_RESULT",
      requestId: "r",
      sessionId: "s",
      findings: [{ id: "x", category: "not-a-category" }],
      stats: { visibleChars: 1, truncated: false },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects oversized messages", () => {
    const big = "x".repeat(70 * 1024);
    const result = validateMessage({ type: "SCAN_RESULT", requestId: "r", sessionId: "s", findings: [], stats: { visibleChars: 0, truncated: false }, padding: big });
    expect(result.ok).toBe(false);
  });

  it("rejects a finding with an invalid preview (raw value leaking)", () => {
    const result = validateMessage({
      type: "SCAN_RESULT",
      requestId: "r",
      sessionId: "s",
      findings: [sampleFinding({ preview: "jane.doe@example.com" })],
      stats: { visibleChars: 1, truncated: false },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects non-canonical finding metadata", () => {
    const invalidAttribute = validateMessage({
      type: "SCAN_RESULT",
      requestId: "r",
      sessionId: "s",
      findings: [sampleFinding({ attribute: { raw: "SYNTHETIC-RAW-VALUE" } as never })],
      stats: { visibleChars: 1, truncated: false },
    });
    expect(invalidAttribute.ok).toBe(false);

    const invalidId = validateMessage({
      type: "SCAN_RESULT",
      requestId: "r",
      sessionId: "s",
      findings: [sampleFinding({ id: "SYNTHETIC-RAW-VALUE" })],
      stats: { visibleChars: 1, truncated: false },
    });
    expect(invalidId.ok).toBe(false);
  });

  it("canonicalizes custom pattern messages before persistence", () => {
    const pattern = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      name: "Policy Number",
      category: "custom",
      pattern: "POL-\\d{6}",
      flags: "gi",
      captureGroup: 0,
      confidence: 0.9,
      createdAt: "2026-09-23T12:00:00.000Z",
      source: "local",
      contributionStatus: "local_only",
      rawExample: "PRIVATE-RAW-VALUE",
    };
    const result = validateMessage({ type: "POPUP_CUSTOM_PATTERN_SAVE", requestId: "r", pattern });
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "POPUP_CUSTOM_PATTERN_SAVE") {
      expect(result.message.pattern).not.toHaveProperty("rawExample");
    }
  });

  it("strips unknown fields from accepted findings", () => {
    const result = validateMessage({
      type: "SCAN_RESULT",
      requestId: "r",
      sessionId: "s",
      findings: [{ ...sampleFinding(), unexpected: "SYNTHETIC-RAW-VALUE" }],
      stats: { visibleChars: 1, truncated: false },
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "SCAN_RESULT") {
      expect(result.message.findings[0]).not.toHaveProperty("unexpected");
    }
  });

  it("accepts a valid SCAN_RESULT", () => {
    const result = validateMessage({
      type: "SCAN_RESULT",
      requestId: "r",
      sessionId: "s",
      findings: [sampleFinding()],
      stats: { visibleChars: 100, truncated: false },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects invalid modes", () => {
    const result = validateMessage({ type: "POPUP_SCAN", requestId: "r", mode: "telepathic" });
    expect(result.ok).toBe(false);
  });

  it("accepts POPUP_STATE pushes from the worker", () => {
    const result = validateMessage({
      type: "POPUP_STATE",
      requestId: "r",
      state: {
        mode: "local",
        scanning: false,
        findings: [sampleFinding()],
        scanned: true,
        truncated: false,
        visibleChars: 10,
        consentRequired: false,
      },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a well-formed POPUP_DOC_PREVIEW", () => {
    const result = validateMessage({
      type: "POPUP_DOC_PREVIEW",
      requestId: "r",
      fileKey: "fkey-1",
      name: "record.pdf",
      mimeType: "application/pdf",
      kind: "pdf",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects POPUP_DOC_PREVIEW without a valid fileKey", () => {
    const result = validateMessage({
      type: "POPUP_DOC_PREVIEW",
      requestId: "r",
      fileKey: "bad key",
      name: "record.pdf",
      mimeType: "application/pdf",
      kind: "pdf",
    });
    expect(result.ok).toBe(false);
  });

  it("accepts a well-formed POPUP_DOC_REDACT", () => {
    const result = validateMessage({
      type: "POPUP_DOC_REDACT",
      requestId: "r",
      docId: "doc-1",
      fileKey: "fkey-1",
      name: "record.pdf",
      mimeType: "application/pdf",
      kind: "pdf",
      boxes: [{ pageIndex: 0, rects: [{ x: 1, y: 2, width: 10, height: 4 }] }],
      findingIds: ["doc:0:0"],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects POPUP_DOC_REDACT with a negative rect coordinate", () => {
    const result = validateMessage({
      type: "POPUP_DOC_REDACT",
      requestId: "r",
      docId: "doc-1",
      fileKey: "fkey-1",
      name: "record.pdf",
      mimeType: "application/pdf",
      kind: "pdf",
      boxes: [{ pageIndex: 0, rects: [{ x: -1, y: 2, width: 10, height: 4 }] }],
      findingIds: ["doc:0:0"],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects POPUP_DOC_REDACT without findingIds", () => {
    const result = validateMessage({
      type: "POPUP_DOC_REDACT",
      requestId: "r",
      docId: "doc-1",
      fileKey: "fkey-1",
      name: "record.pdf",
      mimeType: "application/pdf",
      kind: "pdf",
      boxes: [{ pageIndex: 0, rects: [{ x: 1, y: 2, width: 10, height: 4 }] }],
    });
    expect(result.ok).toBe(false);
  });

  it("accepts a POPUP_DOC_STATE with masked previews only", () => {
    const result = validateMessage({
      type: "POPUP_DOC_STATE",
      requestId: "r",
      docId: "doc-1",
      name: "record.pdf",
      fileKey: "fkey-1",
      mimeType: "application/pdf",
      kind: "pdf",
      pages: [
        {
          index: 0,
          widthPx: 800,
          heightPx: 1000,
          previewKey: "e2e-photo::preview::0",
          findings: [sampleFinding()],
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects POPUP_DOC_STATE whose preview is not a data URL", () => {
    const result = validateMessage({
      type: "POPUP_DOC_STATE",
      requestId: "r",
      docId: "doc-1",
      name: "record.pdf",
      fileKey: "fkey-1",
      mimeType: "application/pdf",
      kind: "pdf",
      pages: [{ index: 0, widthPx: 800, heightPx: 1000, previewKey: "../../etc/passwd", findings: [] }],
    });
    expect(result.ok).toBe(false);
  });

  it("accepts POPUP_DOC_DONE and POPUP_DOC_ERROR", () => {
    expect(validateMessage({ type: "POPUP_DOC_DONE", requestId: "r", outputName: "record-redacted.pdf" }).ok).toBe(true);
    expect(
      validateMessage({ type: "POPUP_DOC_ERROR", requestId: "r", code: "DOC_ERROR", userMessage: "nope" }).ok
    ).toBe(true);
  });

  it("accepts POPUP_DOC_CLEAR", () => {
    expect(validateMessage({ type: "POPUP_DOC_CLEAR", requestId: "r", docId: "doc-1" }).ok).toBe(true);
  });

  it("validates POPUP_SET_NOTIFICATIONS", () => {
    expect(validateMessage({ type: "POPUP_SET_NOTIFICATIONS", requestId: "r", enabled: true }).ok).toBe(true);
    expect(validateMessage({ type: "POPUP_SET_NOTIFICATIONS", requestId: "r", enabled: "yes" }).ok).toBe(false);
  });

  it("validates POPUP_ACCOUNT_SAVE (https origin + gw_ key)", () => {
    expect(
      validateMessage({ type: "POPUP_ACCOUNT_SAVE", requestId: "r", gatewayOrigin: "https://api.governworld.acrlogic.com", apiKey: "gw_live_abcd1234" }).ok
    ).toBe(true);
    expect(
      validateMessage({ type: "POPUP_ACCOUNT_SAVE", requestId: "r", gatewayOrigin: "http://api.governworld.acrlogic.com", apiKey: "gw_live_abcd1234" }).ok
    ).toBe(false);
    expect(
      validateMessage({ type: "POPUP_ACCOUNT_SAVE", requestId: "r", gatewayOrigin: "https://api.governworld.acrlogic.com", apiKey: "not-a-key" }).ok
    ).toBe(false);
  });

  it("accepts POPUP_ACCOUNT_CLEAR", () => {
    expect(validateMessage({ type: "POPUP_ACCOUNT_CLEAR", requestId: "r" }).ok).toBe(true);
  });

  it("validates POPUP_ACCOUNT_PURCHASE", () => {
    expect(validateMessage({ type: "POPUP_ACCOUNT_PURCHASE", requestId: "r", planId: "redaction-extension-addon" }).ok).toBe(true);
    expect(validateMessage({ type: "POPUP_ACCOUNT_PURCHASE", requestId: "r", planId: "" }).ok).toBe(false);
    expect(validateMessage({ type: "POPUP_ACCOUNT_PURCHASE", requestId: "r", planId: 42 }).ok).toBe(false);
  });

  it("validates POPUP_ACCOUNT_STATE responses", () => {
    expect(
      validateMessage({ type: "POPUP_ACCOUNT_STATE", requestId: "r", gatewayOrigin: "https://api.governworld.acrlogic.com", linked: true, accountLabel: "ACR LOGIC" }).ok
    ).toBe(true);
    expect(
      validateMessage({ type: "POPUP_ACCOUNT_STATE", requestId: "r", gatewayOrigin: null, linked: false }).ok
    ).toBe(true);
    expect(
      validateMessage({ type: "POPUP_ACCOUNT_STATE", requestId: "r", gatewayOrigin: "https://api.governworld.acrlogic.com", linked: true, error: { code: "X", userMessage: "nope" } }).ok
    ).toBe(true);
    expect(
      validateMessage({ type: "POPUP_ACCOUNT_STATE", requestId: "r", gatewayOrigin: "https://api.governworld.acrlogic.com", linked: true, credentialAvailable: false }).ok
    ).toBe(true);
    expect(
      validateMessage({ type: "POPUP_ACCOUNT_STATE", requestId: "r", gatewayOrigin: "https://api.governworld.acrlogic.com", linked: true, credentialAvailable: "yes" }).ok
    ).toBe(false);
    expect(
      validateMessage({ type: "POPUP_ACCOUNT_STATE", requestId: "r", gatewayOrigin: "http://api.governworld.acrlogic.com", linked: true }).ok
    ).toBe(false);
  });

  it("validates POPUP_ACCOUNT_PURCHASE_URL", () => {
    expect(validateMessage({ type: "POPUP_ACCOUNT_PURCHASE_URL", requestId: "r", url: "https://checkout.stripe.com/c/pay/abc" }).ok).toBe(true);
    expect(validateMessage({ type: "POPUP_ACCOUNT_PURCHASE_URL", requestId: "r", url: "" }).ok).toBe(false);
  });
});