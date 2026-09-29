// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
//
// Chrome Web Store screenshot generation.
//
// The store requires "at least one 1280x800 px screenshot, up to 5 total"
// (https://developer.chrome.com/docs/webstore/cws-dashboard-listing). The UI
// walkthrough in capture-ui-session.mjs is deliberately not reusable for that:
// it shoots fullPage at a 1280x900 viewport, so any surface that overflows gains
// a scrollbar and captures at 1265px wide, which the store will reject. This
// script shoots a fixed 1280x800 viewport with fullPage disabled, then verifies
// every emitted PNG's real pixel dimensions before declaring success.
//
// Fixtures are synthetic by construction (tests/fixtures/), so no real PII can
// reach a listing asset. Nothing here touches the real site or a user account.
//
//   npm run capture:store      # needs a display (headless: false)
//
// Output: release/screenshots/*.png
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = join(root, "dist");
const fixtures = join(root, "tests", "fixtures");
const WORK = join(root, ".tmp-store-shots");
const EXT = join(WORK, "ext");
const OUT = join(root, "release", "screenshots");

// The store's exact requirement. Emitted images are verified against this.
const W = 1280;
const H = 800;
const MAX_SHOTS = 5;
const PORT = 8082;
const ORIGIN = `http://localhost:${PORT}`;

if (!existsSync(join(dist, "manifest.json"))) {
  console.error("dist/manifest.json missing - run `npm run build` first.");
  process.exit(1);
}

rmSync(WORK, { recursive: true, force: true });
rmSync(OUT, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
mkdirSync(OUT, { recursive: true });

// Same constraint as the walkthrough: dist/ ships with no host permissions
// because activeTab needs a real toolbar gesture. Load a throwaway copy that
// adds a localhost-only permission. dist/ is never modified.
cpSync(dist, EXT, { recursive: true });
const manifestPath = join(EXT, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.host_permissions) {
  console.error("refusing to run: dist/manifest.json already has host_permissions");
  process.exit(1);
}
manifest.host_permissions = [`${ORIGIN}/*`];
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

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

/** Read real pixel dimensions from a PNG IHDR, so the check cannot lie. */
function pngSize(file) {
  const b = readFileSync(file);
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

const emitted = [];
async function shoot(page, name, note) {
  const file = join(OUT, `${name}.png`);
  // fullPage MUST stay false. It is what produced 1265px-wide captures before.
  await page.screenshot({ path: file, fullPage: false });
  const size = pngSize(file);
  if (!size) throw new Error(`${name}: not a PNG`);
  if (size.w !== W || size.h !== H) {
    throw new Error(`${name}: ${size.w}x${size.h}, store requires ${W}x${H}`);
  }
  emitted.push({ name, note, ...size });
  console.log(`  [ok] ${name} ${size.w}x${size.h}  ${note}`);
}

const PROFILE = join(WORK, `profile-${Date.now()}`);
const context = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: W, height: H },
  acceptDownloads: true,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    "--no-first-run",
    "--no-default-browser-check",
  ],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 30_000 }));
  const extensionId = new URL(worker.url()).host;
  const popupUrl = `chrome-extension://${extensionId}/popup.html`;
  console.log(`extension id: ${extensionId}\nfixture: ${FIXTURE}\noutput: ${OUT}\n`);

  // The fixture must be the focused tab: POPUP_SCAN resolves the browser's active
  // tab, so a real page scan only works while the page is in front.
  const fixture = await context.newPage();
  await fixture.goto(FIXTURE, { waitUntil: "load" });
  await fixture.bringToFront();
  await sleep(400);

  // The content script is normally injected by an activeTab grant, which only a
  // real toolbar click produces. Automation cannot synthesise that gesture, so
  // inject it from the worker first — the same route the UI walkthrough takes.
  const injection = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) return { ok: false, error: "no active tab" };
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      return { ok: true, tabId: tab.id, url: tab.url };
    } catch (error) {
      return { ok: false, tabId: tab.id, error: String(error) };
    }
  });
  if (!injection?.ok) throw new Error(`content script injection failed: ${injection?.error}`);

  // The popup is driven through its own DOM so the click never moves focus off
  // the fixture, which would make the worker's tab resolver pick the popup.
  const popup = await context.newPage();
  await popup.goto(popupUrl, { waitUntil: "load" });
  // The worker purges staged files on chrome.runtime.onInstalled, which races the
  // first write in a fresh profile. Let it settle before shooting.
  await sleep(3000);

  const click = (sel) =>
    popup.$eval(sel, (el) => {
      if (!(el instanceof HTMLElement) || el.hasAttribute("disabled")) return false;
      el.click();
      return true;
    });

  /**
   * Close any modal still blocking pointer events. The one-time accuracy notice
   * ("please verify your work") raises after the first scan and is a real dialog
   * element, so a driver-level click on a tab underneath it times out.
   */
  const clearModals = async () => {
    const open = await popup.$$eval("dialog[open]", (ds) => ds.map((d) => d.id));
    for (const id of open) {
      const btn = await popup.$(`#${id} [id^="verify-"], #${id} [id$="-cancel"]`);
      if (btn) await btn.click().catch(() => undefined);
      await popup
        .$eval(`#${id}`, (d) => (d.open ? d.close() : undefined))
        .catch(() => undefined);
      await sleep(250);
    }
  };

  // 1. Landing surface: the extension idle, before any scan.
  await fixture.bringToFront();
  await sleep(250);
  await shoot(popup, "01-protection-idle", "Idle state before scanning: local mode, categories, threshold");

  // 2. Page scan -> findings with masked previews.
  if (!(await click("#scan-btn"))) throw new Error("#scan-btn missing or disabled");
  for (let i = 0; i < 120 && (await popup.evaluate(() => document.querySelectorAll("#findings-list .finding").length)) === 0; i++) {
    await sleep(500);
  }
  await sleep(900);
  const rows = await popup.evaluate(() => document.querySelectorAll("#findings-list .finding").length);
  if (rows === 0) throw new Error("no findings rendered; cannot build a findings screenshot");
  await shoot(popup, "02-findings-masked", `${rows} findings with masked previews, before any mask is applied`);

  // 3. Masks applied to the page itself.
  await click("#apply-masks-btn");
  await sleep(1500);
  await fixture.bringToFront();
  await sleep(800);
  // Masks render inside the content script's shadow root, so a light-DOM query
  // only ever sees the host element. Count through the shadow root.
  const overlay = await fixture.evaluate(() => {
    const host = document.querySelector("div[data-gw-scan-overlay]");
    return {
      host: Boolean(host),
      masks: host?.shadowRoot ? host.shadowRoot.querySelectorAll('[data-kind="mask"]').length : 0,
    };
  });
  if (!overlay.host) throw new Error("scan overlay host is absent from the page");
  if (overlay.masks === 0) throw new Error("no mask elements were rendered into the page");
  await shoot(fixture, "03-page-masks-applied", `${overlay.masks} overlay masks drawn on the page (source page unmodified)`);

  // 4. Document studio with detected regions on an image.
  //    doc-workspace lives inside #tab-protection, not #tab-review, so the file
  //    input has to be driven from that tab.
  await clearModals();
  await popup.bringToFront();
  await sleep(400);
  await popup.click("#tab-btn-protection");
  await sleep(600);

  // The worker purges staged files on chrome.runtime.onInstalled, which can race
  // the first write on a fresh profile. Retry once, as the UI walkthrough does.
  let opened = false;
  let status = "";
  for (let attempt = 1; attempt <= 2 && !opened; attempt++) {
    await popup.setInputFiles("#doc-file-input", join(fixtures, "photo-pii.png"));
    try {
      await popup.waitForSelector("#doc-workspace:not([hidden])", { timeout: 180_000 });
      opened = true;
    } catch {
      status = await popup.$eval("#doc-status", (el) => el.textContent ?? "").catch(() => "");
      console.log(`  attempt ${attempt}: studio did not open (status: "${status}")`);
      await sleep(2500);
    }
  }
  if (!opened) throw new Error(`document studio never opened; last status: "${status}"`);

  // Detection runs after the workspace opens, so wait for a non-zero count rather
  // than for the workspace alone: the element starts at "0".
  const docCount = await popup
    .waitForFunction(
      () => {
        const raw = (document.getElementById("doc-findings-count")?.textContent ?? "").trim();
        const n = Number.parseInt(raw, 10);
        return Number.isFinite(n) && n > 0 ? raw : false;
      },
      null,
      { timeout: 180_000 },
    )
    .then(() => popup.evaluate(() => document.getElementById("doc-findings-count")?.textContent?.trim() ?? ""))
    .catch(() => "");
  if (!docCount) throw new Error("document studio opened but detected no findings");
  await sleep(1500);
  // Bring the workspace itself into view. Resetting the panel's scrollTop to 0
  // puts the header back in frame and hides the document entirely.
  await popup.evaluate(() => {
    const w = document.getElementById("doc-workspace");
    w?.scrollIntoView({ block: "start" });
  });
  await sleep(600);
  await shoot(popup, "04-document-studio", `Document review: local OCR found ${docCount} on an image`);

  // 5. Settings / About: local-first architecture and dependency credits.
  await clearModals();
  await popup.click("#tab-btn-settings");
  await sleep(500);
  await popup.click('[data-settings-page="about"]');
  await sleep(800);
  await popup.evaluate(() => {
    const page = document.querySelector("#settings-page-about");
    if (page) page.scrollTop = 0;
  });
  await sleep(300);
  await shoot(popup, "05-settings-about", "Settings / About: local-first architecture and open-source credits");

  if (emitted.length > MAX_SHOTS) {
    throw new Error(`${emitted.length} screenshots emitted; the store accepts at most ${MAX_SHOTS}`);
  }
  if (emitted.length < 1) throw new Error("no screenshots produced");

  writeFileSync(
    join(OUT, "NOTES.md"),
    [
      "# Store screenshot notes",
      "",
      "Generated by `npm run capture:store`. Every image is verified to be",
      `exactly ${W}x${H} px, which is the Chrome Web Store requirement`,
      "(https://developer.chrome.com/docs/webstore/cws-dashboard-listing).",
      "",
      "All content is synthetic: it comes from `tests/fixtures/`, which uses RFC 2606",
      "`.test` domains, a never-issued SSN, and a documented test card. No real PII,",
      "no browser chrome, and no real user data appear in these images.",
      "",
      ...emitted.map((s, i) => `${i + 1}. **${s.name}.png** (${s.w}x${s.h}) — ${s.note}`),
      "",
    ].join("\n"),
  );

  console.log(`\nwrote ${emitted.length} screenshot(s) to ${OUT} (all ${W}x${H})`);
  console.log("NEXT: these are upload candidates only. Nothing was uploaded.");
} finally {
  await context.close().catch(() => {});
  server.close();
  rmSync(WORK, { recursive: true, force: true });
}
