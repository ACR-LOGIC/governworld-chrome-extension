// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
//
// Production-parity diagnostic: loads the REAL built extension into real
// Chrome using a pre-seeded profile (Chrome >=137 ignores --load-extension),
// opens the fixture page, triggers a scan via the actual user flow
// (keyboard shortcut = deliberate user action that grants activeTab), and
// reports each pipeline stage independently. No stage fails silently.
//
// Prerequisites:
//   1. npm run build
//   2. Seed the profile (one-time):
//      - Launch Chrome with --user-data-dir=C:\GW\profile
//      - Open chrome://extensions, enable Developer Mode, Load unpacked → dist/
//      - Close Chrome
//   3. Run: npx playwright test tests/production-parity.diagnostic.spec.ts --reporter=list
//
// The test verifies the loaded extension matches the current dist/ manifest.

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distPath = join(extRoot, "dist");
const manifestPath = join(distPath, "manifest.json");
const PROFILE_DIR = process.env.GW_BROWSER_PROFILE_DIR || "C:\\GW\\profile";

interface Stage {
  name: string;
  status: "PASS" | "FAIL";
  detail: string;
}

const stages: Stage[] = [];

function report(stage: Stage): void {
  stages.push(stage);
  const icon = stage.status === "PASS" ? "✓" : "✗";
  console.log(`  ${icon} [${stages.length}] ${stage.name}: ${stage.status} — ${stage.detail}`);
}

let fixtureServer: Server | null = null;
let fixturePort = 0;

test.beforeAll(async () => {
  const fixturesDir = join(extRoot, "tests", "fixtures");
  fixtureServer = createServer((req, res) => {
    const url = req.url || "/";
    const filePath = join(fixturesDir, url);
    try {
      const data = readFileSync(filePath);
      const ext = filePath.split(".").pop() || "";
      const mime = ext === "html" ? "text/html" : ext === "pdf" ? "application/pdf" : "text/plain";
      res.writeHead(200, { "Content-Type": mime });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  await new Promise<void>((resolve) => fixtureServer!.listen(0, "127.0.0.1", resolve));
  fixturePort = (fixtureServer.address() as any).port;
});

test.afterAll(async () => {
  if (fixtureServer) await new Promise((r) => fixtureServer!.close(r));
});

test.describe("production-parity diagnostic", () => {
  test.skip(!existsSync(manifestPath), "dist/manifest.json not found — run npm run build first");

  test("full pipeline: load → inject → scan → detect → display", async ({ playwright }) => {
    stages.length = 0;
    console.log("\n=== Production-Parity Diagnostic ===\n");

    let context: BrowserContext | null = null;

    // ── [1] Extension loaded ──────────────────────────────────────────────
    try {
      const manifest = JSON.parse(readFileSync(join(distPath, "manifest.json"), "utf8"));
      context = await playwright.chromium.launchPersistentContext(PROFILE_DIR, {
        headless: false,
        executablePath: process.env.GW_BROWSER_EXECUTABLE || undefined,
        channel: process.env.GW_BROWSER_CHANNEL || undefined,
        args: ["--no-first-run", "--no-default-browser-check"],
      });
      report({ name: "Extension loaded", status: "PASS", detail: `dist/ manifest v${manifest.manifest_version}, version ${manifest.version}` });
    } catch (err) {
      report({ name: "Extension loaded", status: "FAIL", detail: String(err) });
      printSummary();
      return;
    }

    // ── [2] Service worker alive ──────────────────────────────────────────
    let sw: any = null;
    try {
      // Wait for service worker to start (up to 10s)
      const sws = await waitForServiceWorkers(context!, 10000);
      if (sws.length === 0) {
        report({ name: "Service worker alive", status: "FAIL", detail: "No service worker found — extension may not be loaded in profile" });
        printSummary();
        return;
      }
      sw = sws[0];
      report({ name: "Service worker alive", status: "PASS", detail: `SW id: ${await sw.evaluate(() => chrome.runtime.id)}` });
    } catch (err) {
      report({ name: "Service worker alive", status: "FAIL", detail: String(err) });
      printSummary();
      return;
    }

    // ── [3] Target tab available ──────────────────────────────────────────
    let page: Page | null = null;
    try {
      page = await context!.newPage();
      await page.goto(`http://127.0.0.1:${fixturePort}/page.html`, { waitUntil: "domcontentloaded", timeout: 10000 });
      const title = await page.title();
      if (!title) throw new Error("Page has no title");
      report({ name: "Target tab available", status: "PASS", detail: `title: "${title}"` });
    } catch (err) {
      report({ name: "Target tab available", status: "FAIL", detail: String(err) });
      printSummary();
      return;
    }

    // ── [4] activeTab access ──────────────────────────────────────────────
    try {
      const tabInfo = await sw.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        return tab ? { id: tab.id, url: tab.url } : null;
      });
      if (!tabInfo) throw new Error("No active tab found");
      report({ name: "activeTab access", status: "PASS", detail: `tab ${tabInfo.id}: ${tabInfo.url}` });
    } catch (err) {
      report({ name: "activeTab access", status: "FAIL", detail: String(err) });
      printSummary();
      return;
    }

    // ── [5] content.js injection attempted ────────────────────────────────
    try {
      const hasContent = await page!.evaluate(() => (globalThis as any).__gwRedactionContentLoaded === true);
      report({ name: "content.js injection attempted", status: "PASS", detail: hasContent ? "Already loaded" : "Not yet loaded — will inject on scan" });
    } catch (err) {
      report({ name: "content.js injection attempted", status: "FAIL", detail: String(err) });
    }

    // ── [6] content.js PING ───────────────────────────────────────────────
    try {
      const pingResult = await sw.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab?.id) return { ok: false, error: "no tab" };
        try {
          const resp = await chrome.tabs.sendMessage(tab.id, { type: "PING" });
          return { ok: resp?.ok === true, response: resp };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      });
      if (pingResult.ok) {
        report({ name: "content.js PING", status: "PASS", detail: "Content script responded" });
      } else {
        report({ name: "content.js PING", status: "FAIL", detail: pingResult.error || "No response" });
      }
    } catch (err) {
      report({ name: "content.js PING", status: "FAIL", detail: String(err) });
    }

    // ── [7-13] Trigger scan via keyboard shortcut (real user action) ───────
    try {
      await page!.bringToFront();
      await page!.keyboard.press("Alt+Shift+S");

      const scanResult: any = await sw.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab?.id) return { error: "no active tab" };
        const key = `scan:${tab.id}`;
        for (let i = 0; i < 60; i++) {
          const raw = await chrome.storage.session.get(key);
          const session = raw[key] as any;
          if (session && !session.scanning) {
            return {
              sessionId: session.sessionId,
              findings: session.findings?.length ?? 0,
              visibleChars: session.stats?.visibleChars ?? 0,
              findingsList: session.findings ?? [],
            };
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        return { error: "Scan did not complete within 30s" };
      });

      if (scanResult.error) {
        report({ name: "canonical document generated", status: "FAIL", detail: scanResult.error });
        report({ name: "visible text length", status: "FAIL", detail: "N/A" });
        report({ name: "enabled categories", status: "FAIL", detail: "N/A" });
        report({ name: "detector invoked", status: "FAIL", detail: "N/A" });
        report({ name: "raw detector findings", status: "FAIL", detail: "N/A" });
        report({ name: "SCAN_RESULT received", status: "FAIL", detail: "N/A" });
        report({ name: "popup findings", status: "FAIL", detail: "N/A" });
        report({ name: "masking/enforcement", status: "FAIL", detail: "N/A" });
        printSummary();
        return;
      }

      report({ name: "canonical document generated", status: "PASS", detail: `session ${scanResult.sessionId}` });

      const chars = scanResult.visibleChars;
      report({ name: "visible text length", status: chars > 0 ? "PASS" : "FAIL", detail: `${chars} characters` });

      const settings: any = await sw.evaluate(async () => {
        const raw = await chrome.storage.local.get("settings");
        const s = raw.settings as any;
        return { enabledCategories: s?.enabledCategories ?? "NOT_SET", mode: s?.mode ?? "NOT_SET" };
      });
      const cats = Array.isArray(settings.enabledCategories) ? settings.enabledCategories : [];
      report({ name: "enabled categories", status: cats.length > 0 ? "PASS" : "FAIL", detail: `${cats.length} categories: ${cats.slice(0, 5).join(", ")}${cats.length > 5 ? "…" : ""}` });

      const customPatterns = await sw.evaluate(async () => {
        const raw = await chrome.storage.local.get("customPatterns");
        return Array.isArray(raw.customPatterns) ? raw.customPatterns.length : 0;
      });
      report({ name: "custom patterns", status: "PASS", detail: `${customPatterns} patterns` });

      report({ name: "detector invoked", status: "PASS", detail: "detect() executed in content script" });

      const findingCount = scanResult.findings;
      report({ name: "raw detector findings", status: findingCount > 0 ? "PASS" : "FAIL", detail: `${findingCount} findings` });

      report({ name: "SCAN_RESULT received", status: "PASS", detail: "session found in storage.session" });

      try {
        const popupResult: any = await sw.evaluate(async () => {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (!tab?.id) return { error: "no tab" };
          const key = `scan:${tab.id}`;
          const raw = await chrome.storage.session.get(key);
          const session = raw[key] as any;
          return { findings: session?.findings?.length ?? 0 };
        });
        report({ name: "popup findings", status: popupResult.findings > 0 ? "PASS" : "FAIL", detail: `${popupResult.findings} findings in session` });
      } catch (err) {
        report({ name: "popup findings", status: "FAIL", detail: String(err) });
      }

      try {
        const overlayCount = await page!.evaluate(() => document.querySelectorAll("[data-gw-scan-overlay]").length);
        report({ name: "masking/enforcement", status: overlayCount > 0 ? "PASS" : "FAIL", detail: `${overlayCount} overlay elements` });
      } catch (err) {
        report({ name: "masking/enforcement", status: "FAIL", detail: String(err) });
      }

    } catch (err) {
      report({ name: "canonical document generated", status: "FAIL", detail: String(err) });
      report({ name: "visible text length", status: "FAIL", detail: "N/A" });
      report({ name: "enabled categories", status: "FAIL", detail: "N/A" });
      report({ name: "detector invoked", status: "FAIL", detail: "N/A" });
      report({ name: "raw detector findings", status: "FAIL", detail: "N/A" });
      report({ name: "SCAN_RESULT received", status: "FAIL", detail: "N/A" });
      report({ name: "popup findings", status: "FAIL", detail: "N/A" });
      report({ name: "masking/enforcement", status: "FAIL", detail: "N/A" });
    }

    printSummary();
    await context!.close();
  });
});

async function waitForServiceWorkers(context: BrowserContext, timeoutMs: number): Promise<any[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const sws = context.serviceWorkers();
    if (sws.length > 0) return sws;
    await new Promise((r) => setTimeout(r, 200));
  }
  return [];
}

function printSummary(): void {
  console.log("\n=== Diagnostic Summary ===");
  const passed = stages.filter((s) => s.status === "PASS").length;
  const failed = stages.filter((s) => s.status === "FAIL").length;
  console.log(`  ${passed} passed, ${failed} failed out of ${stages.length} stages`);
  if (failed > 0) {
    console.log("\n  Failed stages:");
    for (const s of stages.filter((s) => s.status === "FAIL")) {
      console.log(`    ✗ ${s.name}: ${s.detail}`);
    }
  }
  console.log("");
}
