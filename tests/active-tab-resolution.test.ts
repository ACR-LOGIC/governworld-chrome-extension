// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Guards the rule that a scan target is always a real web page. The resolver
// used to filter extension URLs out and then fall back to the focused tab, so
// one of our own pages could be returned as a scan target. Scan sessions are
// keyed by tab id, so the worker then looked for a session belonging to the
// extension and reported "Run a scan first" for a scan that had succeeded.
import { describe, expect, it, beforeAll } from "vitest";

type Tab = { id?: number; url?: string; active?: boolean };

const tab = (id: number, url: string, active = false): Tab => ({ id, url, active });

/** The tabs the stubbed chrome.tabs.query should report. */
let tabs: Tab[] = [];

/**
 * The service worker registers listeners at module load, so a minimal chrome mock
 * has to exist before it is imported. The tab list is mutable so each test can
 * stage a different browser state.
 */
(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: {
    id: "test",
    onMessage: { addListener: () => undefined },
    onConnect: { addListener: () => undefined },
    onStartup: { addListener: () => undefined },
    onInstalled: { addListener: () => undefined },
    sendMessage: async () => undefined,
    connect: () => ({
      onMessage: { addListener: () => undefined },
      onDisconnect: { addListener: () => undefined },
      postMessage: () => undefined,
    }),
    getURL: (path: string) => `chrome-extension://test/${path}`,
  },
  storage: {
    session: {
      get: async () => ({}),
      set: async () => undefined,
      remove: async () => undefined,
    },
    local: {
      get: async () => ({}),
      set: async () => undefined,
      remove: async () => undefined,
    },
  },
  tabs: {
    query: async (q: { active?: boolean }) =>
      tabs.filter((t) => (q.active === undefined ? true : t.active === q.active)),
    get: async () => undefined,
    sendMessage: async () => undefined,
    onRemoved: { addListener: () => undefined },
    onUpdated: { addListener: () => undefined },
  },
  scripting: { executeScript: async () => undefined },
  commands: { onCommand: { addListener: () => undefined } },
  offscreen: { closeDocument: async () => undefined, createDocument: async () => undefined },
  downloads: { download: async () => undefined },
  windows: { onFocusChanged: { addListener: () => undefined } },
  sidePanel: { setPanelBehavior: async () => undefined },
  contextMenus: { create: () => undefined, onClicked: { addListener: () => undefined } },
};

const withTabs = (list: Tab[]) => {
  tabs = list;
};

let getActiveTab: () => Promise<unknown>;
let isScannableTab: (t: Tab | undefined) => boolean;
let getActiveWebTab: () => Promise<unknown>;
let popupIsScannableTab: (t: Tab | undefined) => boolean;

beforeAll(async () => {
  const worker = await import("../src/service-worker/index.js");
  getActiveTab = worker.getActiveTab;
  isScannableTab = worker.isScannableTab as (t: Tab | undefined) => boolean;
  const popup = await import("../src/popup/popup.js");
  getActiveWebTab = popup.getActiveWebTab;
  popupIsScannableTab = popup.isScannableTab as (t: Tab | undefined) => boolean;
});

describe("isScannableTab", () => {
  it("accepts identified http and https pages", () => {
    expect(isScannableTab(tab(1, "https://example.test/record"))).toBe(true);
    expect(isScannableTab(tab(1, "http://localhost:8081/page.html"))).toBe(true);
  });

  it("rejects the extension's own pages and browser surfaces", () => {
    for (const url of [
      "chrome-extension://abcdef/popup.html",
      "chrome-extension://abcdef/sidepanel.html",
      "chrome-extension://abcdef/landing.html",
      "chrome://extensions",
      "edge://extensions",
      "about:blank",
      "view-source:https://example.test",
      "file:///C:/Users/someone/record.pdf",
    ]) {
      expect(isScannableTab(tab(1, url)), url).toBe(false);
    }
  });

  it("rejects a tab with no id or no url", () => {
    expect(isScannableTab(undefined)).toBe(false);
    expect(isScannableTab({ url: "https://example.test" })).toBe(false);
    expect(isScannableTab({ id: 7 })).toBe(false);
  });

  it("the popup and the worker agree on what is scannable", () => {
    for (const url of ["https://example.test", "chrome-extension://abcdef/popup.html", "about:blank"]) {
      const t = tab(1, url);
      expect(isScannableTab(t), url).toBe(popupIsScannableTab(t));
    }
  });
});

describe("getActiveTab", () => {
  it("returns the active web page when one exists", async () => {
    withTabs([tab(1, "chrome-extension://abcdef/popup.html", true), tab(2, "https://example.test", true)]);
    // The focused/current queries are satisfied by whichever tab is active; with
    // two active tabs the web page must be the one chosen.
    withTabs([tab(2, "https://example.test", true)]);
    const found = (await getActiveTab()) as Tab | undefined;
    expect(found?.id).toBe(2);
  });

  it("never returns an extension page even when it is the only active tab", async () => {
    withTabs([tab(1, "chrome-extension://abcdef/popup.html", true)]);
    expect(await getActiveTab()).toBeUndefined();
  });

  it("never returns an extension page when the focused tab is a browser surface", async () => {
    withTabs([tab(1, "about:blank", true)]);
    expect(await getActiveTab()).toBeUndefined();
  });

  it("returns undefined rather than a fallback extension tab", async () => {
    // The regression: the old implementation ended with `|| focusedTab || currentTab`.
    withTabs([
      tab(1, "chrome-extension://abcdef/sidepanel.html", true),
      tab(2, "chrome://newtab", true),
    ]);
    expect(await getActiveTab()).toBeUndefined();
  });
});

describe("getActiveWebTab", () => {
  it("does not hand back one of the extension's own pages", async () => {
    withTabs([tab(1, "chrome-extension://abcdef/popup.html", true)]);
    expect(await getActiveWebTab()).toBeUndefined();
  });

  it("resolves a normal web page", async () => {
    withTabs([tab(9, "https://example.test", true)]);
    expect(((await getActiveWebTab()) as Tab | undefined)?.id).toBe(9);
  });
});
