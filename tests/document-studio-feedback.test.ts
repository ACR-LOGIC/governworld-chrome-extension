// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression contract for the Document Studio feedback and storage layer.
 *
 * Every assertion here corresponds to a defect that shipped in v0.1.0 and made
 * the extension look inert: the user picked a file, waited, and saw no status,
 * no spinner, no error, and - if they looked away - no document either. The
 * pipeline was correct the whole time; the UI simply never revealed it.
 *
 * These are source-level assertions on purpose. The behaviour needs a real
 * browser, a real profile, and a ~12s PDF pipeline, none of which run in CI, so
 * the contract is pinned statically instead of leaving it untested.
 */

const extRoot = process.cwd();
const popupSrc = readFileSync(join(extRoot, "src/popup/popup.ts"), "utf8");
const entrySrc = readFileSync(join(extRoot, "src/popup/entry.ts"), "utf8");
const swSrc = readFileSync(join(extRoot, "src/service-worker/index.ts"), "utf8");
const docDbSrc = readFileSync(join(extRoot, "src/shared/docDb.ts"), "utf8");
const pipelineSrc = readFileSync(join(extRoot, "src/document-pipeline/browser.ts"), "utf8");
const markup = readFileSync(join(extRoot, "src/popup/index.html"), "utf8");

describe("Document Studio feedback contract", () => {
  it("writes the status into the element the markup provides", () => {
    // The markup is `<div id="doc-status" hidden><p id="doc-status-text">`.
    // Writing to the wrapper left the paragraph empty and nothing visible.
    expect(markup).toMatch(/id="doc-status"[^>]*hidden/);
    expect(markup).toContain('id="doc-status-text"');

    const body = popupSrc.slice(popupSrc.indexOf("function setDocStatus"));
    const fn = body.slice(0, body.indexOf("\n}"));
    expect(fn).toContain('getElementById("doc-status-text")');
    expect(fn).toMatch(/status\.hidden\s*=/);
  });

  it("hides the status again when the message is cleared", () => {
    const body = popupSrc.slice(popupSrc.indexOf("function setDocStatus"));
    const fn = body.slice(0, body.indexOf("\n}"));
    // A stale "Scanning document on this device." outliving the run read as a
    // permanent hang, so an empty message must hide the block.
    expect(fn).toMatch(/status\.hidden\s*=\s*message\.length\s*===\s*0/);
  });

  it("shows progress as soon as a document is chosen", () => {
    // resetDocStages() hides the progress row, and nothing re-showed it, so a
    // 6-20s preview produced no visible change at all.
    const changeHandler = popupSrc.slice(popupSrc.indexOf('addEventListener("change"'));
    expect(changeHandler).toContain("showDocProgress()");
  });

  it("stops the progress row when a document finishes", () => {
    const onState = popupSrc.slice(popupSrc.indexOf('message.type === "POPUP_DOC_STATE"'));
    const block = onState.slice(0, onState.indexOf('message.type === "POPUP_DOC_DONE"'));
    // The block opens with a hideDocProgress() guard for a mismatched reply, so
    // asserting on the whole block proves nothing about the success path. What
    // matters is that once the document is rendered nothing re-shows the row.
    const afterRender = block.slice(block.indexOf("renderDoc(doc)"));
    expect(afterRender).toContain("hideDocProgress()");
    // Calling renderDocStage() after success re-showed "Processing document..."
    // with a Cancel button on an already-processed document. Matched on the
    // call form so the explanatory comment does not satisfy the assertion.
    expect(afterRender).not.toMatch(/renderDocStage\(\s*\{/);
    expect(afterRender).not.toMatch(/showDocProgress\(\)/);
  });

  it("stops the progress row when a document fails", () => {
    const onError = popupSrc.slice(popupSrc.indexOf('message.type === "POPUP_DOC_ERROR"'));
    const block = onError.slice(0, 400);
    expect(block).toContain("hideDocProgress()");
  });

  it("surfaces worker refusals instead of discarding the reply", () => {
    // The worker answers { ok: false, error } for a dispatch failure. Every
    // document call site used `void sendMessage(...)` and threw the reply away,
    // so a refused request was indistinguishable from a slow one.
    expect(popupSrc).toContain("sendDocMessage");
    const docSends = popupSrc.match(/(void )?send(Message|DocMessage)\(\{ type: "POPUP_DOC/g) ?? [];
    expect(docSends.length).toBeGreaterThan(0);
    expect(popupSrc).not.toMatch(/void sendMessage\(\{ type: "POPUP_DOC/);
  });

  it("adopts the worker's document state instead of dropping it", () => {
    // `if (!lastDoc) return` discarded the restore reply, so reopening the
    // popup always came back to an empty studio.
    const onState = popupSrc.slice(popupSrc.indexOf('message.type === "POPUP_DOC_STATE"'));
    expect(onState).not.toMatch(/if \(!lastDoc\) return;/);
  });
});

describe("popup initialisation cannot fail silently", () => {
  it("handles a rejected initPopup", () => {
    // initPopup awaits storage before attaching a single listener, so a
    // rejection left working markup with no behaviour at all.
    expect(entrySrc).toContain("initPopup().catch");
    expect(entrySrc).not.toMatch(/^\s*void initPopup\(\);\s*$/m);
  });
});

describe("staged-document storage cannot hang", () => {
  it("bounds the database open and fails a blocked open fast", () => {
    // A blocked indexedDB.open fires neither success nor error. The cached
    // promise stayed pending for the life of the context, so every caller
    // awaited it forever and the popup looked inert with no error anywhere.
    expect(docDbSrc).toContain("OPEN_TIMEOUT_MS");
    expect(docDbSrc).toContain("req.onblocked");
    expect(docDbSrc).toContain("OP_TIMEOUT_MS");
  });

  it("drops a stale connection instead of reusing it forever", () => {
    expect(docDbSrc).toContain("db.onclose");
    expect(docDbSrc).toContain("db.onversionchange");
    expect(docDbSrc).toContain("resetDocDb()");
  });

  it("keeps a single shared implementation instead of two drifting copies", () => {
    // The popup and the worker each carried their own openDb, and the copies
    // drifted into different failure behaviour. The worker reaches the shared
    // layer through its document module.
    const documentsSrc = readFileSync(join(extRoot, "src/service-worker/documents.ts"), "utf8");
    expect(popupSrc).toContain("docDb.js");
    expect(documentsSrc).toContain("docDb.js");
    expect(popupSrc).not.toContain("indexedDB.open");
    expect(documentsSrc).not.toContain("indexedDB.open");
  });
});

describe("service worker lifecycle", () => {
  it("does not latch a purge failure for the life of the worker", () => {
    // One transient failure used to reject every later message for the whole
    // worker lifetime, disabling the extension with no user-visible error.
    expect(swSrc).toMatch(/startupCleanupError\s*=\s*undefined/);
  });

  it("does not race the startup purge against a staged document", () => {
    // The purge clears the same store, which produced "The selected file is no
    // longer available" for a file the user had just picked.
    expect(swSrc).toContain("PURGE_WAIT_MS");
    expect(swSrc).toContain("startupPurge");
  });
});

describe("offscreen document lifecycle", () => {
  it("fails in-flight jobs when the document is reclaimed", () => {
    // Chrome may destroy an offscreen document at any time. A disconnect used
    // to leave the job pending for the full 180s timeout with no message shown.
    expect(pipelineSrc).toContain("OffscreenGoneError");
    const onDisconnect = pipelineSrc.slice(pipelineSrc.indexOf("port.onDisconnect.addListener"));
    expect(onDisconnect.slice(0, 700)).toContain("job.reject(new OffscreenGoneError())");
  });

  it("retries once on a fresh document after a reclaim", () => {
    expect(pipelineSrc).toMatch(/attempt\s*===\s*0/);
  });
});

describe("full-screen document review", () => {
  it("exists as its own page, entry point and stylesheet", () => {
    // The popup studio is a ~360px column, so a page of text renders at about
    // a tenth of its natural size and a drawn box lands on unreadable pixels.
    // review.html is the only surface where drawing can be verified at all.
    expect(existsSync(join(extRoot, "src/popup/review.html"))).toBe(true);
    expect(existsSync(join(extRoot, "src/popup/review.css"))).toBe(true);
    expect(existsSync(join(extRoot, "src/popup/review.ts"))).toBe(true);
    const build = readFileSync(join(extRoot, "build.mjs"), "utf8");
    expect(build).toContain("src/popup/review.ts");
    expect(build).toContain("review.html");
    expect(build).toContain("review.css");
  });

  it("is reachable from the popup", () => {
    expect(markup).toContain('id="doc-open-review-btn"');
    expect(popupSrc).toContain('doc-open-review-btn');
    expect(popupSrc).toContain("openFullScreenReview");
  });

  it("hands the document over through storage, not a message", () => {
    // Page metadata for a long document is far larger than a runtime message
    // may be, so the review page reads chrome.storage.session directly.
    const reviewSrc = readFileSync(join(extRoot, "src/popup/review.ts"), "utf8");
    expect(reviewSrc).toContain("chrome.storage.session.get");
    expect(reviewSrc).not.toMatch(/type:\s*"POPUP_DOC_PREVIEW"/);
  });

  it("draws a box on a full-resolution canvas, not a scaled thumbnail", () => {
    const reviewSrc = readFileSync(join(extRoot, "src/popup/review.ts"), "utf8");
    // Backing store is the page's real pixel size; pointer coordinates are
    // converted into it, so a box is correct at any zoom or window size.
    expect(reviewSrc).toMatch(/canvas\.width\s*=\s*page\.widthPx/);
    expect(reviewSrc).toMatch(/canvas\.height\s*=\s*page\.heightPx/);
  });

  it("prefixes a drawn box id with `custom:` so the worker accepts it", () => {
    // The worker validates every selected id against the session and only
    // tolerates one it does not recognise when it starts with "custom:" or
    // "user:". Any other prefix is rejected at redaction time with "The
    // selected findings are no longer available." - which is what a drawn box
    // needs, so the prefix is a contract, not decoration.
    const reviewSrc = readFileSync(join(extRoot, "src/popup/review.ts"), "utf8");
    expect(reviewSrc).toMatch(/id:\s*`custom:/);
    const documentsSrc = readFileSync(join(extRoot, "src/service-worker/documents.ts"), "utf8");
    expect(documentsSrc).toContain('startsWith("custom:")');
  });

  it("reports a screen capture as degraded instead of implying a full read", () => {
    const reviewSrc = readFileSync(join(extRoot, "src/popup/review.ts"), "utf8");
    expect(reviewSrc).toContain("degraded");
    expect(reviewSrc).toMatch(/source-notice|notice/);
  });

  it("does not claim success when the worker refuses a redaction", () => {
    const reviewSrc = readFileSync(join(extRoot, "src/popup/review.ts"), "utf8");
    expect(reviewSrc).toContain("reply?.ok === true");
    expect(reviewSrc).toContain("reply?.error");
  });

  it("no longer renders the decorative protection hero", () => {
    // It asserted "Protection Active" regardless of whether a scan had ever
    // run, so it occupied the most valuable space in a narrow popup while
    // telling the user nothing they could act on.
    expect(markup).not.toContain('class="protection-status"');
    expect(markup).not.toContain("status-dot");
    const css = readFileSync(join(extRoot, "src/popup/popup.css"), "utf8");
    expect(css).not.toContain(".protection-status");
    expect(css).not.toContain(".status-ring");
  });
});

