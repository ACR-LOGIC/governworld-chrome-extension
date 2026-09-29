// Contract for the print / PDF stage of the redaction pipeline.
//
// Pipeline shape being guarded:
//
//   action click
//     -> service worker injects the content script and extracts the DOM
//     -> session payload (metadata + masked previews only)
//     -> offscreen pipeline: render -> OCR -> detect
//     -> render/redact: boxes painted, then verified in the pixels
//     -> redacted pages staged in the shared store
//     -> redact.html renders them -> window.print() (printer or "Save as PDF")
//
// Two properties matter and neither is enforced by the compiler:
//
//   1. Nothing may be redacted at print time. The print view is handed pixels
//      that were already verified. If redaction moved into the view, a failed
//      mask would print as a clean page with no signal to the user.
//   2. No page image may cross a chrome.runtime message. A base64 page image is
//      far past MAX_MESSAGE_BYTES, so pages travel by store key.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isRedactedDocRef,
  isRedactedKey,
  isRedactedManifestKey,
  redactedKey,
  redactedManifestKey,
  REDACTED_KEY_RE,
} from "../src/shared/docStore.js";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(extRoot, rel), "utf8");

/**
 * Strip comments so assertions test code, not prose.
 *
 * redact.ts explains in a comment exactly which printing APIs it rejects
 * (chrome.debugger, chrome.printing) and why. A naive text scan for those names
 * therefore matches the rationale that documents the correct decision.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const redactHtml = read("src/popup/redact.html");
const redactTsRaw = read("src/popup/redact.ts");
const redactTs = stripComments(redactTsRaw);
const implTs = read("src/document-pipeline/impl.ts");
const buildMjs = read("build.mjs");
const manifest = JSON.parse(read("manifest.json"));

describe("print view is packaged and reachable", () => {
  it("ships redact.html and its script", () => {
    expect(buildMjs).toContain('join(root, "src/popup", "redact.html"), join(outDir, "redact.html")');
    expect(buildMjs).toContain('{ entry: "src/popup/redact.ts", out: "redact.js", format: "iife" }');
  });

  it("is loaded by the manifest-free extension page, not the popup", () => {
    expect(redactHtml).toContain('src="redact.js"');
    // It must not pull in the popup controller, which owns scan state.
    expect(redactHtml).not.toContain("popup.js");
  });

  it("requests no permission beyond what the manifest already declares", () => {
    // window.print() needs nothing. A printing API that did (chrome.debugger,
    // chrome.printing) would be a new permission on a tool that handles
    // sensitive data, so assert the page uses the browser's own print dialog.
    expect(redactTs).toContain("window.print()");
    expect(redactTs).not.toMatch(/chrome\.(debugger|printing)\b/);
    // And confirm the rationale comment really is there, so the reason for the
    // rejection is not silently deleted alongside the check.
    expect(redactTsRaw).toMatch(/chrome\.debugger/);
  });

  it("keeps every page as a printable sheet with a page break", () => {
    expect(redactHtml).toMatch(/@page\s*\{/);
    expect(redactHtml).toMatch(/\.sheet\s*\{[^}]*break-after:\s*page/);
    // The toolbar must not print.
    expect(redactHtml).toMatch(/@media print\s*\{[^}]*\.printbar[^}]*display:\s*none/);
  });
});

describe("the print view cannot redact", () => {
  it("contains no detection, OCR, or box-painting code", () => {
    for (const forbidden of ["detect(", "applyBoxes", "ocrCanvas", "createWorker", "runDocumentRedact", "OFFSCREEN_CHANNEL"]) {
      expect(redactTs, `redact.ts must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("renders stored page images and nothing else", () => {
    expect(redactTs).toContain("getDocBytes(page.key)");
    expect(redactTs).toContain("createObjectURL");
    // It reads the manifest and fetches pages itself.
    expect(redactTs).toContain("redactedManifestKey(fileKey)");
  });

  it("awaits image decode before enabling print, so a fast print cannot emit a blank page", () => {
    expect(redactTs).toContain("await img.decode()");
    expect(redactTs).toMatch(/printBtn\.disabled = true/);
  });
});

describe("no page image crosses a runtime message", () => {
  it("stages pages by store key", () => {
    expect(implTs).toContain("redactedKey(fileKey, page.index)");
    expect(implTs).toContain("putDocBytes(key");
  });

  it("sends only a key back to the popup, not the manifest payload as content", () => {
    // The worker forwards a single key; redact.html resolves everything itself.
    const worker = read("src/service-worker/index.ts");
    expect(worker).toContain("printFileKey: printRef?.fileKey");
    expect(worker).not.toMatch(/printFileKey:\s*JSON\.stringify/);
  });

  it("the printRef carried on the redact response holds no page bytes", () => {
    const contract = read("src/document-pipeline/contract.ts");
    expect(contract).toMatch(/printRef\?:\s*RedactedDocRef \| null/);
    // Guard against someone inlining a data URL into the handle.
    expect(contract).not.toMatch(/printRef\?:\s*[^;]*base64/i);
  });
});

describe("stored print data is validated before it is rendered", () => {
  it("accepts a well-formed manifest", () => {
    const ref = {
      fileKey: "doc-1",
      key: redactedManifestKey("doc-1"),
      name: "letter.pdf",
      pages: [
        {
          pageIndex: 0,
          key: redactedKey("doc-1", 0),
          widthPx: 1240,
          heightPx: 1754,
          widthPt: 612,
          heightPt: 792,
        },
      ],
      redactedCount: 3,
      createdAt: 1,
    };
    expect(isRedactedDocRef(ref)).toBe(true);
  });

  it("rejects geometry that could be used to size an unbounded sheet", () => {
    const base = {
      fileKey: "doc-1",
      key: redactedManifestKey("doc-1"),
      name: "letter.pdf",
      pages: [{ pageIndex: 0, key: redactedKey("doc-1", 0), widthPx: 1, heightPx: 1, widthPt: 1, heightPt: 1 }],
      redactedCount: 1,
      createdAt: 1,
    };
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "600"]) {
      expect(isRedactedDocRef({ ...base, pages: [{ ...base.pages[0], widthPt: bad }] })).toBe(false);
    }
  });

  it("rejects a page key that is not a redacted-page key", () => {
    const base = {
      fileKey: "doc-1",
      key: redactedManifestKey("doc-1"),
      name: "letter.pdf",
      pages: [{ pageIndex: 0, key: "doc-1::preview::0", widthPx: 1, heightPx: 1, widthPt: 1, heightPt: 1 }],
      redactedCount: 1,
      createdAt: 1,
    };
    // A preview key must not be accepted: previews are unredacted page images.
    expect(isRedactedDocRef(base)).toBe(false);
  });

  it("rejects malformed shapes outright", () => {
    for (const bad of [null, undefined, 42, "x", [], { fileKey: "d" }, { ...{ fileKey: "d" }, pages: [] }]) {
      expect(isRedactedDocRef(bad)).toBe(false);
    }
  });

  it("namespaces the two key families apart", () => {
    expect(REDACTED_KEY_RE.test(redactedKey("d", 3))).toBe(true);
    expect(isRedactedKey("d::preview::3")).toBe(false);
    expect(isRedactedManifestKey("d::redacted-manifest")).toBe(true);
    expect(isRedactedManifestKey("d::redacted::3")).toBe(false);
  });
});

describe("print staging failure is not a redaction failure", () => {
  it("staging is wrapped so a print-path error cannot fail the run", () => {
    // The catch returns null rather than throwing, and the download is produced
    // before/independently of the print handle.
    expect(implTs).toMatch(/async function stageRedactedPages[\s\S]*?catch\s*\{[\s\S]*?return null;/);
  });

  it("marks printRef optional on both outputs", () => {
    expect(implTs).toMatch(/printRef\?: RedactedDocRef \| null/);
  });
});

describe("the print view stays inside the shipped permission set", () => {
  it("adds no manifest permission for printing", () => {
    expect(manifest.permissions).toEqual([
      "activeTab",
      "scripting",
      "storage",
      "downloads",
      "offscreen",
      "sidePanel",
      "contextMenus",
    ]);
  });
});
