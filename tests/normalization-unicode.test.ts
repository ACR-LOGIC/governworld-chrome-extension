// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect } from "vitest";
import {
  normalizeUnicodeWithMapping,
  mapNormalizedToOriginalOffset,
  mapOriginalToNormalizedOffset,
} from "../src/content/normalization/unicode.js";

describe("normalizeUnicodeWithMapping", () => {
  it("returns unchanged for plain ASCII text", () => {
    const result = normalizeUnicodeWithMapping("hello world");
    expect(result.normalized).toBe("hello world");
    expect(result.changed).toBe(false);
    expect(result.mappings.length).toBe(11);
  });

  it("removes zero-width characters and records mapping", () => {
    const result = normalizeUnicodeWithMapping("h\u200Be\u200Cl\u200Do");
    expect(result.normalized).toBe("helo");
    expect(result.changed).toBe(true);
    expect(result.mappings.length).toBe(4);
    expect(result.mappings[0].originalIndex).toBe(0);
    expect(result.mappings[1].originalIndex).toBe(2);
  });

  it("replaces non-breaking spaces with regular spaces", () => {
    const result = normalizeUnicodeWithMapping("hello\u00A0world");
    expect(result.normalized).toBe("hello world");
    expect(result.changed).toBe(true);
  });

  it("collapses multiple spaces", () => {
    const result = normalizeUnicodeWithMapping("hello  world");
    expect(result.normalized).toBe("hello world");
    expect(result.changed).toBe(true);
  });

  it("handles empty string", () => {
    const result = normalizeUnicodeWithMapping("");
    expect(result.normalized).toBe("");
    expect(result.changed).toBe(false);
    expect(result.mappings.length).toBe(0);
  });

  it("handles emoji and surrogate pairs", () => {
    const result = normalizeUnicodeWithMapping("hello 🌍 world");
    expect(result.normalized).toBe("hello 🌍 world");
    expect(result.changed).toBe(false);
  });

  it("handles RTL text", () => {
    const result = normalizeUnicodeWithMapping("שלום עולם");
    expect(result.normalized).toBe("שלום עולם");
    expect(result.changed).toBe(false);
  });

  it("handles combining characters", () => {
    const result = normalizeUnicodeWithMapping("café");
    expect(result.normalized).toBe("café");
    expect(result.changed).toBe(false);
  });
});

describe("mapNormalizedToOriginalOffset", () => {
  it("maps normalized offset back to original offset", () => {
    const { mappings } = normalizeUnicodeWithMapping("h\u200Be\u200Cl\u200Do");
    expect(mapNormalizedToOriginalOffset(mappings, 0)).toBe(0);
    expect(mapNormalizedToOriginalOffset(mappings, 1)).toBe(2);
    expect(mapNormalizedToOriginalOffset(mappings, 2)).toBe(4);
    expect(mapNormalizedToOriginalOffset(mappings, 3)).toBe(6);
  });

  it("handles out-of-bounds offsets", () => {
    const { mappings } = normalizeUnicodeWithMapping("hello");
    expect(mapNormalizedToOriginalOffset(mappings, -1)).toBe(0);
    expect(mapNormalizedToOriginalOffset(mappings, 99)).toBe(4);
  });

  it("handles empty mapping", () => {
    expect(mapNormalizedToOriginalOffset([], 5)).toBe(5);
  });
});

describe("mapOriginalToNormalizedOffset", () => {
  it("maps original offset to normalized offset", () => {
    const { mappings } = normalizeUnicodeWithMapping("h\u200Be\u200Cl\u200Do");
    expect(mapOriginalToNormalizedOffset(mappings, 0)).toBe(0);
    expect(mapOriginalToNormalizedOffset(mappings, 2)).toBe(1);
    expect(mapOriginalToNormalizedOffset(mappings, 4)).toBe(2);
    expect(mapOriginalToNormalizedOffset(mappings, 6)).toBe(3);
  });

  it("handles missing original offset", () => {
    const { mappings } = normalizeUnicodeWithMapping("hello");
    expect(mapOriginalToNormalizedOffset(mappings, 99)).toBe(99);
  });
});
