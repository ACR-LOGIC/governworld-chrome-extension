// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { OFFSCREEN_CHANNEL, isOffscreenRequest, base64ToBytes, bytesToBase64 } from "../document-pipeline/contract.js";
import { runDocumentPreview, runDocumentRedact } from "../document-pipeline/impl.js";

/**
 * Offscreen document entry point. This page exists only to host pdf.js +
 * tesseract workers and to do canvas work — capabilities a service worker
 * lacks. It has no UI and processes one job at a time, always replying over
 * the dedicated port it opened to the service worker.
 */

const MAX_DOC_PAGES = 20;

function normalizeBytes(raw: unknown): ArrayBuffer {
  if (typeof raw !== "string" || !raw) throw new Error("Document bytes are missing from the request.");
  return base64ToBytes(raw).buffer as ArrayBuffer;
}

const port = chrome.runtime.connect({ name: OFFSCREEN_CHANNEL });

function toError(error: unknown): { code: string; userMessage: string } {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("password") || lower.includes("encrypted")) {
    return { code: "PASSWORD_PROTECTED", userMessage: "This PDF is password-protected and cannot be processed." };
  }
  if (lower.includes("too large")) {
    return { code: "DOC_TOO_LARGE", userMessage: "This document is too large to process on this device." };
  }
  if (lower.includes("language data") || lower.includes("ocr") || lower.includes("tesseract")) {
    return { code: "OCR_UNAVAILABLE", userMessage: "Text recognition is unavailable in offline mode." };
  }
  if (lower.includes("canvas") || lower.includes("worker")) {
    return { code: "PIPELINE_UNAVAILABLE", userMessage: "Document processing is unavailable right now." };
  }
  return { code: "DOC_ERROR", userMessage: "This document could not be processed." };
}

port.onMessage.addListener((raw: unknown) => {
  if (!isOffscreenRequest(raw)) return;
  const jobId = raw.jobId;
  const op = raw.op;
  void (async () => {
    try {
      const bytes = normalizeBytes(raw.bytes);
      if (op === "preview") {
        const pages = await runDocumentPreview({
          kind: raw.kind,
          bytes,
          name: raw.name,
          mimeType: raw.mimeType,
          enabledCategories: raw.enabledCategories,
          maxPages: raw.maxPages,
        });
        port.postMessage({ channel: OFFSCREEN_CHANNEL, op: "preview", jobId, ok: true, pages });
        return;
      }
      const out = await runDocumentRedact(
        { kind: raw.kind, bytes, name: raw.name, mimeType: raw.mimeType },
        raw.boxes,
        MAX_DOC_PAGES,
        raw.padding
      );
      port.postMessage({
        channel: OFFSCREEN_CHANNEL,
        op: "redact",
        jobId,
        ok: true,
        outputBytes: bytesToBase64(out.outputBytes),
        outputMimeType: out.outputMimeType,
        outputName: out.outputName,
        redactedCount: out.redactedCount,
        verification: out.verification,
      });
    } catch (error) {
      const e = toError(error);
      port.postMessage({ channel: OFFSCREEN_CHANNEL, op, jobId, ok: false, ...e });
    }
  })();
});