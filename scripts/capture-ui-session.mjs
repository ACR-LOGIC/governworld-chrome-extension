// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Interactive UI session capture: drives the BUILT extension in a real Chromium
// window, exercising the 4-destination popup, the side panel, the settings
// sub-navigation, the dialogs, a live page scan, and the full document
// redaction flow — recording a video of the whole journey and a screenshot at
// every step.
//
//   npm run build && npm run capture:ui
//
// Artifacts land in .tmp-ui-session/ (gitignored):
//   shots/NN-step.png   one per step
//   video/*.webm        one file per recorded page
//   downloads/          the redacted artifact
//   report.json         step list, scan result, console errors
//
// Two protocol details this has to respect, both learned from the photo E2E:
//  1. The service worker cannot receive its own broadcast. POPUP_STATE is
//     delivered to extension pages, so the listener must live on the popup.
//  2. POPUP_SCAN targets the browser's active tab, so the fixture page has to be
//     in front at the moment the message is sent.
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = join(root, "dist");
const fixtures = join(root, "tests", "fixtures");
const WORK = join(root, ".tmp-ui-session");
const EXT = join(WORK, "ext");
const SHOTS = join(WORK, "shots");
const VIDEO = join(WORK, "video");
const DOWNLOADS = join(WORK, "downloads");
const STEP_BUDGET_MS = 300_000;
const PORT = 8081;
const ORIGIN = `http://localhost:${PORT}`;

if (!existsSync(join(dist, "manifest.json"))) {
  console.error("dist/manifest.json missing - run `npm run build` first.");
  process.exit(1);
}
if (!existsSync(join(fixtures, "photo-pii.png"))) {
  console.error("missing fixture - run `npm run fixtures:photo` first.");
  process.exit(1);
}

/** Best-effort recursive delete: a previous run's Chromium can still hold the profile. */
function safeRm(dir, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (err) {
      if (i === attempts - 1) {
        console.warn(`could not remove ${dir}: ${err.code ?? err.message}`);
        return false;
      }
      // Busy-wait briefly for the OS to release the handle.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    }
  }
  return false;
}

for (const d of [SHOTS, VIDEO, DOWNLOADS]) safeRm(d);
mkdirSync(SHOTS, { recursive: true });
mkdirSync(VIDEO, { recursive: true });
mkdirSync(DOWNLOADS, { recursive: true });
// Unique profile per run so a locked leftover never blocks a fresh start.
const PROFILE = join(WORK, `profile-${Date.now()}`);

// ------------------------------------------------- temp manifest for scanning
// The shipped manifest is least-privilege on purpose: activeTab, no
// host_permissions. activeTab is only granted by a real toolbar click on the
// extension action, which automation cannot synthesise, so a live page scan is
// impossible against dist/ as shipped. Follow the pattern already used by
// scripts/capture-screenshots.mjs: build a THROWAWAY extension dir that adds a
// localhost-only host permission, and load that. dist/ is never modified, and
// the shipped manifest keeps its zero-egress posture.
safeRm(EXT);
cpSync(dist, EXT, { recursive: true });
const manifestPath = join(EXT, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.host_permissions = [`${ORIGIN}/*`];
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
const shipped = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
if (shipped.host_permissions) {
  console.error("refusing to run: dist/manifest.json already has host_permissions");
  process.exit(1);
}
console.log(`temp extension variant: ${EXT} (localhost host permission only)`);

const MIME = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".pdf": "application/pdf" };
const server = createServer((req, res) => {
  const name = decodeURIComponent((req.url ?? "/").replace(/^\/+/, "")) || "page.html";
  const file = join(fixtures, name);
  if (!file.startsWith(fixtures) || !existsSync(file)) return void res.writeHead(404).end("not found");
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
const FIXTURE = `${ORIGIN}/page.html`;

// ------------------------------------------------------------------- reporting

const steps = [];
const errors = [];
const skipped = [];
let stepNo = 0;
const started = Date.now();

/** Wrap a step so a hang surfaces as a named failure instead of a silent stall. */
async function step(name, fn) {
  stepNo += 1;
  const t0 = Date.now();
  let out;
  try {
    out = await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`step "${name}" exceeded ${STEP_BUDGET_MS / 1000}s`)), STEP_BUDGET_MS)),
    ]);
  } catch (err) {
    errors.push(`step ${name}: ${err.message}`);
    console.log(`  [${String(stepNo).padStart(2, "0")}] ${name} — FAILED: ${err.message}`);
    return null;
  }
  console.log(`  [${String(stepNo).padStart(2, "0")}] ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  return out;
}

async function shot(page, name, note) {
  const file = join(SHOTS, `${String(stepNo).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  steps.push({ n: stepNo, name, note, shot: file });
}

/**
 * Click through the page's own DOM instead of via the driver.
 *
 * Playwright's page.click() focuses the tab, which would make the popup the
 * browser's active tab. The worker's tab resolver filters extension URLs out but
 * then falls back to the focused tab, so it would look for a scan session that
 * belongs to the popup and report "Run a scan first". An in-page el.click()
 * dispatches the real listener without changing which tab is active.
 */
async function clickInPage(page, selector) {
  const ok = await page.$eval(selector, (el) => {
    if (!(el instanceof HTMLElement) || el.hasAttribute("disabled")) return false;
    el.click();
    return true;
  });
  if (!ok) throw new Error(`${selector} is missing or disabled`);
  return true;
}

function watch(page, label) {
  page.on("pageerror", (e) => errors.push(`${label}: pageerror ${e}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    // A missing favicon on the local fixture server is noise, not a finding.
    if (/favicon/i.test(text) || /Failed to load resource.*404/.test(text)) return;
    errors.push(`${label}: console ${text}`);
  });
  return page;
}

// ---------------------------------------------------------------------- launch

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: 1280, height: 900 },
  recordVideo: { dir: VIDEO, size: { width: 1280, height: 900 } },
  acceptDownloads: true,
  downloadsPath: DOWNLOADS,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    "--no-first-run",
    "--no-default-browser-check",
  ],
});

let extensionId = "unknown";
let pageScan = null;
let maskedCount = 0;
let downloadInfo = null;

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 30_000 }));
  extensionId = new URL(worker.url()).host;
  console.log(`extension id: ${extensionId}\nfixture: ${FIXTURE}\n`);

  // The extension saves through chrome.downloads, which prompts with a Save As
  // dialog on a fresh profile. Attach the download policy over CDP — from a Page
  // (not the service worker) and keep that page open for the whole run, otherwise
  // the policy is dropped and downloads fail with FILE_ACCESS_DENIED.
  const policyPage = watch(await context.newPage(), "download-policy");
  const cdp = await context.newCDPSession(policyPage);
  await cdp.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: DOWNLOADS,
    eventsEnabled: true,
  });
  cdp.on("Browser.downloadProgress", (e) => {
    if (e.state !== "inProgress") console.log(`  [download] ${e.state} (${e.totalBytes ?? 0} bytes)`);
  });

  // --- Fixture page, before activation ------------------------------------
  const fixture = watch(await context.newPage(), "fixture");
  await fixture.goto(FIXTURE, { waitUntil: "load" });
  await fixture.bringToFront();
  await fixture.waitForTimeout(500);
  const preInjection = await fixture.evaluate(() => globalThis.__gwRedactionContentLoaded === true);
  console.log(`content script present before activation: ${preInjection} (expected false)`);
  await shot(fixture, "fixture-before-scan", "no content script before user action");

  // --- Popup page (kept in the background as the message endpoint) --------
  const popup = watch(await context.newPage(), "popup");
  await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "load" });
  // The worker purges staged files on chrome.runtime.onInstalled, which races the
  // first write in a fresh profile. Let it finish before anything is staged.
  await popup.waitForTimeout(3000);
  await shot(popup, "popup-01-protection", "default landing surface");

  // --- Live page scan ------------------------------------------------------
  // The content script is normally injected by an activeTab grant, which only a
  // real toolbar click produces. Playwright cannot synthesise that gesture, so
  // inject it from the worker first — the same route the photo E2E takes — then
  // drive the real POPUP_SCAN message.
  await fixture.bringToFront();
  const injection = await step("inject-content-script", () =>
    worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) return { ok: false, error: "no active tab" };
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
        return { ok: true, tabId: tab.id, url: tab.url };
      } catch (error) {
        return { ok: false, tabId: tab.id, error: String(error) };
      }
    }),
  );
  console.log(`  inject content.js: ${JSON.stringify(injection)}`);
  if (!injection?.ok) errors.push(`inject-content-script: ${injection?.error}`);

  pageScan = await step("page-scan", () =>
    popup.evaluate(
      (requestId) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("no POPUP_STATE within 45s")), 45_000);
          const listener = (msg) => {
            if (msg?.type !== "POPUP_STATE") return;
            clearTimeout(timer);
            chrome.runtime.onMessage.removeListener(listener);
            resolve({
              findings: msg.state.findings.length,
              categories: [...new Set(msg.state.findings.map((f) => f.category))].sort(),
            });
          };
          chrome.runtime.onMessage.addListener(listener);
          chrome.runtime
            .sendMessage({ type: "POPUP_SCAN", requestId, mode: "local" })
            .then((ack) => {
              if (ack && ack.ok === false) {
                clearTimeout(timer);
                chrome.runtime.onMessage.removeListener(listener);
                reject(new Error(`worker rejected POPUP_SCAN: ${ack.error}`));
              }
            })
            .catch((e) => {
              clearTimeout(timer);
              chrome.runtime.onMessage.removeListener(listener);
              reject(new Error(`sendMessage failed: ${e.message}`));
            });
        }),
      "ui-session-scan",
    ),
  );
  if (pageScan) {
    console.log(`  findings=${pageScan.findings} categories=${pageScan.categories.join(",")}`);
    await fixture.waitForTimeout(1000);
    await shot(fixture, "fixture-after-scan", `${pageScan.findings} findings detected on the page`);
  }

  // A scan raises the one-time "verify your work" notice unless it has already
  // been acknowledged in this profile. It is modal, so capture and dismiss it
  // before touching anything else. Dismissed in-page so the fixture stays the
  // active tab and the worker's scan session still resolves.
  await step("verify-notice", async () => {
    await popup.waitForTimeout(400);
    const open = await popup.$eval("#verify-dialog", (d) => d.open).catch(() => false);
    if (!open) return;
    await shot(popup, "popup-02-verify-notice", "one-time accuracy notice raised after a scan");
    await clickInPage(popup, "#verify-understood");
    await popup.waitForTimeout(400);
  });

  /** Close any modal that is still blocking pointer events. */
  const clearModals = async () => {
    const open = await popup.$$eval("dialog[open]", (ds) => ds.map((d) => d.id));
    for (const id of open) {
      const btn = await popup.$(`#${id} [id^="verify-"], #${id} [id$="-cancel"]`);
      if (btn) await btn.click().catch(() => popup.$eval(`#${id}`, (d) => d.close()).catch(() => undefined));
      else await popup.$eval(`#${id}`, (d) => d.close()).catch(() => undefined);
      await popup.waitForTimeout(200);
    }
  };
  await clearModals();

  // --- The findings list the real controller rendered ---------------------
  // Read in-page: bringing the popup to the front would steal tab focus and cost
  // us the worker's scan session for the apply-masks step below.
  await step("popup-findings-render", async () => {
    const shown = await popup.evaluate(() => ({
      sectionVisible: !document.getElementById("results-section").hidden,
      rows: document.querySelectorAll("#findings-list .finding").length,
      count: document.getElementById("results-count")?.textContent ?? "",
    }));
    console.log(`  results-section visible=${shown.sectionVisible} rows=${shown.rows} badge=${shown.count}`);
    if (!shown.sectionVisible || shown.rows === 0) {
      throw new Error(`findings list not rendered (visible=${shown.sectionVisible} rows=${shown.rows})`);
    }
    await shot(popup, "popup-02-findings", `${shown.rows} finding rows rendered in the popup`);
  });

  // --- Apply the masks onto the fixture page, while the fixture is active ---
  await step("apply-masks", async () => {
    const state = await popup.evaluate(() => ({
      resultsHidden: document.getElementById("results-section")?.hidden,
      rows: document.querySelectorAll("#findings-list .finding").length,
      enabled: !document.getElementById("apply-masks-btn")?.disabled,
    }));
    if (state.resultsHidden) throw new Error("results section is hidden; nothing to mask");
    if (!state.enabled) throw new Error(`apply-masks disabled with ${state.rows} findings rendered`);
    // Keep the fixture as the active tab and dispatch the real click in-page.
    await fixture.bringToFront();
    await clickInPage(popup, "#apply-masks-btn");
    await popup.waitForTimeout(2500);
    // Masks render inside the content script's shadow root, so the host element is
    // all a light-DOM query can see; count masks through the shadow root.
    const overlay = await fixture.evaluate(() => {
      const host = document.querySelector("div[data-gw-scan-overlay]");
      return {
        host: Boolean(host),
        masks: host?.shadowRoot ? host.shadowRoot.querySelectorAll("[data-kind]").length : 0,
        kinds: host?.shadowRoot ? [...new Set([...host.shadowRoot.querySelectorAll("[data-kind]")].map((e) => e.getAttribute("data-kind")))] : [],
      };
    });
    maskedCount = overlay.masks;
    const s = await popup.evaluate(() => document.getElementById("status")?.textContent?.trim() ?? "");
    console.log(`  host=${overlay.host} masks=${overlay.masks} kinds=${overlay.kinds.join(",")} status="${s}"`);
    if (/Run a scan first/.test(s)) throw new Error("worker had no scan session for the fixture tab");
    if (!overlay.masks) throw new Error(`no mask elements were rendered into the page (host=${overlay.host})`);
    await shot(fixture, "fixture-after-masks", `${overlay.masks} visual mask(s) over the page`);
  });

  // --- Every remaining tab (from here the popup may take focus freely) -----
  for (const tab of ["logic", "review", "settings"]) {
    await step(`tab-${tab}`, async () => {
      await popup.click(`#tab-btn-${tab}`);
      await popup.waitForTimeout(450);
      await shot(popup, `popup-03-tab-${tab}`, `${tab} destination`);
    });
  }

  // --- Every settings sub-page --------------------------------------------
  for (const sub of ["profile", "protection", "detection", "appearance", "notifications", "privacy", "advanced", "about"]) {
    await step(`settings-${sub}`, async () => {
      await popup.click(`[data-settings-page="${sub}"]`);
      await popup.waitForTimeout(350);
      await shot(popup, `popup-04-settings-${sub}`, `settings / ${sub}`);
    });
  }

  // --- Support & Contributions disclosure ----------------------------------
  await step("contributions", async () => {
    const open = await popup.$eval("#contributions-details", (d) => d.open);
    if (!open) {
      await popup.click("#contributions-details > summary");
      await popup.waitForTimeout(350);
    }
    await shot(popup, "popup-05-contributions", "support & contributions disclosure");
  });

  // --- A help link must reveal its guide card ------------------------------
  await step("help-link", async () => {
    await popup.click("#tab-btn-protection");
    await popup.waitForTimeout(250);
    await popup.click('[data-guide="guide-page-scan"]');
    await popup.waitForTimeout(700);
    const g = await popup.evaluate(() => {
      const about = document.getElementById("settings-page-about");
      const card = document.getElementById("guide-page-scan");
      return {
        settingsActive: !document.getElementById("tab-settings").hidden,
        aboutActive: about ? !about.hidden : false,
        cardVisible: card ? card.offsetParent !== null : false,
      };
    });
    console.log(`  settings=${g.settingsActive} about=${g.aboutActive} cardVisible=${g.cardVisible}`);
    if (!g.cardVisible) throw new Error(`help link did not reveal its card (${JSON.stringify(g)})`);
    await shot(popup, "popup-06-guide-from-help-link", "help link reveals its guide card");
  });

  // --- Wizard dialog -------------------------------------------------------
  await step("wizard", async () => {
    await popup.click("#tab-btn-logic");
    await popup.waitForTimeout(300);
    await popup.click("#open-wizard-btn-2");
    await popup.waitForTimeout(500);
    const open = await popup.evaluate(() => document.getElementById("wizard-dialog")?.open === true);
    if (!open) throw new Error("wizard dialog did not open");
    await shot(popup, "popup-07-wizard-dialog", "redaction wizard, step 1");
    await popup.click("#wizard-cancel-1");
    await popup.waitForTimeout(300);
  });

  // --- Document redaction through the real file input ----------------------
  await step("document-preview", async () => {
    await popup.click("#tab-btn-protection");
    await popup.waitForTimeout(300);
    // Retry: the onInstalled purge can clear the staged file on a fresh profile.
    let opened = false;
    let status = "";
    for (let attempt = 1; attempt <= 2 && !opened; attempt++) {
      await popup.setInputFiles("#doc-file-input", join(fixtures, "photo-pii.png"));
      try {
        await popup.waitForSelector("#doc-workspace:not([hidden])", { timeout: 130_000 });
        opened = true;
      } catch {
        status = await popup.$eval("#doc-status", (el) => el.textContent ?? "").catch(() => "");
        console.log(`  attempt ${attempt}: studio did not open (status: "${status}")`);
        await popup.waitForTimeout(2000);
      }
    }
    if (!opened) throw new Error(`document studio never opened; last status: "${status}"`);
    await popup.waitForTimeout(1500);
    const d = await popup.evaluate(() => ({
      count: document.getElementById("doc-findings-count")?.textContent ?? "",
      thumbs: document.querySelectorAll("#doc-thumbs .doc-thumb-wrapper").length,
    }));
    console.log(`  document findings=${d.count} pageThumbnails=${d.thumbs}`);
    await shot(popup, "popup-08-document-studio", `${d.count} findings on the page image`);
  });

  await step("redaction-style", async () => {
    await popup.selectOption("#doc-style-select", "stamp");
    await popup.waitForTimeout(600);
    await popup.fill("#doc-stamp-text", "[CONFIDENTIAL]");
    await popup.waitForTimeout(500);
    const revealed = await popup.evaluate(() => !document.getElementById("doc-stamp-container").hidden);
    if (!revealed) throw new Error("stamp container not revealed for the stamp style");
    await shot(popup, "popup-09-redaction-stamp-style", "text-stamp redaction style, canvas redrawn");
  });

  await step("redact-download", async () => {
    await popup.click("#doc-redact-btn");
    await popup.waitForTimeout(600);
    const dialog = await popup.$("#doc-confirm-dialog");
    if (dialog && (await dialog.evaluate((d) => d.open))) await popup.click("#doc-confirm");

    // The extension saves through chrome.downloads, so a Playwright `download`
    // event is not raised for it. The popup's own status line and its per-region
    // pixel verification are the authoritative confirmation.
    await popup
      .waitForFunction(
        () => /Saved\s+\S+\./.test(document.getElementById("doc-status")?.textContent ?? ""),
        undefined,
        { timeout: 150_000 },
      )
      .catch(() => undefined);

    const s = await popup.evaluate(() => ({
      status: document.getElementById("doc-status")?.textContent?.trim() ?? "",
      progress: document.getElementById("doc-progress-text")?.textContent?.trim() ?? "",
    }));
    console.log(`  status: ${s.status}`);
    console.log(`  verification: ${s.progress}`);
    if (!/Saved\s+\S+\./.test(s.status)) throw new Error(`redaction did not confirm: "${s.status}"`);
    if (!/regions? confirmed/.test(s.progress)) throw new Error(`no pixel verification reported: "${s.progress}"`);
    downloadInfo = { status: s.status, verification: s.progress };
    await popup.waitForTimeout(800);
    await shot(popup, "popup-10-redacted-download", "redaction saved and pixel-verified");
  });

  // --- Side panel ----------------------------------------------------------
  await step("sidepanel", async () => {
    const side = watch(await context.newPage(), "sidepanel");
    await side.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: "load" });
    await side.waitForTimeout(800);
    await shot(side, "sidepanel-01-protection", "side panel, same IA");
    await side.click("#tab-btn-review");
    await side.waitForTimeout(400);
    await shot(side, "sidepanel-02-review", "side panel review");
    await side.click("#tab-btn-settings");
    await side.click('[data-settings-page="about"]');
    await side.waitForTimeout(400);
    await shot(side, "sidepanel-03-settings-about", "side panel settings / about");
  });

} catch (err) {
  errors.push(`session: ${err.message}`);
  console.error(`session aborted: ${err.message}`);
} finally {
  await context.close();
  server.close();
}

const videos = readdirSync(VIDEO).filter((f) => f.endsWith(".webm")).map((f) => join(VIDEO, f));
writeFileSync(
  join(WORK, "report.json"),
  JSON.stringify(
    { extensionId, generatedAt: new Date().toISOString(), durationSec: Math.round((Date.now() - started) / 1000), pageScan, masksInjected: maskedCount, download: downloadInfo, steps, videos, skipped, errors },
    null,
    2,
  ),
);

console.log(`\nshots:   ${SHOTS} (${steps.length})`);
console.log(`videos:  ${VIDEO} (${videos.length})`);
for (const v of videos) console.log(`  ${v} (${statSync(v).size} bytes)`);
console.log(`duration: ${Math.round((Date.now() - started) / 1000)}s`);
console.log(`skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  ~ ${s}`);
console.log(`errors:  ${errors.length}`);
for (const e of errors) console.log("  ! " + e);
process.exit(errors.length ? 1 : 0);
