// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect } from "vitest";
import { detect, maskValue, maskContext, resolveOverlaps, placeholderLabelFor } from "../src/content/detect.js";

describe("detect", () => {
  const ALL = [
    "email",
    "phone",
    "ssn",
    "dob",
    "medical_record_number",
    "member_id",
    "npi",
    "dea",
    "mbi",
    "address",
    "payment_card",
    "secrets",
    "possible_name",
  ] as const;

  it("detects emails", () => {
    const [match] = detect("Contact jane.doe@example.com for details.", [...ALL]);
    expect(match.category).toBe("email");
    expect(match.value).toBe("jane.doe@example.com");
  });

  it("detects US phones and rejects invalid exchanges", () => {
    const text = "Call (415) 555-1234 or 212-867-5309 now.";
    const matches = detect(text, [...ALL]);
    const phones = matches.filter((m) => m.category === "phone");
    expect(phones).toHaveLength(2);
  });

  it("detects SSNs only in valid dash form or with context", () => {
    const text = "SSN 123-45-6789 and 000-12-3456 and social 123456789";
    const matches = detect(text, [...ALL]);
    const ssns = matches.filter((m) => m.category === "ssn");
    expect(ssns).toHaveLength(2); // 123-45-6789 + context-tagged bare form
  });

  it("detects DOB only with contextual cues", () => {
    const withCue = detect("Date of birth: 04/22/1990", [...ALL]);
    const withoutCue = detect("Order 04/22/1990 shipped today", [...ALL]);
    expect(withCue.filter((m) => m.category === "dob")).toHaveLength(1);
    expect(withoutCue.filter((m) => m.category === "dob")).toHaveLength(0);
  });

  it("detects medical record numbers by label", () => {
    const text = "MRN: 884310 and record # AX-9921";
    const matches = detect(text, [...ALL]);
    expect(matches.filter((m) => m.category === "medical_record_number").length).toBeGreaterThanOrEqual(2);
  });

  it("detects member ids by label", () => {
    const text = "Member ID: 7788990";
    const matches = detect(text, [...ALL]);
    expect(matches.filter((m) => m.category === "member_id")).toHaveLength(1);
  });

  it("detects payment cards only when Luhn-valid", () => {
    const valid = "4111111111111111"; // passes Luhn
    const invalid = "4111111111111112";
    const matches = detect(`Card ${valid} and ${invalid}`, [...ALL]);
    const cards = matches.filter((m) => m.category === "payment_card");
    expect(cards).toHaveLength(1);
    expect(cards[0].value).toBe(valid);
  });

  it("detects possible names after contextual labels", () => {
    const text = "Patient Name: Jane Q Public";
    const matches = detect(text, [...ALL]);
    expect(matches.filter((m) => m.category === "possible_name")).toHaveLength(1);
  });

  it("detects NPIs when label-bound or Luhn-valid", () => {
    const text = "Provider NPI: 1234567893 and asset tag 1993999998";
    const matches = detect(text, [...ALL]);
    const npis = matches.filter((m) => m.category === "npi");
    expect(npis.length).toBeGreaterThanOrEqual(1);
    expect(npis[0].value).toBe("1234567893");
  });

  it("does not flag a bare invalid-checksum 10-digit run as NPI", () => {
    const text = "Reference 1234567890 was logged";
    const matches = detect(text, [...ALL]);
    expect(matches.filter((m) => m.category === "npi")).toHaveLength(0);
  });

  it("detects DEA registration numbers with a valid checksum", () => {
    const text = "DEA number AB1234563 on file";
    const matches = detect(text, [...ALL]);
    expect(matches.filter((m) => m.category === "dea")).toHaveLength(1);
  });

  it("rejects DEA-shaped runs with an invalid checksum", () => {
    const text = "Order AB1234567 was shipped";
    const matches = detect(text, [...ALL]);
    expect(matches.filter((m) => m.category === "dea")).toHaveLength(0);
  });

  it("detects label-bound Medicare Beneficiary IDs", () => {
    const text = "MBI 1EG4-TE5-MK73 per coverage";
    const matches = detect(text, [...ALL]);
    expect(matches.filter((m) => m.category === "mbi")).toHaveLength(1);
  });

  it("does not flag generic alphanumeric runs as MBI without a Medicare label", () => {
    const text = "Order ref 1EG4-TE5-MK73 processed";
    const matches = detect(text, [...ALL]);
    expect(matches.filter((m) => m.category === "mbi")).toHaveLength(0);
  });

  it("detects API keys and secrets", () => {
    const text =
      "database postgres://user:secret123456@db.internal:5432/main and token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c and api_key=a1b2c3d4e5f6g7h8i9j0k1l2m3n4";
    const matches = detect(text, [...ALL]);
    const secrets = matches.filter((m) => m.category === "secrets");
    expect(secrets.length).toBeGreaterThanOrEqual(3);
  });

  it("does not flag placeholder secrets", () => {
    const text = "sample key sk_test_abc123 and example password changeme";
    const matches = detect(text, [...ALL]);
    expect(matches.filter((m) => m.category === "secrets")).toHaveLength(0);
  });

  it("masks a secret keeping only a leading character visible", () => {
    expect(maskValue("secrets", "sk_proj_abcdef")).toBe("s***");
  });

  it("maps every category to a short uppercase placeholder label", () => {
    expect(placeholderLabelFor("ssn")).toBe("SSN");
    expect(placeholderLabelFor("dob")).toBe("DOB");
    expect(placeholderLabelFor("payment_card")).toBe("CARD");
    expect(placeholderLabelFor("secrets")).toBe("API KEY");
    expect(placeholderLabelFor("possible_name")).toBe("NAME");
    expect(placeholderLabelFor("medical_record_number")).toBe("MRN");
  });

  it("detects structured addresses", () => {
    const text = "Ship to 123 Main Street, Springfield, IL 62704";
    const matches = detect(text, [...ALL]);
    expect(matches.filter((m) => m.category === "address")).toHaveLength(1);
  });

  it("does not flag every number as sensitive", () => {
    const text = "Invoice total is $1,234.56 with reference 78492.";
    const matches = detect(text, [...ALL]);
    expect(matches.length).toBe(0);
  });

  it("resolves overlaps keeping the higher-priority span", () => {
    const overlapping = [
      { category: "email" as const, confidence: 0.92, value: "a@b.com", start: 0, end: 10 },
      { category: "possible_name" as const, confidence: 0.52, value: "a@b.com extra", start: 0, end: 18 },
    ];
    const merged = resolveOverlaps(overlapping);
    expect(merged).toHaveLength(1);
    expect(merged[0].category).toBe("email");
  });
});

describe("maskValue", () => {
  it("never reveals the full email value", () => {
    expect(maskValue("email", "jane.doe@example.com")).toBe("j***@example.com");
  });
  it("masks phone digits except the last four", () => {
    expect(maskValue("phone", "(415) 555-1234")).toMatch(/^\*\*\*-\*\*\*-1234$/);
  });
  it("masks SSNs fully", () => {
    expect(maskValue("ssn", "123-45-6789")).toMatch(/^\*\*\*-\*\*-\d{4}$/);
  });
  it("masks card numbers except the last four", () => {
    expect(maskValue("payment_card", "4111111111111111")).toMatch(/^\*{12}\d{4}$/);
  });
  it("does not contain the raw value in any masked output", () => {
    const values = ["jane.doe@example.com", "(415) 555-1234", "123-45-6789", "4111111111111111"];
    for (const value of values) {
      for (const category of ["email", "phone", "ssn", "payment_card", "medical_record_number", "member_id"] as const) {
        expect(maskValue(category, value)).not.toContain(value);
      }
    }
  });
});

describe("maskContext", () => {
  it("replaces every token with a mask", () => {
    const out = maskContext("MRN 123456 seen on discharge notes");
    expect(out).not.toContain("123456");
    expect(out).not.toContain("MRN");
    expect(out).not.toContain("discharge");
  });
});