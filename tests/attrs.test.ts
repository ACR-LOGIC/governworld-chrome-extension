// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect } from "vitest";
import {
  SCANNED_ATTRIBUTES,
  applySelectionExcludingAttrs,
  attributeAt,
  buildAttrScan,
  collectAttrRecords,
} from "../src/content/attrs.js";
import type { AttrElementLike, AttrRecord } from "../src/content/attrs.js";
import { detect, maskValue } from "../src/content/detect.js";
import type { Finding, FindingCategory } from "../src/shared/types.js";

const ALL = [
  "email",
  "phone",
  "ssn",
  "dob",
  "medical_record_number",
  "member_id",
  "address",
  "payment_card",
  "possible_name",
] as const;

/** Fake element that records every mutation attempt but is never mutated. */
function fakeEl(attrs: Record<string, string>, excludedBy?: string) {
  const mutations: string[] = [];
  return {
    mutations,
    getAttribute(name: string): string | null {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    setAttribute(name: string): void {
      mutations.push(`setAttribute:${name}`);
    },
    removeAttribute(name: string): void {
      mutations.push(`removeAttribute:${name}`);
    },
    closest(selector: string): unknown {
      return excludedBy !== undefined && selector.includes(excludedBy) ? {} : null;
    },
  };
}

function fakeRoot(elements: AttrElementLike[]) {
  return {
    querySelectorAll(_selector: string): Iterable<AttrElementLike> {
      return elements;
    },
  };
}

describe("SCANNED_ATTRIBUTES", () => {
  it("covers exactly the four supported accessibility attributes", () => {
    expect([...SCANNED_ATTRIBUTES]).toEqual(["aria-label", "alt", "placeholder", "title"]);
  });
});

describe("collectAttrRecords", () => {
  it("collects synthetic values from every supported attribute", () => {
    const root = fakeRoot([
      fakeEl({ "aria-label": "Contact jane.doe@example.com for records" }),
      fakeEl({ alt: "Card 4111 1111 1111 1111 on file" }),
      fakeEl({ placeholder: "Phone like 212-555-0142" }),
      fakeEl({ title: "SSN 123-45-6789 on file" }),
    ]);
    const { records, truncated } = collectAttrRecords(root, { maxTotalChars: 5000, maxPerValue: 2048 });
    expect(truncated).toBe(false);
    expect(records).toHaveLength(4);
    const byName = new Map(records.map((r) => [r.attributeName, r.value]));
    expect(byName.get("aria-label")).toContain("jane.doe@example.com");
    expect(byName.get("alt")).toContain("4111 1111 1111 1111");
    expect(byName.get("placeholder")).toContain("212-555-0142");
    expect(byName.get("title")).toContain("123-45-6789");
  });

  it("skips elements inside exclusion markers", () => {
    const root = fakeRoot([
      fakeEl({ "aria-label": "hidden@example.com" }, "data-gw-scan-overlay"),
      fakeEl({ title: "ignored@example.com" }, "data-sensitive-scan-ignore"),
      fakeEl({ alt: "kept@example.com" }),
    ]);
    const { records } = collectAttrRecords(root, { maxTotalChars: 5000, maxPerValue: 2048 });
    expect(records).toEqual([{ attributeName: "alt", value: "kept@example.com" }]);
  });

  it("collapses whitespace and drops empty values", () => {
    const root = fakeRoot([
      fakeEl({ title: "  Multi\nline\tvalue  " }),
      fakeEl({ placeholder: "   " }),
    ]);
    const { records } = collectAttrRecords(root, { maxTotalChars: 5000, maxPerValue: 2048 });
    expect(records).toEqual([{ attributeName: "title", value: "Multi line value" }]);
  });

  it("enforces the total character budget and reports truncation", () => {
    const root = fakeRoot([
      fakeEl({ "aria-label": "abcdefgh" }),
      fakeEl({ title: "ijklmnop" }),
      fakeEl({ alt: "qrstuvwx" }),
    ]);
    const { records, truncated } = collectAttrRecords(root, { maxTotalChars: 12, maxPerValue: 8 });
    expect(truncated).toBe(true);
    expect(records.map((r) => r.attributeName)).toEqual(["aria-label", "title"]);
  });
});

describe("buildAttrScan + attributeAt", () => {
  it("joins records and maps offsets back to the exact attribute name", () => {
    const records: AttrRecord[] = [
      { attributeName: "aria-label", value: "abc" },
      { attributeName: "placeholder", value: "defghi" },
      { attributeName: "title", value: "jkl" },
    ];
    const scan = buildAttrScan(records);
    expect(scan.combined).toBe("abc\ndefghi\njkl");
    expect(scan.segmentStarts).toEqual([0, 4, 11]);
    expect(attributeAt(scan, 0)).toBe("aria-label");
    expect(attributeAt(scan, 5)).toBe("placeholder");
    expect(attributeAt(scan, 12)).toBe("title");
    expect(attributeAt(scan, -1)).toBe("");
    expect(attributeAt(scan, 999)).toBe("");
  });
});

describe("attribute findings are report-only", () => {
  it("detects sensitive values in attributes and tags source/attribute", () => {
    const root = fakeRoot([
      fakeEl({ "aria-label": "Email jane.doe@example.com" }),
      fakeEl({ title: "Call 212-555-0142 today" }),
      fakeEl({ alt: "SSN 123-45-6789" }),
      fakeEl({ placeholder: "Card 4111 1111 1111 1111" }),
    ]);
    const { records } = collectAttrRecords(root, { maxTotalChars: 5000, maxPerValue: 2048 });
    const scan = buildAttrScan(records);
    const matches = detect(scan.combined, ALL as unknown as FindingCategory[]);
    const categories = new Set(matches.map((m) => m.category));
    expect(categories.has("email")).toBe(true);
    expect(categories.has("phone")).toBe(true);
    expect(categories.has("ssn")).toBe(true);
    expect(categories.has("payment_card")).toBe(true);

    for (const match of matches) {
      expect(attributeAt(scan, match.start)).toBeTruthy();
      // Preview is always the masked form, never the raw value.
      expect(maskValue(match.category, match.value)).not.toContain(match.value);
    }
  });

  it("never allows attribute findings to become selected", () => {
    const attrFinding: Finding = {
      id: "attr_email_0_20_0",
      category: "email",
      confidence: 0.9,
      source: "attr",
      preview: "j***@example.com",
      nodeId: "",
      startOffset: 0,
      endOffset: 20,
      rects: [],
      selected: false,
      attribute: "aria-label",
    };
    const textFinding: Finding = {
      id: "email_30_50_1",
      category: "email",
      confidence: 0.9,
      source: "local-rules",
      preview: "b***@example.com",
      nodeId: "seg_3",
      startOffset: 30,
      endOffset: 50,
      rects: [],
      selected: false,
    };
    const result = applySelectionExcludingAttrs([attrFinding, textFinding], new Set([attrFinding.id, textFinding.id]));
    expect(result.find((f) => f.source === "attr")?.selected).toBe(false);
    expect(result.find((f) => f.source === "local-rules")?.selected).toBe(true);
  });

  it("does not mutate DOM elements during collection or scanning", () => {
    const el1 = fakeEl({ "aria-label": "Email jane.doe@example.com" });
    const el2 = fakeEl({ alt: "SSN 123-45-6789", title: "MRN: A1B2C3" });
    const root = fakeRoot([el1, el2]);
    collectAttrRecords(root, { maxTotalChars: 5000, maxPerValue: 2048 });
    buildAttrScan([
      { attributeName: "aria-label", value: "x" },
      { attributeName: "alt", value: "y" },
    ]);
    expect(el1.mutations).toEqual([]);
    expect(el2.mutations).toEqual([]);
  });
});
