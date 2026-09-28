// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

/**
 * Service-worker routing harness. The worker's onMessage listener is registered
 * at module load against the `chrome` global, so we stub a minimal chrome mock
 * before dynamically importing it, then drive the captured listener directly.
 *
 * The security property under test: content-originated message types
 * (SCAN_RESULT, COPY_REDACTED_TEXT_RESULT, CONTENT_ERROR) must carry a genuine
 * sender.tab. A validated message that lacks sender.tab is dropped — never
 * persisted to a session and never forwarded to the popup.
 */

type MessageListener = (
  raw: unknown,
  sender: Record<string, unknown>,
  sendResponse: (response: unknown) => void
) => boolean | void;

const messageListeners: MessageListener[] = [];
const sessionStore = new Map<string, unknown>();
const runtimeSent: unknown[] = [];

const chromeMock = {
  runtime: {
    id: "test",
    onMessage: { addListener: (fn: MessageListener) => messageListeners.push(fn) },
    onConnect: { addListener: () => undefined },
    sendMessage: (message: unknown) => {
      runtimeSent.push(message);
      return Promise.resolve();
    },
    connect: () => ({
      onMessage: { addListener: () => undefined },
      onDisconnect: { addListener: () => undefined },
      postMessage: () => undefined,
    }),
    getURL: (path: string) => `chrome-extension://test/${path}`,
  },
  storage: {
    session: {
      get: async (key: string | string[]) => {
        const keys = Array.isArray(key) ? key : [key];
        const out: Record<string, unknown> = {};
        for (const k of keys) out[k] = sessionStore.get(k);
        return out;
      },
      set: async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) sessionStore.set(k, v);
      },
      remove: async () => undefined,
    },
    local: {
      get: async () => ({}),
      set: async () => undefined,
      remove: async () => undefined,
    },
  },
  tabs: {
    query: async () => [],
    get: async () => ({ id: 42, url: "https://example.com" }),
    sendMessage: async () => undefined,
    onRemoved: { addListener: () => undefined },
    onUpdated: { addListener: () => undefined },
  },
  scripting: { executeScript: async () => undefined },
  commands: { onCommand: { addListener: () => undefined } },
  offscreen: {
    closeDocument: async () => undefined,
    createDocument: async () => undefined,
  },
  downloads: { download: async () => undefined },
};

async function invoke(raw: unknown, sender: Record<string, unknown>): Promise<unknown> {
  const listener = messageListeners[0];
  if (!listener) throw new Error("service worker onMessage listener was never registered");
  return new Promise((resolve) => {
    const syncResponse = listener(raw, sender, (response) => resolve(response));
    if (syncResponse !== true) resolve(undefined);
  });
}

describe("service-worker message routing (content-originated types require sender.tab)", () => {
  beforeAll(async () => {
    vi.stubGlobal("chrome", chromeMock);
    await import("../src/service-worker/index.js");
  });

  beforeEach(() => {
    sessionStore.clear();
    runtimeSent.length = 0;
  });

  it("denies SCAN_RESULT / COPY_REDACTED_TEXT_RESULT / CONTENT_ERROR when sender.tab is absent", async () => {
    const base = { requestId: "req-deny", sessionId: "sess-deny" };
    const cases = [
      { type: "SCAN_RESULT", ...base, findings: [], stats: { visibleChars: 0, truncated: false } },
      { type: "COPY_REDACTED_TEXT_RESULT", ...base, text: "redacted text" },
      { type: "CONTENT_ERROR", ...base, code: "DOC_ERROR", userMessage: "boom" },
    ];
    for (const msg of cases) {
       const response = await invoke(msg, { url: "https://example.com", id: "test" });
       expect(response).toEqual({ ok: false, error: "Unauthorized sender" });
    }
    // Denied: no session row was written and nothing reached the popup.
    expect([...sessionStore.keys()].some((k) => k.startsWith("scan:"))).toBe(false);
    expect(runtimeSent).toEqual([]);
  });

  it("denies privileged messages from an untrusted extension sender", async () => {
    const response = await invoke(
      { type: "POPUP_GET_STATE", requestId: "req-unauthorized" },
      { id: "other-extension", url: "chrome-extension://other-extension/popup.html" }
    );
    expect(response).toEqual({ ok: false, error: "Unauthorized sender" });
  });

  it("processes a tab-bearing SCAN_RESULT (control, proves the guard is what denies)", async () => {
    (chromeMock.tabs.query as unknown) = async () => [{ id: 42, url: "https://example.com" }];
    await invoke(
      { type: "POPUP_SCAN", requestId: "req-pending", mode: "local" },
      { id: "test", url: "chrome-extension://test/popup.html" }
    );
    const sessionStoreKeys = [...sessionStore.keys()];
    const scanSession = sessionStore.get(sessionStoreKeys.find((k) => k.startsWith("scan:")) as string) as {
      sessionId: string;
    };
    const msg = {
      type: "SCAN_RESULT",
      requestId: "req-pending",
      sessionId: scanSession.sessionId,
      findings: [],
      stats: { visibleChars: 0, truncated: false },
    };
     const response = await invoke(msg, {
        id: "test",
        url: "https://example.com/page",
        tab: { id: 42, url: "https://example.com" },
      });
    expect(response).toEqual({ ok: true });
    const stored = sessionStore.get("scan:42") as { sessionId: string } | undefined;
    expect(stored?.sessionId).toBe(scanSession.sessionId);
    expect(runtimeSent).toHaveLength(1);
    expect(runtimeSent[0]).toMatchObject({ type: "POPUP_STATE" });
  });

  it("drops a SCAN_RESULT whose sessionId does not match the pending scan", async () => {
    // Give the worker an active tab so POPUP_SCAN registers a pending scan.
    (chromeMock.tabs.query as unknown) = async () => [{ id: 42, url: "https://example.com" }];
    await invoke(
      { type: "POPUP_SCAN", requestId: "req-pending", mode: "local" },
       { id: "test", url: "chrome-extension://test/popup.html" }
    );

    const stale = {
      type: "SCAN_RESULT",
      requestId: "req-pending",
      sessionId: "sess-stale",
      findings: [],
      stats: { visibleChars: 0, truncated: false },
    };
     const response = await invoke(stale, {
       id: "test",
       url: "https://example.com/page",
       tab: { id: 42, url: "https://example.com" },
     });
    expect(response).toEqual({ ok: true });
    // Mismatched result is dropped fail-closed: the stored session must NOT be
    // overwritten with the stale sessionId, and nothing reaches the popup.
    const stored = sessionStore.get("scan:42") as { sessionId: string } | undefined;
    expect(stored?.sessionId).toBeTruthy();
    expect(stored?.sessionId).not.toBe("sess-stale");
    expect(runtimeSent).toEqual([]);
  });

  it("accepts a SCAN_RESULT whose sessionId matches the pending scan", async () => {
    (chromeMock.tabs.query as unknown) = async () => [{ id: 42, url: "https://example.com" }];
    await invoke(
      { type: "POPUP_SCAN", requestId: "req-pending", mode: "local" },
       { id: "test", url: "chrome-extension://test/popup.html" }
    );
    const sessionStoreKeys = [...sessionStore.keys()];
    const scanSession = sessionStore.get(sessionStoreKeys.find((k) => k.startsWith("scan:")) as string) as {
      sessionId: string;
    };

    const matching = {
      type: "SCAN_RESULT",
      requestId: "req-pending",
      sessionId: scanSession.sessionId,
      findings: [],
      stats: { visibleChars: 0, truncated: false },
    };
     const response = await invoke(matching, {
       id: "test",
       url: "https://example.com/page",
       tab: { id: 42, url: "https://example.com" },
     });
    expect(response).toEqual({ ok: true });
    expect(runtimeSent).toHaveLength(1);
    expect(runtimeSent[0]).toMatchObject({ type: "POPUP_STATE" });
  });
});