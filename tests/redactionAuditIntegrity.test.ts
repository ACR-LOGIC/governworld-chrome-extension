// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
//
// Audit-integrity tests for document redaction delivery.
//
// The defect: `handlePopupDocRedact` computed a `downloadOk` flag, then never
// read it, and recorded `outcome: "ok"` in the signed audit log
// unconditionally. A failed `chrome.downloads.download` therefore produced an
// audit entry asserting the document was redacted and delivered when it was
// not. For a product whose audit chain is the trust anchor, a false success is
// worse than a visible failure.
//
// The second defect: the worker shipped the full base64 artifact to the popup
// unconditionally, so the popup downloaded the same file a second time on the
// happy path and a whole document crossed the messaging channel for nothing.
//
// The document pipeline is mocked so the delivery/audit contract can be tested
// without standing up IndexedDB, the offscreen host, and pdf.js. The pipeline's
// own byte production is covered by redaction-output.test.ts.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

type MessageListener = (
  raw: unknown,
  sender: Record<string, unknown>,
  sendResponse: (response: unknown) => void
) => boolean | void;

const messageListeners: MessageListener[] = [];
const runtimeSent: Array<Record<string, unknown>> = [];
const downloadAttempts: Array<{ filename: string; url: string; saveAs?: boolean }> = [];
const auditRecords: Array<Record<string, unknown>> = [];
let clearAllFilesCalls = 0;

let downloadShouldFail = false;
let redactShouldThrow = false;
/** Swapped in by the large-artifact test so the encoder faces real pressure. */
let largeArtifact: Uint8Array | null = null;

/** Deterministic fake artifact standing in for a flattened redacted PDF. */
const FAKE_ARTIFACT = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

vi.mock('../src/shared/audit.js', () => ({
  recordAudit: async (record: Record<string, unknown>) => {
    auditRecords.push(record);
  },
  exportSignedAuditLog: async () => ({ entries: [], signature: '', publicKey: '' })
}));

vi.mock('../src/service-worker/documents.js', () => ({
  previewDocument: async () => ({ pages: [] }),
  redactDocument: async () => {
    if (redactShouldThrow) throw new Error('pipeline failure');
    return {
      outputName: 'report-redacted.pdf',
      outputBytes: largeArtifact ?? FAKE_ARTIFACT,
      outputMimeType: 'application/pdf',
      verification: {
        verified: true,
        darkRegions: 1,
        checkedRegions: 1,
        method: 'saved-file' as const,
        failures: []
      },
      redactedRegions: 1
    };
  },
  getLastSession: () => null,
  clearSession: async () => undefined,
  clearAllFiles: async () => {
    clearAllFilesCalls += 1;
  }
}));

const chromeMock = {
  runtime: {
    id: 'test',
    onMessage: { addListener: (fn: MessageListener) => messageListeners.push(fn) },
    onConnect: { addListener: () => undefined },
    sendMessage: (message: unknown) => {
      runtimeSent.push(message as Record<string, unknown>);
      return Promise.resolve();
    },
    connect: () => ({
      onMessage: { addListener: () => undefined },
      onDisconnect: { addListener: () => undefined },
      postMessage: () => undefined
    }),
    getURL: (path: string) => `chrome-extension://test/${path}`
  },
  storage: {
    session: {
      get: async () => ({}),
      set: async () => undefined,
      remove: async () => undefined
    },
    local: {
      get: async () => ({}),
      set: async () => undefined,
      remove: async () => undefined
    }
  },
  tabs: {
    query: async () => [],
    get: async () => ({ id: 42, url: 'https://example.com' }),
    sendMessage: async () => undefined,
    onRemoved: { addListener: () => undefined }
  },
  scripting: { executeScript: async () => undefined },
  commands: { onCommand: { addListener: () => undefined } },
  offscreen: { closeDocument: async () => undefined, createDocument: async () => undefined },
  downloads: {
    download: async (options: { filename: string; url: string; saveAs?: boolean }) => {
      downloadAttempts.push({ filename: options.filename, url: options.url, saveAs: options.saveAs });
      if (downloadShouldFail) throw new Error('downloads unavailable');
      return 1;
    }
  },
  windows: { getLastFocused: async () => ({ id: 1 }) },
  permissions: { contains: async () => false, request: async () => false, remove: async () => undefined },
  notifications: { create: async () => undefined }
};

async function invoke(raw: unknown, sender: Record<string, unknown>): Promise<unknown> {
  const listener = messageListeners[0];
  if (!listener) throw new Error('service worker onMessage listener was never registered');
  return new Promise((resolve) => {
    const syncResponse = listener(raw, sender, (response) => resolve(response));
    if (syncResponse !== true) resolve(undefined);
  });
}

const REDACT_REQUEST = {
  type: 'POPUP_DOC_REDACT',
  requestId: 'req-redact',
  docId: 'doc-1',
  fileKey: 'file-1',
  name: 'report.pdf',
  mimeType: 'application/pdf',
  kind: 'pdf',
  boxes: [],
  findingIds: []
};

const SENDER = { id: 'test', url: 'chrome-extension://test/popup.html' };

function redactAudit() {
  return auditRecords.find((r) => r.action === 'doc_redacted');
}

function docDoneMessage() {
  return runtimeSent.find((m) => m.type === 'POPUP_DOC_DONE') as Record<string, unknown> | undefined;
}

describe('document redaction audit integrity', () => {
  beforeAll(async () => {
    vi.stubGlobal('chrome', chromeMock);
    await import('../src/service-worker/index.js');
  });

  beforeEach(() => {
    runtimeSent.length = 0;
    downloadAttempts.length = 0;
    auditRecords.length = 0;
    downloadShouldFail = false;
    redactShouldThrow = false;
  });

  it('records outcome "ok" when the download actually succeeded', async () => {
    await invoke(REDACT_REQUEST, SENDER);
    expect(redactAudit(), 'a doc_redacted audit record must be emitted').toBeDefined();
    expect(redactAudit()!.outcome).toBe('ok');
    expect(downloadAttempts).toHaveLength(1);
    expect(downloadAttempts[0]!.filename).toBe('report-redacted.pdf');
  });

  it('does NOT claim success when the download fails', async () => {
    downloadShouldFail = true;
    await invoke(REDACT_REQUEST, SENDER);
    await invoke({ type: 'POPUP_DOC_DELIVERY_REPORT', requestId: 'req-redact', delivered: false }, SENDER);
    expect(redactAudit()).toBeDefined();
    // The defect recorded "ok" here. A failed delivery must never be logged as
    // a success inside a cryptographically signed audit chain.
    expect(redactAudit()!.outcome).not.toBe('ok');
    expect(redactAudit()!.outcome).toBe('error');
  });

  it('delivers the artifact exactly once on the happy path', async () => {
    await invoke(REDACT_REQUEST, SENDER);
    expect(downloadAttempts).toHaveLength(1);
  });

  it('does not ship bytes over the messaging channel when the download succeeded', async () => {
    await invoke(REDACT_REQUEST, SENDER);
    expect(docDoneMessage()).toBeDefined();
    expect(docDoneMessage()!.outputBytesBase64).toBeUndefined();
  });

  it('ships bytes to the popup for retry when the worker download failed', async () => {
    downloadShouldFail = true;
    await invoke(REDACT_REQUEST, SENDER);
    expect(docDoneMessage()).toBeDefined();
    expect(typeof docDoneMessage()!.outputBytesBase64).toBe('string');
  });

  it('records an error and downloads nothing when redaction itself fails', async () => {
    redactShouldThrow = true;
    await invoke(REDACT_REQUEST, SENDER);
    expect(redactAudit()).toBeDefined();
    expect(redactAudit()!.outcome).toBe('error');
    expect(downloadAttempts).toHaveLength(0);
    expect(runtimeSent.some((m) => m.type === 'POPUP_DOC_ERROR')).toBe(true);
  });

  it('never emits a doc_redacted "ok" record unless a delivery succeeded', async () => {
    // The sound direction of the invariant: an "ok" record REQUIRES a
    // successful delivery. A failed delivery may still have attempted one, so
    // the converse is deliberately not asserted.
    for (const shouldFail of [false, true]) {
      runtimeSent.length = 0;
      downloadAttempts.length = 0;
      auditRecords.length = 0;
      downloadShouldFail = shouldFail;
      await invoke(REDACT_REQUEST, SENDER);
      if (shouldFail) {
        await invoke({ type: 'POPUP_DOC_DELIVERY_REPORT', requestId: 'req-redact', delivered: false }, SENDER);
      }
      const record = redactAudit();
      expect(record).toBeDefined();
      if (record!.outcome === 'ok') {
        expect(downloadAttempts, 'an "ok" record requires an attempted delivery').toHaveLength(1);
        expect(docDoneMessage()!.outputBytesBase64, 'a delivered file needs no retry payload').toBeUndefined();
      } else {
        expect(record!.outcome).toBe('error');
        expect(docDoneMessage()!.outputBytesBase64, 'an undelivered file must be retryable').toBeDefined();
      }
    }
  });

  it('hands chrome.downloads a data: URL, because a service worker has no object URLs', async () => {
    await invoke(REDACT_REQUEST, SENDER);
    expect(downloadAttempts).toHaveLength(1);
    const { url } = downloadAttempts[0]!;
    // URL.createObjectURL is not part of ServiceWorkerGlobalScope. Calling it
    // threw a TypeError on every document redaction, so this primary delivery
    // path never once succeeded and every redaction silently degraded to the
    // popup fallback - which, combined with the audit contract above, wrote
    // outcome:"error" into the signed chain for artifacts the user did receive.
    expect(url.startsWith('blob:'), 'a blob: URL cannot be created in a service worker').toBe(false);
    expect(url.startsWith('data:'), 'a data: URL works from a service worker').toBe(true);
    expect(url.startsWith('data:application/pdf;base64,')).toBe(true);
  });

  it('encodes the artifact into the data URL losslessly', async () => {
    await invoke(REDACT_REQUEST, SENDER);
    const { url } = downloadAttempts[0]!;
    const b64 = url.slice('data:application/pdf;base64,'.length);
    const decoded = Buffer.from(b64, 'base64');
    expect([...decoded]).toEqual([...FAKE_ARTIFACT]);
  });

  it('base64-encodes a large artifact without blowing the call stack', async () => {
    // String.fromCharCode(...bytes) throws "Maximum call stack size exceeded"
    // above a few tens of thousands of arguments, and a 24-megapixel image is
    // far past that. The encoder walks the buffer in chunks.
    const big = new Uint8Array(1_000_000).fill(65);
    largeArtifact = big;
    await invoke(REDACT_REQUEST, SENDER);
    largeArtifact = null;
    const { url } = downloadAttempts[0]!;
    const decoded = Buffer.from(url.slice('data:application/pdf;base64,'.length), 'base64');
    expect(decoded.length).toBe(big.length);
    expect(decoded[0]).toBe(65);
    expect(decoded[decoded.length - 1]).toBe(65);
  });

  it('does not purge staged documents when the service worker merely wakes', () => {
    // MV3 terminates an idle worker after ~30s and restarts it on the next
    // event. Purging staged files at module scope therefore wiped a user's
    // document every time the worker cycled, so picking a file, spending longer
    // than the idle timeout reviewing findings, and then clicking "Redact
    // selected" failed with "The selected file is no longer available."
    // chrome.runtime.onStartup already covers real browser startup.
    expect(
      clearAllFilesCalls,
      'staged document bytes must survive a service-worker restart'
    ).toBe(0);
  });
});
