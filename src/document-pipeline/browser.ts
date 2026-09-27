// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import type { DocumentPipeline, DocumentInput, DocumentPage, RedactedDocumentResult } from "./adapter.js";
import type { Rect } from "../shared/types.js";
import {
  OFFSCREEN_CHANNEL,
  isOffscreenResponse,
  bytesToBase64,
  base64ToBytes,
  type OffscreenRequest,
  type OffscreenResponse,
} from "./contract.js";

/**
 * Service-worker-facing pipeline that delegates the actual work to a dedicated
 * offscreen document (which has DOM canvas + Worker support). Uses a
 * 1:1 MessagePort so requests/responses never race with broadcast listeners.
 */

const JOB_TIMEOUT_MS = 180_000;
const CONNECT_TIMEOUT_MS = 10_000;

interface PendingJob {
  resolve: (response: OffscreenResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingJob>();
let offscreenPort: chrome.runtime.Port | null = null;

function isTrustedOffscreenPort(port: chrome.runtime.Port): boolean {
  return (
    port.sender?.id === chrome.runtime.id &&
    port.sender.url === chrome.runtime.getURL("offscreen.html")
  );
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== OFFSCREEN_CHANNEL) return;
  if (!isTrustedOffscreenPort(port)) {
    port.disconnect();
    return;
  }
  offscreenPort = port;
  port.onMessage.addListener((raw: unknown) => {
    if (!isOffscreenResponse(raw)) return;
    const job = pending.get(raw.jobId);
    if (!job) return;
    clearTimeout(job.timer);
    pending.delete(raw.jobId);
    job.resolve(raw);
  });
  port.onDisconnect.addListener(() => {
    if (offscreenPort === port) offscreenPort = null;
  });
});

async function waitForPort(): Promise<chrome.runtime.Port> {
  if (offscreenPort) return offscreenPort;
  // Register the onConnect listener BEFORE creating the document. The offscreen
  // module connects at module load, which happens while createDocument() is
  // still pending; a listener added after createDocument resolves would miss
  // that connect and time out even though the port exists.
  return new Promise<chrome.runtime.Port>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Offscreen document did not become ready.")), CONNECT_TIMEOUT_MS);
    const listener = (port: chrome.runtime.Port) => {
      if (port.name !== OFFSCREEN_CHANNEL) return;
      if (!isTrustedOffscreenPort(port)) {
        port.disconnect();
        return;
      }
      clearTimeout(timer);
      chrome.runtime.onConnect.removeListener(listener);
      resolve(port);
    };
    chrome.runtime.onConnect.addListener(listener);
    void (async () => {
      try {
        await chrome.offscreen.closeDocument().catch(() => undefined);
        await chrome.offscreen.createDocument({
          url: chrome.runtime.getURL("offscreen.html"),
          reasons: [chrome.offscreen.Reason.WORKERS],
          justification: "Process local PDF/image/Word redaction entirely on this device.",
        });
      } catch (error) {
        clearTimeout(timer);
        chrome.runtime.onConnect.removeListener(listener);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
}

async function closeOffscreenDocument(): Promise<void> {
  const port = offscreenPort;
  offscreenPort = null;
  port?.disconnect();
  await chrome.offscreen.closeDocument().catch(() => undefined);
}

function callOffscreen(request: OffscreenRequest): Promise<OffscreenResponse> {
  return new Promise<OffscreenResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(request.jobId);
      reject(new Error("Document processing timed out."));
    }, JOB_TIMEOUT_MS);
    pending.set(request.jobId, { resolve, reject, timer });
    void (async () => {
      try {
        const port = await waitForPort();
        port.postMessage(request);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(request.jobId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
}

function assertOk(response: OffscreenResponse, _operation: "preview" | "redact"): asserts response is Extract<OffscreenResponse, { ok: true }> {
  if (response.ok) return;
  throw new Error(response.userMessage);
}

export class BrowserDocumentPipeline implements DocumentPipeline {
  async preview(input: DocumentInput): Promise<DocumentPage[]> {
    try {
      const response = await callOffscreen({
        channel: OFFSCREEN_CHANNEL,
        op: "preview",
        jobId: crypto.randomUUID(),
        kind: input.kind,
        bytes: bytesToBase64(input.bytes),
        name: input.name,
        mimeType: input.mimeType,
        enabledCategories: input.enabledCategories,
        maxPages: input.maxPages,
      });
      assertOk(response, "preview");
      if (response.op !== "preview") throw new Error("Unexpected offscreen response.");
      return response.pages;
    } finally {
      await closeOffscreenDocument();
    }
  }

  async redact(
    input: DocumentInput,
    boxes: { pageIndex: number; rects: Rect[] }[]
  ): Promise<RedactedDocumentResult> {
    try {
      const response = await callOffscreen({
        channel: OFFSCREEN_CHANNEL,
        op: "redact",
        jobId: crypto.randomUUID(),
        kind: input.kind,
        bytes: bytesToBase64(input.bytes),
        name: input.name,
        mimeType: input.mimeType,
        boxes,
        padding: input.padding,
      });
      assertOk(response, "redact");
      if (response.op !== "redact") throw new Error("Unexpected offscreen response.");
      return {
        outputBytes: base64ToBytes(response.outputBytes),
        outputMimeType: response.outputMimeType,
        outputName: response.outputName,
        pages: input.previewPages,
        summary: {
          pages: input.previewPages.length,
          redacted: response.redactedCount,
          categories: input.categories,
        },
        verification: response.verification,
      };
    } finally {
      await closeOffscreenDocument();
    }
  }
}