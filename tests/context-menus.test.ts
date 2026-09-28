// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect } from "vitest";
import { validateMessage } from "../src/shared/messages.js";

describe("Context Menus - Message Validation", () => {
  it("validates CONTEXT_REDACT_SELECTION message without selectionText", () => {
    const res = validateMessage({
      type: "CONTEXT_REDACT_SELECTION",
      requestId: "req-123",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.message.type).toBe("CONTEXT_REDACT_SELECTION");
      expect(res.message.requestId).toBe("req-123");
    }
  });

  it("validates CONTEXT_REDACT_SELECTION message with selectionText and settings", () => {
    const res = validateMessage({
      type: "CONTEXT_REDACT_SELECTION",
      requestId: "req-123",
      selectionText: "Contact test@example.com",
      settings: {
        enabledCategories: ["email", "ssn"],
        maxVisibleChars: 500000,
        maxNodeChars: 20000,
        maskPlaceholders: true,
        sessionTimeoutMs: 900000,
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.message.type).toBe("CONTEXT_REDACT_SELECTION");
      if ("selectionText" in res.message) {
        expect(res.message.selectionText).toBe("Contact test@example.com");
      }
    }
  });

  it("rejects CONTEXT_REDACT_SELECTION with invalid selectionText", () => {
    const res = validateMessage({
      type: "CONTEXT_REDACT_SELECTION",
      requestId: "req-123",
      selectionText: 12345,
    });
    expect(res.ok).toBe(false);
  });

  it("validates CONTEXT_MASK_SELECTION message without selectionText", () => {
    const res = validateMessage({
      type: "CONTEXT_MASK_SELECTION",
      requestId: "req-456",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.message.type).toBe("CONTEXT_MASK_SELECTION");
      expect(res.message.requestId).toBe("req-456");
    }
  });

  it("validates CONTEXT_MASK_SELECTION message with selectionText and settings", () => {
    const res = validateMessage({
      type: "CONTEXT_MASK_SELECTION",
      requestId: "req-456",
      selectionText: "Confidential text",
      settings: {
        enabledCategories: ["secrets"],
        maxVisibleChars: 100000,
        maxNodeChars: 10000,
        maskPlaceholders: false,
        sessionTimeoutMs: 900000,
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.message.type).toBe("CONTEXT_MASK_SELECTION");
      if ("selectionText" in res.message) {
        expect(res.message.selectionText).toBe("Confidential text");
      }
    }
  });

  it("rejects CONTEXT_MASK_SELECTION with invalid settings", () => {
    const res = validateMessage({
      type: "CONTEXT_MASK_SELECTION",
      requestId: "req-456",
      settings: "invalid-settings",
    });
    expect(res.ok).toBe(false);
  });
});
