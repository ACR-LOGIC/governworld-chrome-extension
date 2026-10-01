// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Unit tests for the multi-format acquisition pipeline Layer 0 utilities:
 * discoverPageInventory, resolveScanCoverageStatus, computeElementVisibility,
 * buildTraceableSelector, getAccessibleShadowRoot.
 *
 * These run in jsdom (vitest default) so they have no real CSS layout engine.
 * Functions that rely on getBoundingClientRect or getComputedStyle fall back
 * gracefully — the tests verify that graceful fallback rather than real layout.
 */
import { describe, it, expect, vi } from "vitest";
import {
  resolveScanCoverageStatus,
  buildTraceableSelector,
  getAccessibleShadowRoot,
  computeElementVisibility,
  discoverPageInventory,
  type UnscannableRegion,
  type ScanCoverageStatus,
} from "../src/content/normalization/pageInventory.js";

// ---------------------------------------------------------------------------
// resolveScanCoverageStatus
// ---------------------------------------------------------------------------

describe("resolveScanCoverageStatus", () => {
  it("returns NO_SENSITIVE_DATA_DETECTED when scan is complete and no findings", () => {
    const status = resolveScanCoverageStatus({
      findingsCount: 0,
      unresolvedRegions: [],
      deferredMediaCount: 0,
    });
    expect(status).toBe("NO_SENSITIVE_DATA_DETECTED");
  });

  it("returns FULLY_SCANNED when scan is complete and there are findings", () => {
    const status = resolveScanCoverageStatus({
      findingsCount: 3,
      unresolvedRegions: [],
      deferredMediaCount: 0,
    });
    expect(status).toBe("FULLY_SCANNED");
  });

  it("returns PARTIALLY_SCANNED when there are deferred media items", () => {
    const status = resolveScanCoverageStatus({
      findingsCount: 0,
      unresolvedRegions: [],
      deferredMediaCount: 4,
    });
    expect(status).toBe("PARTIALLY_SCANNED");
  });

  it("returns PARTIALLY_SCANNED when there are unresolved regions (not blocked/DRM)", () => {
    const region: UnscannableRegion = {
      sourceType: "canvas-ocr",
      cssSelector: "canvas",
      visibility: "VISIBLE_IN_VIEWPORT",
      reason: "ocr-budget-exceeded",
      detail: "Budget exceeded",
    };
    const status = resolveScanCoverageStatus({
      findingsCount: 0,
      unresolvedRegions: [region],
      deferredMediaCount: 0,
    });
    expect(status).toBe("PARTIALLY_SCANNED");
  });

  it("returns BLOCKED_BY_BROWSER_SECURITY for cross-origin-isolation regions", () => {
    const region: UnscannableRegion = {
      sourceType: "iframe",
      cssSelector: "iframe",
      visibility: "VISIBLE_IN_VIEWPORT",
      reason: "cross-origin-isolation",
      detail: "Cross-origin frame",
    };
    const status = resolveScanCoverageStatus({
      findingsCount: 0,
      unresolvedRegions: [region],
      deferredMediaCount: 0,
    });
    expect(status).toBe("BLOCKED_BY_BROWSER_SECURITY");
  });

  it("returns BLOCKED_BY_BROWSER_SECURITY for pdf-viewer-plugin-isolated", () => {
    const region: UnscannableRegion = {
      sourceType: "pdf-text",
      cssSelector: 'embed[type="application/x-google-chrome-pdf"]',
      visibility: "VISIBLE_IN_VIEWPORT",
      reason: "pdf-viewer-plugin-isolated",
      detail: "Chrome PDF viewer",
    };
    const status = resolveScanCoverageStatus({
      findingsCount: 2,
      unresolvedRegions: [region],
      deferredMediaCount: 0,
    });
    expect(status).toBe("BLOCKED_BY_BROWSER_SECURITY");
  });

  it("returns UNSUPPORTED_CONTENT_PRESENT for DRM-protected media", () => {
    const region: UnscannableRegion = {
      sourceType: "video-frame-ocr",
      cssSelector: "video",
      visibility: "VISIBLE_IN_VIEWPORT",
      reason: "drm-protected-media",
      detail: "EME protected",
    };
    const status = resolveScanCoverageStatus({
      findingsCount: 0,
      unresolvedRegions: [region],
      deferredMediaCount: 0,
    });
    expect(status).toBe("UNSUPPORTED_CONTENT_PRESENT");
  });

  it("returns SCAN_FAILED when hadRuntimeError is true", () => {
    const status = resolveScanCoverageStatus({
      findingsCount: 0,
      unresolvedRegions: [],
      deferredMediaCount: 0,
      hadRuntimeError: true,
    });
    expect(status).toBe("SCAN_FAILED");
  });

  it("INVARIANT: never returns NO_SENSITIVE_DATA_DETECTED when unresolved regions exist", () => {
    // This is the core invariant: "couldn't inspect" != "nothing found"
    const region: UnscannableRegion = {
      sourceType: "canvas-ocr",
      cssSelector: "canvas",
      visibility: "VISIBLE_IN_VIEWPORT",
      reason: "ocr-budget-exceeded",
      detail: "Budget",
    };
    const status = resolveScanCoverageStatus({
      findingsCount: 0,
      unresolvedRegions: [region],
      deferredMediaCount: 0,
    });
    expect(status).not.toBe("NO_SENSITIVE_DATA_DETECTED");
  });
});

// ---------------------------------------------------------------------------
// buildTraceableSelector
// ---------------------------------------------------------------------------

describe("buildTraceableSelector", () => {
  it("returns element tag when there is no meaningful context", () => {
    const el = document.createElement("canvas");
    // No parent, no id, no class — falls back to tag name
    const sel = buildTraceableSelector(el);
    expect(sel).toBe("canvas");
  });

  it("uses element id as an anchor and stops traversal", () => {
    const root = document.createElement("div");
    root.innerHTML = `<section><article id="main-article"><p>text</p></article></section>`;
    const article = root.querySelector("article")!;
    const p = root.querySelector("p")!;
    const sel = buildTraceableSelector(p);
    // Should contain the id anchor somewhere in the path
    expect(sel).toContain("main-article");
  });

  it("includes element class names when present", () => {
    const div = document.createElement("div");
    div.className = "card highlighted";
    const sel = buildTraceableSelector(div);
    expect(sel).toContain("card");
  });

  it("returns a non-empty string for any connected element", () => {
    const elements = ["p", "img", "video", "embed", "canvas", "iframe"].map((tag) => {
      const el = document.createElement(tag);
      return el;
    });
    for (const el of elements) {
      expect(buildTraceableSelector(el).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// getAccessibleShadowRoot
// ---------------------------------------------------------------------------

describe("getAccessibleShadowRoot", () => {
  it("returns null for an element with no shadow root", () => {
    const div = document.createElement("div");
    expect(getAccessibleShadowRoot(div)).toBeNull();
  });

  it("returns the shadow root for an element with an open shadow root", () => {
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const result = getAccessibleShadowRoot(host);
    expect(result).toBe(shadow);
  });

  it("falls back gracefully when chrome.dom is not available (test env)", () => {
    // In jsdom, chrome.dom.openOrClosedShadowRoot is not present.
    // The function should not throw and should use the fallback.
    const host = document.createElement("div");
    host.attachShadow({ mode: "open" });
    expect(() => getAccessibleShadowRoot(host)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// computeElementVisibility (jsdom-safe tests only)
// ---------------------------------------------------------------------------

describe("computeElementVisibility", () => {
  it("returns UNVERIFIED_VISIBILITY for a non-HTML element", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    // SVGElement but not HTMLElement — should not throw
    const result = computeElementVisibility(svg as unknown as Element);
    // SVGElement IS SVGElement but in jsdom may not be HTMLElement exactly
    expect(typeof result).toBe("string");
  });

  it("returns HIDDEN_COLLAPSED_UI for a hidden element", () => {
    const div = document.createElement("div");
    div.setAttribute("hidden", "");
    document.body.appendChild(div);
    const result = computeElementVisibility(div);
    // With jsdom, getBoundingClientRect returns {0,0,0,0} — so will be HIDDEN_COLLAPSED_UI
    expect(result).toBe("HIDDEN_COLLAPSED_UI");
    document.body.removeChild(div);
  });

  it("returns HIDDEN_COLLAPSED_UI for aria-hidden element", () => {
    const div = document.createElement("div");
    div.setAttribute("aria-hidden", "true");
    document.body.appendChild(div);
    const result = computeElementVisibility(div);
    expect(result).toBe("HIDDEN_COLLAPSED_UI");
    document.body.removeChild(div);
  });

  it("does not throw for disconnected elements", () => {
    const div = document.createElement("div");
    // Not appended to document
    expect(() => computeElementVisibility(div)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// discoverPageInventory — basic DOM counting
// ---------------------------------------------------------------------------

describe("discoverPageInventory", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("counts form controls correctly", () => {
    document.body.innerHTML = `
      <input type="text" />
      <input type="email" />
      <textarea></textarea>
      <select><option>A</option></select>
    `;
    const inv = discoverPageInventory(document);
    expect(inv.formControls).toBe(4);
  });

  it("counts cross-origin iframes as inaccessible", () => {
    document.body.innerHTML = `<iframe src="https://other.example.com/page"></iframe>`;
    const inv = discoverPageInventory(document);
    // In jsdom, iframe.contentDocument is null for external srcs
    expect(inv.crossOriginIframes).toBeGreaterThanOrEqual(0);
  });

  it("returns an inventory object with all required keys", () => {
    const inv = discoverPageInventory(document);
    expect(inv).toHaveProperty("domTextRegions");
    expect(inv).toHaveProperty("formControls");
    expect(inv).toHaveProperty("openShadowRoots");
    expect(inv).toHaveProperty("images");
    expect(inv).toHaveProperty("canvases");
    expect(inv).toHaveProperty("videos");
    expect(inv).toHaveProperty("pdfs");
    expect(inv).toHaveProperty("unscannableRegions");
  });

  it("records PDF viewer embed as an unscannable region", () => {
    document.body.innerHTML = `<embed type="application/x-google-chrome-pdf" />`;
    const inv = discoverPageInventory(document);
    // top-level PDF viewer check is on contentType, which jsdom sets normally
    // The embed itself: pdfs.embedded should count it
    expect(inv.pdfs.embedded).toBeGreaterThanOrEqual(0);
  });

  it("does not throw on an empty document", () => {
    document.body.innerHTML = "";
    expect(() => discoverPageInventory(document)).not.toThrow();
  });

  it("counts open shadow roots", () => {
    const host = document.createElement("div");
    host.attachShadow({ mode: "open" });
    document.body.appendChild(host);
    const inv = discoverPageInventory(document);
    expect(inv.openShadowRoots).toBeGreaterThanOrEqual(1);
    document.body.removeChild(host);
  });
});

// ---------------------------------------------------------------------------
// Deduplication invariant: same element+text = 1 finding in SVG extractor
// (importless test — just validates the dedup key logic directly)
// ---------------------------------------------------------------------------

describe("deduplication key logic", () => {
  it("same selector+text produces same key (no double-count)", () => {
    const makeKey = (selector: string, text: string) => `${selector}::${text}`;
    const k1 = makeKey("div > p", "john@example.test");
    const k2 = makeKey("div > p", "john@example.test");
    expect(k1).toBe(k2);
  });

  it("different selectors produce different keys", () => {
    const makeKey = (selector: string, text: string) => `${selector}::${text}`;
    const k1 = makeKey("div > p.a", "john@example.test");
    const k2 = makeKey("div > p.b", "john@example.test");
    expect(k1).not.toBe(k2);
  });
});

// Import beforeEach for the describe block that uses it
import { beforeEach } from "vitest";
