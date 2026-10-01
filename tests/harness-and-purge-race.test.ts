// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Cover for the two defects that made every headed browser harness report a
// product failure that did not exist:
//
// 1. The lifecycle purge cleared the whole staged-document store, so a document
//    the popup had just staged was deleted and the preview reported "The
//    selected file is no longer available." for a file the user could see
//    selected. Awaiting the purge before reading the document could not prevent
//    this; it made the outcome certain.
// 2. The harnesses drove the popup before `initPopup` had attached its
//    listeners, so they dispatched events on inputs with nothing bound to them
//    and reported the resulting silence as "the studio previewed the image" not
//    working.
//
// Both are asserted statically. Reproducing either needs a browser, and the
// failure mode is a false negative in the very tests meant to catch regressions,
// so leaving them unasserted is how they came back.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const extRoot = process.cwd();
const read = (p: string) => readFileSync(join(extRoot, p), "utf8");

const worker = read("src/service-worker/index.ts");
const documents = read("src/service-worker/documents.ts");
const docDb = read("src/shared/docDb.ts");
const popup = read("src/popup/popup.ts");
const launch = read("scripts/browser-launch.mjs");

describe("housekeeping cannot destroy a document the user is working on", () => {
  it("skips the purge when a document is staged", () => {
    const fn = worker.slice(worker.indexOf("function purgeStagedFilesOnLifecycle"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    // The check must happen BEFORE clearAllFiles, which empties the store.
    expect(body).toContain("hasStagedDocument");
    expect(body.indexOf("hasStagedDocument")).toBeLessThan(body.indexOf("clearAllFiles"));
  });

  it("clears the whole store, so the skip is the only thing protecting it", () => {
    // Documents the reason the guard exists rather than treating it as belt-and-
    // braces: clearAllFiles() is not a targeted delete.
    expect(documents).toMatch(/clearAllFiles[\s\S]{0,400}docClearFiles\(\)/);
  });

  it("keeps the marker across contexts, since the write and the decision differ", () => {
    // The popup stages; the worker decides. A module-level boolean cannot carry
    // that fact between two contexts, so the marker is session-scoped storage.
    expect(docDb).toContain("markDocumentStaged");
    expect(docDb).toContain("chrome.storage.session");
    // Session-scoped: a stale marker must not outlive the browser session.
    expect(docDb).toContain("clearStagedMarker");
  });

  it("marks the document staged BEFORE writing the bytes", () => {
    // Marking after the write leaves a window in which the purge sees no staged
    // document and deletes the file that was just written.
    const popupStore = popup.slice(popup.indexOf("async function storeFile"));
    const body = popupStore.slice(0, popupStore.indexOf("\n}"));
    expect(body).toContain("markDocumentStaged");
    expect(body.indexOf("markDocumentStaged")).toBeLessThan(body.indexOf("docStoreFile"));
  });

  it("stops the worker's own staging path from being unprotected too", () => {
    // captureImage stages through the worker's storeFile, which is a second
    // route into the same store.
    expect(documents).toMatch(/storeFile[\s\S]{0,200}markDocumentStaged/);
  });
});

describe("the harnesses wait for the popup instead of racing it", () => {
  it("exposes a readiness wait derived from the popup's own marker", () => {
    expect(launch).toContain("export async function waitForPopupReady");
    expect(launch).toContain("gwReady");
  });

  it("marks readiness only after every listener is attached", () => {
    // Placed at the end of initPopup on purpose: earlier and the popup would
    // claim to be interactive while it is not.
    const tail = popup.slice(popup.lastIndexOf("POPUP_GET_STATE"));
    expect(tail).toContain('dataset.gwReady = "1"');
  });

  it("waits for readiness right after opening the popup", () => {
    // Scoped to the defect: a sleep standing in for "the popup has finished
    // loading". Polling after an action (waiting for a redaction, for masks to
    // paint) is a different thing and is left alone.
    //
    // Two ways in, both counted: `waitForPopupReady` directly, or
    // `stageFileInPopup`, which waits internally before staging. Asserted as an
    // ordered pair, because either name appearing later in the file would satisfy
    // a bare "contains" check while leaving the race in place.
    for (const script of [
      "scripts/verify-review-surface.mjs",
      "scripts/verify-document-flow.mjs",
      "scripts/verify-no-text-reporting.mjs",
      "scripts/verify-image-capture.mjs",
      "scripts/verify-print-pipeline.mjs",
      "scripts/verify-browser.mjs",
      "scripts/capture-ui-session.mjs",
    ]) {
      const src = read(script);
      // Anchor on the actual navigation, not any mention of popup.html (several
      // of these list the page in an array of extension pages first).
      const goto = src.search(/\.goto\(`chrome-extension:\/\/\$\{[^}]+\}\/popup\.html`/);
      expect(goto, `${script} does not open the popup`).toBeGreaterThan(-1);
      const candidates = [src.indexOf("waitForPopupReady", goto), src.indexOf("stageFileInPopup(", goto)].filter(
        (i) => i > goto
      );
      expect(candidates.length, `${script} does not wait for the popup after opening it`).toBeGreaterThan(0);
      // Nothing that looks like a stand-in sleep may sit in between.
      const between = src.slice(goto, Math.min(...candidates));
      expect(between, `${script} still sleeps instead of waiting for the popup`).not.toMatch(
        /waitForTimeout\(\d{3,}\)/
      );
    }
  });
});

describe("a finished preview is not reported as a missing spinner", () => {
  it("observes the in-flight state rather than sampling once after a delay", () => {
    // A text-layer PDF now finishes in well under a second, so a fixed sample
    // read the finished state and failed "progress is visible while processing".
    const flow = read("scripts/verify-document-flow.mjs");
    expect(flow).toContain("progress is visible while processing");
    expect(flow).toMatch(/while \(performance\.now\(\) < deadline\)/);
    expect(flow).not.toMatch(/waitForTimeout\(1_200\)/);
  });
});