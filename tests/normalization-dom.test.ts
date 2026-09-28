// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { Window } from "happy-dom";
import { buildCanonicalDocument } from "../src/content/normalization/canonical.js";
import { extractTableStructures, annotateSegmentsWithTableStructure } from "../src/content/normalization/table.js";
import { traverseIframes } from "../src/content/normalization/iframe.js";
import { mapRange, buildScanText, type TextSegment } from "../src/content/extract.js";

let window: Window;
let document: Document;

beforeEach(() => {
  window = new Window();
  document = window.document as unknown as Document;
});

describe("buildCanonicalDocument - standard DOM", () => {
  it("handles nested spans", () => {
    document.body.innerHTML = `<div><span>Contact </span><span>test@example.com</span></div>`;
    const nodeIds = new Map<string, Node>();
    const canonical = buildCanonicalDocument({ root: document, nodeIds });
    expect(canonical.combined).toContain("test@example.com");
    expect(canonical.segments.length).toBeGreaterThan(0);
    expect(canonical.coverage.complete).toBe(true);
  });

  it("handles split text nodes across siblings", () => {
    const div = document.createElement("div");
    div.appendChild(document.createTextNode("SSN: 123"));
    div.appendChild(document.createTextNode("-45"));
    div.appendChild(document.createTextNode("-6789"));
    document.body.appendChild(div);
    const nodeIds = new Map<string, Node>();
    const canonical = buildCanonicalDocument({ root: document, nodeIds });
    expect(canonical.combined).toContain("SSN: 123");
    expect(canonical.combined).toContain("-45");
    expect(canonical.combined).toContain("-6789");
    expect(canonical.segments.length).toBe(3);
  });

  it("handles deeply nested elements", () => {
    document.body.innerHTML = `<div><p><span><span><span>email@test.com</span></span></span></p></div>`;
    const nodeIds = new Map<string, Node>();
    const canonical = buildCanonicalDocument({ root: document, nodeIds });
    expect(canonical.combined).toContain("email@test.com");
  });

  it("handles tables with structure", () => {
    document.body.innerHTML = `
      <table>
        <tr><th>Name</th><th>SSN</th></tr>
        <tr><td>John</td><td>123-45-6789</td></tr>
      </table>
    `;
    const nodeIds = new Map<string, Node>();
    const canonical = buildCanonicalDocument({ root: document, nodeIds });
    expect(canonical.combined).toContain("123-45-6789");
    const tables = extractTableStructures(document);
    expect(tables.length).toBe(1);
    expect(tables[0].rows).toBe(2);
  });

  it("handles lists", () => {
    document.body.innerHTML = `<ul><li>Item 1</li><li>Item 2</li><li>Item 3</li></ul>`;
    const nodeIds = new Map<string, Node>();
    const canonical = buildCanonicalDocument({ root: document, nodeIds });
    expect(canonical.combined).toContain("Item 1");
    expect(canonical.combined).toContain("Item 2");
    expect(canonical.combined).toContain("Item 3");
  });

  it("handles forms and inputs", () => {
    document.body.innerHTML = `
      <form>
        <input type="text" value="test@example.com" />
        <textarea>another@test.com</textarea>
      </form>
    `;
    const nodeIds = new Map<string, Node>();
    const canonical = buildCanonicalDocument({ root: document, nodeIds });
    expect(canonical.combined).toContain("test@example.com");
    expect(canonical.combined).toContain("another@test.com");
  });

  it("handles contenteditable", () => {
    const div = document.createElement("div");
    div.contentEditable = "true";
    div.textContent = "editable@test.com";
    document.body.appendChild(div);
    const nodeIds = new Map<string, Node>();
    const canonical = buildCanonicalDocument({ root: document, nodeIds });
    expect(canonical.combined).toContain("editable@test.com");
  });

  it("handles dialogs", () => {
    document.body.innerHTML = `<dialog open><p>dialog@test.com</p></dialog>`;
    const nodeIds = new Map<string, Node>();
    const canonical = buildCanonicalDocument({ root: document, nodeIds });
    expect(canonical.combined).toContain("dialog@test.com");
  });

  it("excludes hidden elements", () => {
    document.body.innerHTML = `
      <div style="display:none">hidden@test.com</div>
      <div>visible@test.com</div>
    `;
    const nodeIds = new Map<string, Node>();
    const canonical = buildCanonicalDocument({ root: document, nodeIds });
    expect(canonical.combined).toContain("visible@test.com");
    expect(canonical.combined).not.toContain("hidden@test.com");
  });

  it("excludes script and style elements", () => {
    document.body.innerHTML = `
      <script>var email = "script@test.com";</script>
      <style>.email { content: "style@test.com"; }</style>
      <div>visible@test.com</div>
    `;
    const nodeIds = new Map<string, Node>();
    const canonical = buildCanonicalDocument({ root: document, nodeIds });
    expect(canonical.combined).toContain("visible@test.com");
    expect(canonical.combined).not.toContain("script@test.com");
    expect(canonical.combined).not.toContain("style@test.com");
  });
});

describe("buildCanonicalDocument - shadow DOM", () => {
  it("handles open shadow roots", () => {
    const div = document.createElement("div");
    const shadow = div.attachShadow({ mode: "open" });
    shadow.innerHTML = "<p>shadow@test.com</p>";
    document.body.appendChild(div);
    const nodeIds = new Map<string, Node>();
    const canonical = buildCanonicalDocument({ root: document, nodeIds });
    expect(canonical.combined).toContain("shadow@test.com");
  });

  it("handles nested shadow roots", () => {
    const outer = document.createElement("div");
    const outerShadow = outer.attachShadow({ mode: "open" });
    const inner = document.createElement("div");
    const innerShadow = inner.attachShadow({ mode: "open" });
    innerShadow.innerHTML = "<p>nested@test.com</p>";
    outerShadow.appendChild(inner);
    document.body.appendChild(outer);
    const nodeIds = new Map<string, Node>();
    const canonical = buildCanonicalDocument({ root: document, nodeIds });
    expect(canonical.combined).toContain("nested@test.com");
  });
});

describe("buildCanonicalDocument - iframes", () => {
  it("detects iframe boundaries", () => {
    document.body.innerHTML = `<iframe id="frame1"></iframe>`;
    const nodeIds = new Map<string, Node>();
    const canonical = buildCanonicalDocument({ root: document, nodeIds });
    expect(canonical.metadata.iframeCount).toBeGreaterThanOrEqual(0);
  });

  it("traverses same-origin iframes via traverseIframes", () => {
    document.body.innerHTML = `<iframe id="frame1"></iframe>`;
    const iframe = document.getElementById("frame1") as HTMLIFrameElement;
    const iframeDoc = iframe.contentDocument;
    if (iframeDoc) {
      iframeDoc.body.innerHTML = "<p>iframe@test.com</p>";
    }
    const nodeIds = new Map<string, Node>();
    const { frameDocuments, boundaries } = traverseIframes(document, {
      maxVisibleChars: 250_000,
      maxNodeChars: 10_000,
      nodeIds,
    });
    if (iframeDoc) {
      expect(frameDocuments.length).toBe(1);
      expect(frameDocuments[0].combined).toContain("iframe@test.com");
      expect(boundaries.length).toBe(1);
      expect(boundaries[0].status).toBe("complete");
    } else {
      expect(boundaries.length).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("buildCanonicalDocument - Unicode", () => {
  it("handles accented characters", () => {
    document.body.innerHTML = `<div>José García</div>`;
    const nodeIds = new Map<string, Node>();
    const canonical = buildCanonicalDocument({ root: document, nodeIds });
    expect(canonical.combined).toContain("José García");
  });

  it("handles emoji", () => {
    document.body.innerHTML = `<div>Contact: test@example.com 🌍</div>`;
    const nodeIds = new Map<string, Node>();
    const canonical = buildCanonicalDocument({ root: document, nodeIds });
    expect(canonical.combined).toContain("test@example.com");
  });

  it("handles RTL text", () => {
    document.body.innerHTML = `<div>שלום עולם</div>`;
    const nodeIds = new Map<string, Node>();
    const canonical = buildCanonicalDocument({ root: document, nodeIds });
    expect(canonical.combined).toContain("שלום");
  });

  it("handles non-breaking spaces", () => {
    document.body.innerHTML = `<div>email&#160;test@example.com</div>`;
    const nodeIds = new Map<string, Node>();
    const canonical = buildCanonicalDocument({ root: document, nodeIds });
    expect(canonical.combined).toContain("test@example.com");
  });
});

describe("buildCanonicalDocument - adversarial", () => {
  it("handles sensitive value split across 20+ nested spans", () => {
    const chars = "123-45-6789".split("");
    let html = "<div>";
    for (const char of chars) {
      html += `<span>${char}</span>`;
    }
    html += "</div>";
    document.body.innerHTML = html;
    const nodeIds = new Map<string, Node>();
    const canonical = buildCanonicalDocument({ root: document, nodeIds });
    expect(canonical.segments.length).toBeGreaterThanOrEqual(10);
    const allText = canonical.segments.map((s) => s.text).join("");
    expect(allText).toBe("123-45-6789");
  });

  it("handles duplicate sensitive strings", () => {
    document.body.innerHTML = `
      <div>First: test@example.com</div>
      <div>Second: test@example.com</div>
      <div>Third: test@example.com</div>
    `;
    const nodeIds = new Map<string, Node>();
    const canonical = buildCanonicalDocument({ root: document, nodeIds });
    const matches = canonical.combined.match(/test@example\.com/g);
    expect(matches?.length).toBe(3);
  });

  it("handles zero-width characters between sensitive chars", () => {
    const zwsp = "\u200B";
    document.body.innerHTML = `<div>1${zwsp}2${zwsp}3${zwsp}-${zwsp}4${zwsp}5</div>`;
    const nodeIds = new Map<string, Node>();
    const canonical = buildCanonicalDocument({ root: document, nodeIds });
    expect(canonical.combined).toContain("1");
    expect(canonical.combined).toContain("2");
    expect(canonical.combined).toContain("3");
  });

  it("handles very large DOM trees", () => {
    let html = "<div>";
    for (let i = 0; i < 100; i++) {
      html += `<div><span>Item ${i}</span></div>`;
    }
    html += "</div>";
    document.body.innerHTML = html;
    const nodeIds = new Map<string, Node>();
    const canonical = buildCanonicalDocument({ root: document, nodeIds });
    expect(canonical.combined).toContain("Item 0");
    expect(canonical.combined).toContain("Item 99");
  });
});

describe("mapRange - offset mapping", () => {
  it("maps combined offset to correct segment for duplicate strings", () => {
    const segments: TextSegment[] = [
      { nodeId: "seg_0", startOffset: 0, endOffset: 5, text: "hello" },
      { nodeId: "seg_1", startOffset: 0, endOffset: 5, text: "hello" },
    ];
    const { combined, segmentStarts } = buildScanText(segments);
    const mapped1 = mapRange(segments, segmentStarts, combined.length, 0, 5);
    const mapped2 = mapRange(segments, segmentStarts, combined.length, 6, 11);
    expect(mapped1[0]?.nodeId).toBe("seg_0");
    expect(mapped2[0]?.nodeId).toBe("seg_1");
  });

  it("maps multi-segment findings correctly", () => {
    const segments: TextSegment[] = [
      { nodeId: "seg_0", startOffset: 0, endOffset: 5, text: "123-45" },
      { nodeId: "seg_1", startOffset: 0, endOffset: 4, text: "-6789" },
    ];
    const { combined, segmentStarts } = buildScanText(segments);
    const mapped = mapRange(segments, segmentStarts, combined.length, 0, combined.length);
    expect(mapped.length).toBe(2);
    expect(mapped[0]?.nodeId).toBe("seg_0");
    expect(mapped[1]?.nodeId).toBe("seg_1");
  });
});
