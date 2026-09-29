// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
//
// Print / PDF view for a redacted document.
//
// This page is a renderer, not a redaction surface. The images it shows were
// produced by the offscreen pipeline, which painted the boxes and then verified
// them in the pixels before writing them to the shared document store. Nothing
// here can mask anything, which is deliberate: a redaction applied at print time
// could not be verified, and a failed one would reach the printer looking
// clean. That is the same reasoning behind the one-time "verify your work"
// notice — a passing test suite is not a coverage guarantee.
//
//   click -> worker injects/extracts DOM -> session payload
//         -> render/redact (offscreen, pixel-verified)
//         -> this page renders -> print (window.print) or Save as PDF
import {
  getDocBytes,
  isRedactedDocRef,
  redactedManifestKey,
  type RedactedDocRef,
} from "../shared/docStore.js";

const qs = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

const titleEl = qs<HTMLElement>("print-title");
const countEl = qs<HTMLElement>("print-count");
const statusEl = qs<HTMLElement>("print-status");
const noteEl = qs<HTMLElement>("print-note");
const sheetsEl = qs<HTMLElement>("sheets");
const printBtn = qs<HTMLButtonElement>("print-btn");
const pdfBtn = qs<HTMLButtonElement>("pdf-btn");

/** Keys are carried across the chrome.runtime boundary as a query parameter. */
function requestedFileKey(): string | null {
  const raw = new URLSearchParams(window.location.search).get("key");
  return raw && /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : null;
}

function say(message: string): void {
  if (statusEl) statusEl.textContent = message;
}

function fail(message: string): void {
  say(message);
  if (noteEl) {
    noteEl.hidden = false;
    noteEl.textContent = message;
  }
  if (printBtn) printBtn.disabled = true;
  if (pdfBtn) pdfBtn.disabled = true;
}

let manifest: RedactedDocRef | null = null;
const objectUrls: string[] = [];

/** Revoke every object URL this view created. */
function releaseUrls(): void {
  for (const url of objectUrls.splice(0)) URL.revokeObjectURL(url);
}

async function render(ref: RedactedDocRef): Promise<void> {
  if (!sheetsEl) return;
  sheetsEl.replaceChildren();

  for (const page of [...ref.pages].sort((a, b) => a.pageIndex - b.pageIndex)) {
    const bytes = await getDocBytes(page.key);
    if (!bytes) {
      fail("This redacted document is no longer available. Re-run the redaction to print it again.");
      return;
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    objectUrls.push(url);

    const sheet = document.createElement("div");
    // The sheet takes the source page's own size in millimetres so Chrome's
    // print pipeline uses the real page geometry instead of a default sheet.
    const mmW = (page.widthPt / 72) * 25.4;
    const mmH = (page.heightPt / 72) * 25.4;
    sheet.className = "sheet";
    sheet.style.width = `${mmW.toFixed(2)}mm`;
    sheet.style.height = `${mmH.toFixed(2)}mm`;

    const img = document.createElement("img");
    img.src = url;
    img.alt = `Redacted page ${page.pageIndex + 1}`;
    img.width = page.widthPx;
    img.height = page.heightPx;
    // All images must be decoded before printing, or Chrome can emit a partial
    // first page when the user prints immediately after the view opens.
    await img.decode().catch(() => undefined);
    sheet.appendChild(img);
    sheetsEl.appendChild(sheet);
  }

  if (countEl) {
    const n = ref.pages.length;
    countEl.textContent = `${n} page${n === 1 ? "" : "s"} · ${ref.redactedCount} redaction${ref.redactedCount === 1 ? "" : "s"}`;
    countEl.hidden = false;
  }
}

async function load(): Promise<void> {
  const fileKey = requestedFileKey();
  if (!fileKey) {
    fail("No document was specified. Open this view from the extension after redacting a document.");
    return;
  }
  const manifestKey = redactedManifestKey(fileKey);
  const raw = await getDocBytes(manifestKey);
  if (!raw) {
    fail("This redacted document is no longer available. Re-run the redaction to print it again.");
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    fail("The stored redaction could not be read. Re-run the redaction to print it again.");
    return;
  }
  if (!isRedactedDocRef(parsed)) {
    fail("The stored redaction is malformed and was not rendered.");
    return;
  }

  manifest = parsed;
  document.title = `GovernWorld — ${manifest.name}`;
  if (titleEl) titleEl.textContent = manifest.name;
  try {
    await render(manifest);
    say("Ready to print.");
    if (printBtn) printBtn.disabled = false;
    if (pdfBtn) pdfBtn.disabled = false;
  } catch (error) {
    fail(`The redacted pages could not be displayed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

printBtn?.addEventListener("click", () => {
  if (!manifest) return;
  // window.print() opens Chrome's own print dialog, where "Save as PDF" is one
  // of the destinations. It is the only print path available to an extension
  // without new permissions: chrome.printing is policy-gated for enterprises, and
  // chrome.debugger (Page.printToPDF) would mean asking every user for a
  // debugging permission on a tool that exists to protect their data.
  window.print();
});

pdfBtn?.addEventListener("click", () => {
  if (!manifest) return;
  say("Use the print dialog and choose “Save as PDF” as the destination.");
  window.print();
});

window.addEventListener("beforeunload", releaseUrls);
window.addEventListener("pagehide", releaseUrls);

void load();
