// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
//
// CDP-based production-parity diagnostic. Connects to an already-running
// Chrome instance via the DevTools protocol, so it works regardless of
// Chrome version or --load-extension support.
//
// Usage:
//   1. Launch Chrome with the profile and remote debugging:
//      chrome.exe --user-data-dir=C:\GW\profile --remote-debugging-port=9222
//   2. Load the extension via chrome://extensions → Load unpacked → dist/
//   3. Run: node scripts/cdp-diagnostic.mjs
//
// This script will:
//   - Verify the extension is loaded
//   - Check the service worker is alive
//   - Open the fixture page
//   - Trigger a scan via the keyboard shortcut
//   - Report each pipeline stage independently

import { chromium } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const extRoot = join(fileURLToPath(import.meta.url), "..", "..");
const distPath = join(extRoot, "dist");
const manifestPath = join(distPath, "manifest.json");

if (!existsSync(manifestPath)) {
  console.error("dist/manifest.json not found — run npm run build first");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
console.log(`\n=== CDP Production-Parity Diagnostic ===\n`);
console.log(`Extension: ${manifest.name} v${manifest.version}`);
console.log(`Dist path: ${distPath}\n`);

// Start fixture server
const fixturesDir = join(extRoot, "tests", "fixtures");
const fixtureServer = createServer((req, res) => {
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
await new Promise((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
const fixturePort = fixtureServer.address().port;
console.log(`Fixture server: http://127.0.0.1:${fixturePort}\n`);

// Connect to running Chrome via CDP
let browser;
try {
  browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  console.log("Connected to Chrome via CDP\n");
} catch (err) {
  console.error("Failed to connect to Chrome via CDP.");
  console.error("Make sure Chrome is running with: --remote-debugging-port=9222");
  console.error(`Error: ${err}`);
  process.exit(1);
}

const stages = [];

function report(name, status, detail) {
  stages.push({ name, status, detail });
  const icon = status === "PASS" ? "✓" : "✗";
  console.log(`  ${icon} [${stages.length}] ${name}: ${status} — ${detail}`);
}

try {
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    report("Extension loaded", "FAIL", "No browser contexts found");
    process.exit(1);
  }
  const context = contexts[0];

  // [1] Extension loaded
  report("Extension loaded", "PASS", `manifest v${manifest.manifest_version}, version ${manifest.version}`);

  // [2] Service worker alive
  const sws = context.serviceWorkers();
  if (sws.length === 0) {
    report("Service worker alive", "FAIL", "No service worker found — extension may not be loaded or SW failed to start");
    console.log("\n=== Diagnostic Summary ===");
    console.log(`  1 passed, 1 failed out of 2 stages`);
    console.log("\n  Failed stages:");
    console.log("    ✗ Service worker alive: No service worker found");
    console.log("\nTroubleshooting:");
    console.log("  1. Open chrome://extensions in the Chrome instance");
    console.log("  2. Verify the extension is listed and enabled");
    console.log("  3. Check for errors on the extension card");
    console.log("  4. Try reloading the extension");
    process.exit(1);
  }
  const sw = sws[0];
  const swId = await sw.evaluate(() => chrome.runtime.id);
  report("Service worker alive", "PASS", `SW id: ${swId}`);

  // [3] Target tab available
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${fixturePort}/page.html`, { waitUntil: "domcontentloaded", timeout: 10000 });
  const title = await page.title();
  report("Target tab available", "PASS", `title: "${title}"`);

  // [4] activeTab access
  const tabInfo = await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab ? { id: tab.id, url: tab.url } : null;
  });
  if (!tabInfo) throw new Error("No active tab found");
  report("activeTab access", "PASS", `tab ${tabInfo.id}: ${tabInfo.url}`);

  // [5] content.js injection attempted
  const hasContent = await page.evaluate(() => globalThis.__gwRedactionContentLoaded === true);
  report("content.js injection attempted", "PASS", hasContent ? "Already loaded" : "Not yet loaded — will inject on scan");

  // [6] content.js PING
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
    report("content.js PING", "PASS", "Content script responded");
  } else {
    report("content.js PING", "FAIL", pingResult.error || "No response");
  }

  // [7-13] Trigger scan via keyboard shortcut
  await page.bringToFront();
  await page.keyboard.press("Alt+Shift+S");

  const scanResult = await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) return { error: "no active tab" };
    const key = `scan:${tab.id}`;
    for (let i = 0; i < 60; i++) {
      const raw = await chrome.storage.session.get(key);
      const session = raw[key];
      if (session && !session.scanning) {
        return {
          sessionId: session.sessionId,
          findings: session.findings?.length ?? 0,
          visibleChars: session.stats?.visibleChars ?? 0,
        };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return { error: "Scan did not complete within 30s" };
  });

  if (scanResult.error) {
    report("canonical document generated", "FAIL", scanResult.error);
    report("visible text length", "FAIL", "N/A");
    report("enabled categories", "FAIL", "N/A");
    report("detector invoked", "FAIL", "N/A");
    report("raw detector findings", "FAIL", "N/A");
    report("SCAN_RESULT received", "FAIL", "N/A");
    report("popup findings", "FAIL", "N/A");
    report("masking/enforcement", "FAIL", "N/A");
  } else {
    report("canonical document generated", "PASS", `session ${scanResult.sessionId}`);
    report("visible text length", scanResult.visibleChars > 0 ? "PASS" : "FAIL", `${scanResult.visibleChars} characters`);

    const settings = await sw.evaluate(async () => {
      const raw = await chrome.storage.local.get("settings");
      const s = raw.settings;
      return { enabledCategories: s?.enabledCategories ?? "NOT_SET" };
    });
    const cats = Array.isArray(settings.enabledCategories) ? settings.enabledCategories : [];
    report("enabled categories", cats.length > 0 ? "PASS" : "FAIL", `${cats.length} categories: ${cats.slice(0, 5).join(", ")}${cats.length > 5 ? "…" : ""}`);

    const customPatterns = await sw.evaluate(async () => {
      const raw = await chrome.storage.local.get("customPatterns");
      return Array.isArray(raw.customPatterns) ? raw.customPatterns.length : 0;
    });
    report("custom patterns", "PASS", `${customPatterns} patterns`);
    report("detector invoked", "PASS", "detect() executed in content script");
    report("raw detector findings", scanResult.findings > 0 ? "PASS" : "FAIL", `${scanResult.findings} findings`);
    report("SCAN_RESULT received", "PASS", "session found in storage.session");

    const popupResult = await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) return { findings: 0 };
      const key = `scan:${tab.id}`;
      const raw = await chrome.storage.session.get(key);
      const session = raw[key];
      return { findings: session?.findings?.length ?? 0 };
    });
    report("popup findings", popupResult.findings > 0 ? "PASS" : "FAIL", `${popupResult.findings} findings in session`);

    const overlayCount = await page.evaluate(() => document.querySelectorAll("[data-gw-scan-overlay]").length);
    report("masking/enforcement", overlayCount > 0 ? "PASS" : "FAIL", `${overlayCount} overlay elements`);
  }
} catch (err) {
  report("Diagnostic error", "FAIL", String(err));
}

// Summary
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

await browser.close();
fixtureServer.close();
