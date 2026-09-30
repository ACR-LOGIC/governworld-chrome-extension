// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.

/**
 * Runtime platform capabilities.
 *
 * The extension is one engine with per-browser packaging, but browsers do
 * not implement the same extension APIs. Every capability gap is detected at
 * runtime and surfaced as an explicit limitation — never as a silent dead
 * feature and never as a false "supported" claim.
 */

interface ChromeLike {
  offscreen?: { createDocument?: unknown };
  scripting?: { registerContentScripts?: unknown; unregisterContentScripts?: unknown };
  storage?: { managed?: unknown };
  permissions?: { contains?: unknown; request?: unknown };
  sidePanel?: { open?: unknown };
}

function chromeLike(): ChromeLike | null {
  try {
    const g = globalThis as unknown as { chrome?: ChromeLike };
    return g.chrome ?? null;
  } catch {
    return null;
  }
}

/**
 * The document pipeline (pdf.js + tesseract) runs in an offscreen document,
 * a Chromium-only API. Without it, Document Studio jobs cannot run; page
 * scanning, paste protection, and masks are unaffected.
 */
export function isDocumentPipelineSupported(): boolean {
  const c = chromeLike();
  return typeof c?.offscreen?.createDocument === "function";
}

export const DOCUMENT_PIPELINE_UNAVAILABLE_MESSAGE =
  "Document redaction needs an offscreen-capable browser (Chromium 109 or later). Page scanning and paste protection work fully in this browser.";

/** chrome.scripting.registerContentScripts for persisted always-on coverage. */
export function canRegisterContentScripts(): boolean {
  const c = chromeLike();
  return (
    typeof c?.scripting?.registerContentScripts === "function" &&
    typeof c?.scripting?.unregisterContentScripts === "function"
  );
}

/** Enterprise managed storage for administrator policy. */
export function hasManagedStorage(): boolean {
  return chromeLike()?.storage?.managed != null;
}
