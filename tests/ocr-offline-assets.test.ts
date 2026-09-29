// The document pipeline is the one part of this extension that must have no
// network path: it is handed raw document bytes and image pixels, and a remote
// fetch from inside it would mean protected content could reach a third party
// by a route nobody audits.
//
// tesseract.js makes that easy to get wrong by accident. Its defaults are
// remote: `workerPath` defaults to a jsDelivr URL, and inside the worker
// `langPath` defaults to a jsDelivr URL for @tesseract.js-data. We override all
// three. This file exists because "we override them" is a comment, and a
// comment does not fail when someone deletes a line.
//
// These assertions are deliberately about the *shape* of the configuration
// rather than about the contents of dist/, because dist/ is gitignored and
// absent in a clean checkout. The build-time pairing between the configured
// filenames and the files actually copied is covered separately by
// tests/dist-manifest.test.ts and tests/ocr-bundled-languages.test.ts.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// assetUrl() calls chrome.runtime.getURL, which does not exist outside an
// extension context. Stubbing it lets this test assert the *shape* of the path
// - that it is a chrome-extension:// URL inside the package - which is the part
// that decides whether a fetch can leave the device.
beforeAll(() => {
  vi.stubGlobal("chrome", {
    runtime: { getURL: (p: string) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${p}` },
  });
});

const { buildOcrWorkerOptions } = await import("../src/document-pipeline/ocr.js");
const { BUNDLED_OCR_CODES, traineddataFile } = await import("../src/shared/ocrLanguages.js");

describe("OCR worker configuration has no remote path", () => {
  it("points worker, core, and language data at packaged assets", () => {
    const opts = buildOcrWorkerOptions();
    // Every path must be a chrome-extension:// asset URL, i.e. it carries the
    // extension origin rather than a host on the internet.
    for (const key of ["workerPath", "corePath", "langPath"] as const) {
      const value = opts[key];
      expect(typeof value, `${key} must be a string`).toBe("string");
      expect(value.length, `${key} must not be empty`).toBeGreaterThan(0);
      expect(value, `${key} must be a packaged extension asset`).toMatch(
        /^chrome-extension:\/\/[a-p]{32}\/assets\//,
      );
      expect(value, `${key} must not be an absolute URL`).not.toMatch(/^https?:\/\//i);
      expect(value, `${key} must not be protocol-relative`).not.toMatch(/^\/\//);
    }
  });

  it("disables the blob URL worker path", () => {
    // workerBlobURL: true would build a blob from the fetched script; false
    // keeps the packaged file authoritative.
    expect(buildOcrWorkerOptions().workerBlobURL).toBe(false);
  });

  it("never logs recognition output", () => {
    const opts = buildOcrWorkerOptions();
    expect(typeof opts.logger).toBe("function");
    // tesseract's logger is called with progress objects and, depending on
    // version, may include recognised text. It must swallow everything.
    expect(opts.logger("secret text" as never)).toBeUndefined();
  });

  it("does not reintroduce a CDN fallback anywhere in the OCR source", () => {
    const src = readFileSync(join(extRoot, "src/document-pipeline/ocr.ts"), "utf8");
    // Only allowed in a comment explaining what is being overridden.
    const codeLines = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*"));
    const offenders = codeLines.filter((l) => /https?:\/\//i.test(l));
    expect(offenders, `remote URL in executable OCR code: ${offenders.join(" | ")}`).toEqual([]);
  });
});

describe("bundled language data and the selector cannot drift", () => {
  it("every advertised language has a traineddata file name", () => {
    for (const code of BUNDLED_OCR_CODES) {
      expect(traineddataFile(code), `no traineddata file for ${code}`).not.toBeNull();
    }
  });

  it("a single bundled language is the current, deliberate state", () => {
    // Not a wish, a record: the docs promise English only, and the store copy
    // says so. If this ever changes, the size decision has to be made again and
    // the guide-card copy updated with it.
    expect(BUNDLED_OCR_CODES).toEqual(["eng"]);
  });
});
