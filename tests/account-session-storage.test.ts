// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

/**
 * Account storage split (security invariant under test).
 *
 * The user-pasted `gw_*` billing key is a long-lived bearer credential. It is
 * NEVER written to chrome.storage.local (unencrypted, persistent at rest). It
 * lives only in chrome.storage.session (in-memory, cleared when the browser
 * session ends). chrome.storage.local holds only non-secret metadata
 * (gateway origin + linked flag).
 *
 * Consequence: after a fresh browser start the account is still "linked"
 * (metadata survives) but the credential is gone. Privileged flows must read
 * the key lazily from session and FAIL CLOSED with a re-entry message when it
 * is missing — never fall back to a stored key, because none is ever stored.
 *
 * The worker's onMessage listener is registered at module load against the
 * `chrome` global, so we stub a chrome mock before dynamically importing it,
 * then drive the captured listener directly (same harness as
 * service-worker-router.test.ts). chrome.storage.session is cleared to model a
 * browser restart (session area wipes; local area persists).
 */

type MessageListener = (
  raw: unknown,
  sender: Record<string, unknown>,
  sendResponse: (response: unknown) => void
) => boolean | void;

const messageListeners: MessageListener[] = [];
const localStore = new Map<string, unknown>();
const sessionStore = new Map<string, unknown>();
const runtimeSent: unknown[] = [];
const createdTabs: unknown[] = [];

function area(map: Map<string, unknown>) {
  return {
    get: async (keys: string | string[]) => {
      const list = typeof keys === "string" ? [keys] : keys;
      const out: Record<string, unknown> = {};
      for (const k of list) {
        const v = map.get(k);
        if (v !== undefined) out[k] = v;
      }
      return out;
    },
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) map.set(k, v);
    },
    remove: async (keys: string | string[]) => {
      const list = typeof keys === "string" ? [keys] : keys;
      for (const k of list) map.delete(k);
    },
  };
}

const chromeMock = {
  runtime: {
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
    session: area(sessionStore),
    local: area(localStore),
  },
  tabs: {
    query: async () => [],
    get: async () => ({ id: 42, url: "https://example.com" }),
    sendMessage: async () => undefined,
    create: async (tab: unknown) => {
      createdTabs.push(tab);
      return tab;
    },
    onRemoved: { addListener: () => undefined },
    onUpdated: { addListener: () => undefined },
  },
  scripting: { executeScript: async () => undefined },
  commands: { onCommand: { addListener: () => undefined } },
  permissions: {
    contains: async () => false,
    request: async () => false,
    remove: async () => false,
  },
  offscreen: {
    closeDocument: async () => undefined,
    createDocument: async () => undefined,
  },
  downloads: { download: async () => undefined },
};

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

interface FetchRecord {
  method: string;
  url: string;
  auth: string | null;
}

const fetchLog: FetchRecord[] = [];
let responder: (url: string) => FakeResponse;

const GW = "https://api.governworld.acrlogic.com";
const API_KEY = "gw_live_Kd9fN2vQ7xRt4cZ";
const PLAN = { id: "redaction-extension-addon", name: "Redaction add-on", priceId: "price_1ABC" };
const CHECKOUT_URL = "https://checkout.stripe.com/c/pay/cs_test_123";

function fakeResponse(status: number, body: unknown): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function defaultResponder(url: string): FakeResponse {
  const path = new URL(url).pathname;
  if (path === "/health") return fakeResponse(200, { status: "ok" });
  if (path === "/v1/billing/plans") return fakeResponse(200, { plans: [PLAN] });
  if (path === "/v1/billing/checkout") return fakeResponse(200, { url: CHECKOUT_URL });
  return fakeResponse(500, {});
}

async function captureFetch(input: RequestInfo | URL, init?: RequestInit): Promise<FakeResponse> {
  const url = String(input);
  const headers = (init?.headers ?? {}) as Record<string, unknown>;
  const auth = typeof headers.Authorization === "string" ? headers.Authorization : null;
  fetchLog.push({ method: init?.method ?? "GET", url, auth });
  return responder(url);
}

async function invoke(raw: unknown, sender: Record<string, unknown>): Promise<unknown> {
  const listener = messageListeners[0];
  if (!listener) throw new Error("service worker onMessage listener was never registered");
  return new Promise((resolve) => {
    const syncResponse = listener(raw, sender, (response) => resolve(response));
    if (syncResponse !== true) resolve(undefined);
  });
}

const panelSender = { url: "chrome-extension://test/sidepanel.html" };

function accountStates(): Array<Record<string, unknown>> {
  return runtimeSent.filter(
    (m): m is Record<string, unknown> =>
      typeof m === "object" && m !== null && (m as { type?: unknown }).type === "POPUP_ACCOUNT_STATE"
  );
}

function lastAccountState(): Record<string, unknown> {
  const states = accountStates();
  const last = states[states.length - 1];
  if (!last) throw new Error("no POPUP_ACCOUNT_STATE was emitted");
  return last;
}

// notifyAccountState is dispatched as `void` on POPUP_GET_STATE, so its message
// can land after the invoke() response resolves. Poll briefly for it.
async function waitForAccountState(timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (accountStates().length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(accountStates().length).toBeGreaterThan(0);
}

async function linkAccount(): Promise<void> {
  const response = await invoke(
    { type: "POPUP_ACCOUNT_SAVE", requestId: "r-link", gatewayOrigin: GW, apiKey: API_KEY },
    panelSender
  );
  expect(response).toEqual({ ok: true });
}

describe("service-worker account storage (credential is session-only, never at rest)", () => {
  beforeAll(async () => {
    vi.stubGlobal("chrome", chromeMock);
    await import("../src/service-worker/index.js");
  });

  beforeEach(() => {
    localStore.clear();
    sessionStore.clear();
    runtimeSent.length = 0;
    fetchLog.length = 0;
    createdTabs.length = 0;
    responder = defaultResponder;
    vi.stubGlobal("fetch", captureFetch as unknown as typeof fetch);
  });

  it("(a) linking stores only non-secret metadata in local — never the api key at rest", async () => {
    await linkAccount();

    // No credential anywhere in chrome.storage.local.
    expect(localStore.has("accountApiKey")).toBe(false);
    for (const [, value] of localStore) {
      expect(JSON.stringify(value)).not.toContain(API_KEY);
    }
    // Metadata + settings gateway origin live in local (non-secret).
    expect(localStore.get("account")).toEqual({ gatewayOrigin: GW, linked: true });
    expect((localStore.get("settings") as { gatewayOrigin?: string | null }).gatewayOrigin).toBe(GW);
    // The live credential is in chrome.storage.session only.
    expect(sessionStore.get("accountApiKey")).toBe(API_KEY);

    // The emitted state distinguishes linked metadata from the live credential.
    expect(lastAccountState()).toMatchObject({
      type: "POPUP_ACCOUNT_STATE",
      linked: true,
      credentialAvailable: true,
      gatewayOrigin: GW,
    });
  });

  it("(b) privileged purchase sources the credential from session and authenticates with it", async () => {
    await linkAccount();

    fetchLog.length = 0;
    const response = await invoke(
      { type: "POPUP_ACCOUNT_PURCHASE", requestId: "r-purchase", planId: PLAN.id },
      panelSender
    );
    expect(response).toEqual({ ok: true });

    // The credential that authorizes the requests is exactly the session-only key
    // (no other copy exists anywhere), so the session value must be the source.
    expect(sessionStore.get("accountApiKey")).toBe(API_KEY);
    expect(localStore.has("accountApiKey")).toBe(false);
    expect(fetchLog).toHaveLength(2);
    expect(fetchLog[0]).toMatchObject({
      method: "GET",
      url: `${GW}/v1/billing/plans`,
      auth: `Bearer ${API_KEY}`,
    });
    expect(fetchLog[1]).toMatchObject({
      method: "POST",
      url: `${GW}/v1/billing/checkout`,
      auth: `Bearer ${API_KEY}`,
    });
    expect(createdTabs).toHaveLength(1);
    expect(runtimeSent[runtimeSent.length - 1]).toMatchObject({
      type: "POPUP_ACCOUNT_PURCHASE_URL",
      url: CHECKOUT_URL,
    });
  });

  it("(c) after a browser restart the account is still linked but purchases fail closed with a re-entry message", async () => {
    await linkAccount();

    // Simulate a browser restart: chrome.storage.session is wiped (in-memory),
    // while chrome.storage.local (metadata/settings) persists.
    sessionStore.clear();
    fetchLog.length = 0;
    runtimeSent.length = 0;

    // State still reports "linked" (metadata) but no live credential.
    await invoke({ type: "POPUP_GET_STATE", requestId: "r-state" }, panelSender);
    await waitForAccountState();
    const state = lastAccountState();
    expect(state).toMatchObject({
      type: "POPUP_ACCOUNT_STATE",
      linked: true,
      gatewayOrigin: GW,
      credentialAvailable: false,
    });
    expect(state.error).toBeUndefined();

    runtimeSent.length = 0;

    // A purchase attempt fails closed: no request of any kind is fired and the
    // user gets the re-entry message — no silent success, no stored-key fallback.
    const response = await invoke(
      { type: "POPUP_ACCOUNT_PURCHASE", requestId: "r-purchase-restart", planId: PLAN.id },
      panelSender
    );
    expect(response).toEqual({ ok: true });
    expect(fetchLog).toHaveLength(0);
    expect(runtimeSent.some((m) => (m as { type?: unknown }).type === "POPUP_ACCOUNT_PURCHASE_URL")).toBe(false);

    expect(lastAccountState()).toMatchObject({
      type: "POPUP_ACCOUNT_STATE",
      linked: true,
      credentialAvailable: false,
      error: {
        code: "ACCOUNT_CREDENTIAL_REQUIRED",
        userMessage: "Re-enter your key to continue purchases in this browser session.",
      },
    });
  });

  it("(d) disconnect clears both the session credential and the local metadata", async () => {
    await linkAccount();
    expect(sessionStore.has("accountApiKey")).toBe(true);
    expect(localStore.has("account")).toBe(true);

    const response = await invoke({ type: "POPUP_ACCOUNT_CLEAR", requestId: "r-clear" }, panelSender);
    expect(response).toEqual({ ok: true });

    // Both areas are cleared, including any legacy at-rest key.
    expect(sessionStore.has("accountApiKey")).toBe(false);
    expect(localStore.has("account")).toBe(false);
    expect(localStore.has("accountApiKey")).toBe(false);
    expect((localStore.get("settings") as { gatewayOrigin?: string | null }).gatewayOrigin).toBeNull();

    expect(lastAccountState()).toMatchObject({
      type: "POPUP_ACCOUNT_STATE",
      linked: false,
      credentialAvailable: false,
      gatewayOrigin: null,
    });
  });
});
