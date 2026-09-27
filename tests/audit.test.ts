// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect } from "vitest";
import {
  isAuditEvent,
  canonicalEventLine,
  toAuditJsonl,
  trimEvents,
  AUDIT_MAX_EVENTS,
  type AuditEvent,
} from "../src/shared/audit.js";

const base: AuditEvent = { ts: "2026-08-21T00:00:00.000Z", action: "page_scan_completed", outcome: "ok" };

describe("audit event validation", () => {
  it("accepts a minimal valid event", () => {
    expect(isAuditEvent(base)).toBe(true);
  });

  it("accepts full events", () => {
    expect(
      isAuditEvent({
        ...base,
        host: "example.com",
        counts: { email: 2, ssn: 1 },
        docHash: "a".repeat(64),
        pages: 3,
      })
    ).toBe(true);
  });

  it("rejects unknown actions and outcomes", () => {
    expect(isAuditEvent({ ...base, action: "exfiltrate" })).toBe(false);
    expect(isAuditEvent({ ...base, outcome: "allowed" })).toBe(false);
  });

  it("rejects malformed hashes, hosts, counts, pages", () => {
    expect(isAuditEvent({ ...base, docHash: "xyz" })).toBe(false);
    expect(isAuditEvent({ ...base, host: "" })).toBe(false);
    expect(isAuditEvent({ ...base, counts: { email: -1 } })).toBe(false);
    expect(isAuditEvent({ ...base, pages: 1.5 })).toBe(false);
    expect(isAuditEvent(null)).toBe(false);
  });

  it("accepts preset audit events with policy-reference metadata", () => {
    expect(
      isAuditEvent({ ...base, action: "preset_applied", presetId: "hipaa", enabledCategories: ["ssn", "email"], outcome: "ok" })
    ).toBe(true);
    expect(
      isAuditEvent({ ...base, action: "preset_overridden", presetId: "hipaa", enabledCategories: ["ssn"], outcome: "ok" })
    ).toBe(true);
    expect(isAuditEvent({ ...base, action: "preset_applied", presetId: 42 })).toBe(false);
    expect(isAuditEvent({ ...base, action: "preset_applied", enabledCategories: [""] })).toBe(false);
  });
});

describe("canonical serialization", () => {
  it("emits stable key order regardless of construction order", () => {
    const a = canonicalEventLine({ outcome: "ok", ts: base.ts, action: base.action });
    const b = canonicalEventLine({ ts: base.ts, action: base.action, outcome: "ok" });
    expect(a).toBe(b);
    expect(a.indexOf('"ts"')).toBeLessThan(a.indexOf('"action"'));
  });

  it("omits undefined fields", () => {
    const line = canonicalEventLine(base);
    expect(line).not.toContain("host");
    expect(line).not.toContain("docHash");
  });

  it("serializes preset metadata in stable order", () => {
    const line = canonicalEventLine({ ...base, action: "preset_overridden", presetId: "hipaa", enabledCategories: ["ssn", "email"] });
    expect(line).toContain('"presetId":"hipaa"');
    expect(line.indexOf('"presetId"')).toBeLessThan(line.indexOf('"enabledCategories"'));
  });

  it("joins jsonl with newlines only", () => {
    const jsonl = toAuditJsonl([base, { ...base, action: "masks_applied" }]);
    expect(jsonl.split("\n")).toHaveLength(2);
  });
});

describe("ring buffer trim", () => {
  it("keeps the newest entries within cap", () => {
    const many: AuditEvent[] = Array.from({ length: AUDIT_MAX_EVENTS + 10 }, (_, i) => ({
      ...base,
      ts: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(4, "0")}Z`,
      pages: i,
    }));
    const trimmed = trimEvents(many);
    expect(trimmed).toHaveLength(AUDIT_MAX_EVENTS);
    expect(trimmed[trimmed.length - 1].pages).toBe(AUDIT_MAX_EVENTS + 9);
  });

  it("returns the input untouched when under cap", () => {
    const few = [base];
    expect(trimEvents(few)).toBe(few);
  });
});
