// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Loads the BUILT extension into Chromium and asserts the surfaces Chrome
// actually parses behave correctly. Static checks cannot catch a CSP block, a
// missing entry point, or a dead click handler, because none of those fail the
// build — they fail silently in the browser. Run from apps/redaction-extension:
//   npm run build && npm run verify:browser
//
// Requires a Chromium binary from `npx playwright install chromium`.
import { chromium } from "@playwright/test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const ext = resolve(join(root, "..", "dist"));

if (!existsSync(join(ext, "manifest.json"))) {
  throw new Error(`Missing ${join(ext, "manifest.json")}. Run \`npm run build\` first.`);
}

const EXTENSION_PAGES = ["popup.html", "sidepanel.html", "offscreen.html", "landing.html", "privacy.html"];
const CSP_VIOLATION = /Content Security Policy|Refused to (execute|inline|load|apply)/i;

const profile = mkdtempSync(join(tmpdir(), "gw-ext-verify-"));
const failures = [];

const fail = (page, detail) => failures.push(`${page}: ${detail}`);

const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  args: [
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
    "--no-first-run",
    "--no-default-browser-check",
  ],
});

try {
  // The service worker only registers once the extension loads; without it Chrome
  // rejected the manifest and every later assertion would be meaningless.
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 30_000 }));
  const extensionId = new URL(worker.url()).host;
  console.log(`extension id: ${extensionId}`);

  for (const name of EXTENSION_PAGES) {
    const page = await context.newPage();
    const cspViolations = [];
    const pageErrors = [];
    page.on("console", (message) => {
      if (CSP_VIOLATION.test(message.text())) cspViolations.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(String(error)));

    await page.goto(`chrome-extension://${extensionId}/${name}`, { waitUntil: "load" });
    await page.waitForTimeout(500);

    const inlineScript = await page.evaluate(
      () => [...document.querySelectorAll("script")].some((s) => !s.src && s.textContent.trim().length > 0)
    );
    if (inlineScript) fail(name, "page contains an inline <script> (blocked by script-src 'self')");
    for (const violation of cspViolations) fail(name, `CSP violation: ${violation}`);
    for (const error of pageErrors) fail(name, `uncaught error: ${error}`);

    const label = failures.length ? "FAIL" : "ok";
    console.log(`[${label}] ${name} inlineScript=${inlineScript} cspViolations=${cspViolations.length} errors=${pageErrors.length}`);
    await page.close();
  }

  // The landing page's tab strip is the regression this gate exists for: it was
  // an inline <script>, so MV3 CSP blocked it and the page shipped dead tabs
  // with no error anywhere.
  const landing = await context.newPage();
  await landing.goto(`chrome-extension://${extensionId}/landing.html`, { waitUntil: "load" });
  const tabCount = await landing.locator(".tab").count();
  if (tabCount < 2) {
    fail("landing.html", `expected multiple tabs, found ${tabCount}`);
  } else {
    await landing.locator(".tab").nth(1).click();
    await landing.waitForTimeout(200);
    const selected = await landing.locator(".tab").nth(1).getAttribute("aria-selected");
    const activePanels = await landing.locator('.panel[data-active="true"]').count();
    if (selected !== "true") fail("landing.html", "clicking a tab did not set aria-selected");
    if (activePanels !== 1) fail("landing.html", `expected exactly 1 active panel, found ${activePanels}`);
    console.log(`[tabs] count=${tabCount} selectedAfterClick=${selected} activePanels=${activePanels}`);
  }
  await landing.close();

  // The popup's side-panel trigger must exist AND its API call must resolve.
  // `chrome.sidePanel.open({ path })` is rejected by Chrome ("Unexpected
  // property: 'path'") and the call is refused outside a user gesture, so this
  // probes the real shape from a real click.
  const popup = await context.newPage();
  const popupErrors = [];
  popup.on("pageerror", (error) => popupErrors.push(String(error)));
  await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "load" });
  await popup.waitForTimeout(400);

  const triggerPresent = await popup.evaluate(() => Boolean(document.getElementById("open-side-panel-btn")));
  if (!triggerPresent) fail("popup.html", "side-panel trigger button is missing");

  const openResult = await popup.evaluate(async () => {
    const probe = document.createElement("button");
    probe.textContent = "probe";
    document.body.appendChild(probe);
    const { id: windowId } = await chrome.windows.getCurrent();
    return await new Promise((resolve) => {
      probe.addEventListener("click", async () => {
        try {
          await chrome.sidePanel.open({ windowId });
          resolve({ ok: true, windowId });
        } catch (error) {
          resolve({ ok: false, windowId, error: String(error) });
        }
      });
      probe.click();
    });
  });
  if (!openResult.ok) fail("popup.html", `sidePanel.open({ windowId }) rejected: ${openResult.error}`);
  for (const error of popupErrors) fail("popup.html", `uncaught error: ${error}`);
  console.log(`[sidepanel] trigger=${triggerPresent} open=${JSON.stringify(openResult)}`);
  await popup.close();

  // The Detection settings block lost its rule-pack controls and confidence
  // sliders. Removing nodes from the shared popup/panel bootstrap is where a
  // dead reference shows up as an uncaught error rather than a build failure,
  // so assert the surviving controls are still present and wired.
  for (const surface of ["popup.html", "sidepanel.html"]) {
    const page = await context.newPage();
    const settingsErrors = [];
    page.on("pageerror", (error) => settingsErrors.push(String(error)));
    await page.goto(`chrome-extension://${extensionId}/${surface}`, { waitUntil: "load" });
    await page.click("details > summary");
    await page.waitForTimeout(400);

    const ui = await page.evaluate(() => ({
      categories: document.querySelectorAll("#category-list input[type=checkbox]").length,
      presetOptions: document.querySelectorAll("#preset-select option").length,
      hasThresholdList: Boolean(document.getElementById("threshold-list")),
      hasImportPack: Boolean(document.getElementById("import-pack-btn")),
      hasExportPack: Boolean(document.getElementById("export-pack-btn")),
      hasDisclosure: /thresholds are applied automatically/i.test(document.body.innerText),
      rangeInputs: document.querySelectorAll('input[type="range"]').length,
    }));

    if (ui.categories < 10) fail(surface, `expected category checkboxes, found ${ui.categories}`);
    if (ui.presetOptions < 5) fail(surface, `expected preset options, found ${ui.presetOptions}`);
    if (ui.hasThresholdList || ui.hasImportPack || ui.hasExportPack) {
      fail(surface, `retired control still rendered: ${JSON.stringify(ui)}`);
    }
    if (ui.rangeInputs !== 0) fail(surface, `${ui.rangeInputs} range inputs still present`);
    if (!ui.hasDisclosure) fail(surface, "missing the threshold-disclosure copy");
    for (const error of settingsErrors) fail(surface, `uncaught error: ${error}`);
    console.log(`[settings] ${surface} ${JSON.stringify(ui)}`);
    await page.close();
  }

  // The service worker must reject a gesture-less open. This is Chrome's own
  // fail-closed behaviour, asserted so a future refactor cannot accidentally
  // rely on a side effect that only works while a gesture is live.
  const workerOpen = await worker.evaluate(async () => {
    const { id: windowId } = await chrome.windows.getLastFocused();
    try {
      await chrome.sidePanel.open({ windowId });
      return { opened: true };
    } catch (error) {
      return { opened: false, error: String(error) };
    }
  });
  if (workerOpen.opened) {
    fail("service-worker", "sidePanel.open() resolved without a user gesture; gesture gating is not being enforced");
  } else {
    console.log(`[service-worker] gesture-less open refused as expected`);
  }
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}

if (failures.length) {
  console.error("\nBrowser verification FAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("\nBrowser verification passed: all extension pages load CSP-clean and the side panel opens.");
