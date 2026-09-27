// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Captures the six Chrome Web Store listing screenshots from a local synthetic
// fixture page, with the built extension loaded as an unpacked extension.
// Uses a screenshot-only manifest variant that adds a localhost host permission
// so automation can inject the content script WITHOUT a real activeTab user
// gesture. That variant is generated in a temp dir and never shipped; the
// shipped manifest (dist/manifest.json from `npm run build`) stays
// least-privilege. All fixtures are synthetic.
//
// Run from apps/redaction-extension (after `npm run build`):
//   node scripts/capture-screenshots.mjs
import { createServer } from "node:http";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(root, "..");
const distDir = join(pkgRoot, "dist");
const fixtureDir = join(root, "fixtures");
const outDir = join(pkgRoot, "release", "screenshots");
const PORT = 8123;

function copyTree(src, dst) {
  for (const f of readdirSync(src)) {
    const s = join(src, f);
    const d = join(dst, f);
    if (statSync(s).isDirectory()) {
      mkdirSync(d, { recursive: true });
      copyTree(s, d);
    } else {
      copyFileSync(s, d);
    }
  }
}

function extensionIdFromPublicKeyDer(der) {
  // Chrome encodes the first 16 bytes of SHA-256(public key DER) as 32 chars
  // from the a-p alphabet (one char per nibble; a-p only, NOT hex).
  return Array.from(createHash("sha256").update(der).digest().subarray(0, 16))
    .map((b) => String.fromCharCode(97 + (b >> 4), 97 + (b & 0x0f)))
    .join("");
}

if (!statSync(join(distDir, "manifest.json"), { throwIfNoEntry: false })) {
  throw new Error("Missing dist/. Run `npm run build` first.");
}

// --- Screenshot-only build: dist + localhost host permission + stable key ---
// The key gives the unpacked extension a deterministic ID so automation can
// open its pages without an activeTab gesture. This variant is temp-only and
// never shipped; the shipped manifest stays least-privilege.
const { publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "der" },
});
const extId = extensionIdFromPublicKeyDer(publicKey);
const shotBuild = join(tmpdir(), `gw-shot-${Date.now()}`);
rmSync(shotBuild, { recursive: true, force: true });
mkdirSync(shotBuild, { recursive: true });
copyTree(distDir, shotBuild);
const shotManifest = JSON.parse(readFileSync(join(shotBuild, "manifest.json"), "utf8"));
shotManifest.host_permissions = [`http://localhost:${PORT}/*`, `http://127.0.0.1:${PORT}/*`];
shotManifest.key = publicKey.toString("base64");
writeFileSync(join(shotBuild, "manifest.json"), JSON.stringify(shotManifest, null, 2));

// --- Static fixture server ---
const server = createServer((req, res) => {
  const name = req.url === "/" ? "screenshot-page.html" : req.url.slice(1);
  const file = join(fixtureDir, name);
  try {
    const data = readFileSync(file);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const extPath = shotBuild.replace(/\\/g, "/");
// Headed mode required: Playwright's headless shell does not support
// extensions; the full Chromium build with --load-extension needs a window.
const context = await chromium.launchPersistentContext("", {
  headless: false,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
});

// Watch every page target (including the offscreen document) so offscreen
// console errors and crashes are visible in the run output.
context.on("page", (p) => {
  const url = p.url();
  console.log(`DIAG new page: ${url}`);
  p.on("console", (m) => console.log(`DIAG console [${url}] [${m.type()}] ${m.text()}`));
  p.on("pageerror", (e) => console.log(`DIAG pageerror [${url}] ${e.message}`));
});

// Browser-level CDP target discovery: offscreen documents are "other" targets,
// not pages, so the page listener above may not see them.
const browser = context.browser();
if (browser) {
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  cdp.on("Target.targetCreated", (e) => {
    const { type, url } = e.targetInfo;
    if (type === "other" || url.startsWith("chrome-extension:")) {
      console.log(`DIAG cdp target created: type=${type} url=${url}`);
    }
  });
  cdp.on("Target.targetInfoChanged", async (e) => {
    const { targetId, type, url } = e.targetInfo;
    if (type === "other" || url.startsWith("chrome-extension:")) {
      console.log(`DIAG cdp target changed: type=${type} url=${url}`);
    }
    // Attach to offscreen/background_page targets to capture their console
    if (type === "background_page" || (type === "other" && url.startsWith("chrome-extension://"))) {
      console.log(`DIAG attaching to offscreen target: ${targetId} ${url}`);
      try {
        const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: false });
        // Use Target.sendMessageToTarget to enable Runtime (per probe script: flattened sessions don't work)
        await cdp.send("Target.sendMessageToTarget", {
          sessionId,
          message: JSON.stringify({ id: 1, method: "Runtime.enable" })
        });
        // Listen for console events from the offscreen target via the browser CDP session
        cdp.on("Target.receivedMessageFromTarget", (msg) => {
          if (msg.sessionId === sessionId) {
            const data = JSON.parse(msg.message);
            if (data.method === "Runtime.consoleAPICalled") {
              const args = data.params?.args?.map(a => a.value ?? a.description ?? JSON.stringify(a)).join(" ") ?? "";
              console.log(`DIAG offscreen console [${data.params?.type}] ${args}`);
            }
          }
        });
      } catch (err) {
        console.log(`DIAG failed to attach to offscreen: ${err.message}`);
      }
    }
  });
}

try {
  const extBase = `chrome-extension://${extId}/`;
  console.log(`Extension ID (deterministic): ${extId}`);

  // Fixture page is the focused/active tab (so POPUP_SCAN targets it).
  const page = await context.newPage();
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle" });
  await page.bringToFront();

  // 2. Clean fixture page (before scanning).
  await page.screenshot({ path: join(outDir, "01-page-before-scan.png") });

  // Popup opened as an extension tab (background, so the fixture stays active).
  // Opening it wakes the MV3 service worker via POPUP_GET_STATE.
  const popup = await context.newPage();
  await popup.goto(`${extBase}popup.html`, { waitUntil: "load" });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 });
  const swUrl = sw.url();
  console.log(`Service worker: ${swUrl}`);
  if (new URL(swUrl).hostname !== extId) {
    throw new Error(`Service worker host ${new URL(swUrl).hostname} != expected ${extId}`);
  }

  // 1. Popup initial state: disclosure, mode picker (Local only), scan button.
  await popup.waitForSelector("#scan-btn", { state: "visible" });
  await popup.waitForTimeout(200);
  await popup.screenshot({ path: join(outDir, "02-popup-initial.png") });

  // Opening the popup tab focused it; put the fixture back in focus so
  // POPUP_SCAN targets it, then drive the scan from the background popup tab.
  await page.bringToFront();
  await sw.evaluate(() => {
    globalThis.__log = [];
    chrome.runtime.onMessage.addListener((m) => globalThis.__log.push(`recv ${JSON.stringify(m)}`));
    chrome.runtime.onMessageExternal?.addListener?.((m) => globalThis.__log.push(`ext ${JSON.stringify(m)}`));
  });
  const activeInfo = await sw.evaluate(() =>
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs) => tabs.map((t) => ({ id: t.id, url: t.url, title: t.title })))
  );
  console.log("DIAG active tab:", JSON.stringify(activeInfo));
  const injectTest = await sw.evaluate((tabId) =>
    chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] })
      .then(() => "inject ok")
      .catch((e) => `inject ERR: ${String(e)}`),
    activeInfo[0]?.id
  );
  console.log("DIAG inject:", injectTest);
  const tabsMsgTest = await sw.evaluate((tabId) =>
    chrome.tabs.sendMessage(tabId, { type: "PING", requestId: "diag", sessionId: "diag", settings: { enabledCategories: [], maxVisibleChars: 0, maxNodeChars: 0 } })
      .then(() => "ping ok")
      .catch((e) => `ping ERR: ${String(e)}`),
    activeInfo[0]?.id
  );
  console.log("DIAG ping:", tabsMsgTest);
  const tabId = activeInfo[0].id;
  const scanMsg = {
    type: "SCAN_PAGE",
    requestId: "shot-scan",
    mode: "local",
    sessionId: "shot-session",
    settings: {
      enabledCategories: ["email", "phone", "ssn", "dob", "medical_record_number", "member_id", "address", "payment_card", "possible_name"],
      maxVisibleChars: 250000,
      maxNodeChars: 10000,
    },
  };
  const scanResult = await sw.evaluate(
    ({ t, m }) =>
      chrome.tabs.sendMessage(t, m).then(() => "scan sent").catch((e) => `scan ERR: ${String(e)}`),
    { t: tabId, m: scanMsg }
  );
  console.log("DIAG scan drive:", scanResult);

  const popupConsole = [];
  popup.on("console", (m) => popupConsole.push(`[${m.type()}] ${m.text()}`));
  const pageConsole = [];
  page.on("console", (m) => pageConsole.push(`[${m.type()}] ${m.text()}`));

  // 3. Findings list with masked previews.
  await popup.waitForSelector("#results-section:not([hidden])", { timeout: 20000 });
  await popup.waitForTimeout(400);
  const statusText = await popup.locator("#status").textContent().catch(() => "(no #status)");
  const resultsHidden = await popup.locator("#results-section").getAttribute("hidden").catch(() => null);
  const modeBadge = await popup.locator("#mode-badge").textContent().catch(() => "(none)");
  const summaryChars = await popup.locator("#summary-chars").textContent().catch(() => "(none)");
  const resultsCount = await popup.locator("#results-count").textContent().catch(() => "(none)");
  const applyLabel = await popup.locator("#apply-masks-btn").textContent().catch(() => "(none)");
  const findingCount = await popup.locator("#findings-list .finding").count().catch(() => -1);
  const firstCategory = await popup.locator("#findings-list .finding__category").first().textContent().catch(() => "(none)");
  const firstSeverity = await popup.locator("#findings-list .finding__severity").first().getAttribute("data-level").catch(() => "(none)");
  console.log("DIAG popup status:", JSON.stringify(statusText));
  console.log("DIAG results hidden:", resultsHidden, "mode:", modeBadge);
  console.log("DIAG summary chars:", JSON.stringify(summaryChars));
  console.log("DIAG results count:", JSON.stringify(resultsCount), "findings:", findingCount);
  console.log("DIAG apply label:", JSON.stringify(applyLabel));
  console.log("DIAG first finding:", JSON.stringify(firstCategory), "severity:", firstSeverity);
  console.log("DIAG popup console:", popupConsole.slice(-5).join("\n  ") || "(none)");
  await popup.screenshot({ path: join(outDir, "03-findings-masked.png") });

  // Apply masks deterministically; overlay renders on the fixture page.
  const selectedIds = await popup.evaluate(() =>
    [...document.querySelectorAll("#findings-list input[type='checkbox']:checked")].map((c) => c.value)
  );
  await sw.evaluate(
    ({ t, m }) =>
      chrome.tabs.sendMessage(t, m).then(() => "apply sent").catch((e) => `apply ERR: ${String(e)}`),
    { t: tabId, m: { type: "APPLY_MASKS", requestId: "shot-apply", sessionId: "shot-session", findingIds: selectedIds } }
  );
  await page.bringToFront();
  await page.waitForTimeout(600);

  // 4. Page with overlay masks applied.
  await page.screenshot({ path: join(outDir, "04-masks-applied.png") });

  // Document review flow on the synthetic PDF (offscreen OCR is local).
  const swLog = () =>
    sw.evaluate(() => (globalThis.__log ?? []).join("\n  ")).catch(() => "(sw unavailable)");
  await popup.bringToFront();
  await popup.waitForTimeout(200);
  const docFile = popup.locator("#doc-file");
  await docFile.setInputFiles(join(pkgRoot, "tests", "fixtures", "sample.pdf"));
  const docReady = await Promise.race([
    popup.waitForSelector("#doc-review:not([hidden])", { state: "visible", timeout: 120000 }).then(() => "review").catch(() => "no-review"),
    popup.waitForSelector("#doc-status.status--error", { state: "visible", timeout: 120000 }).then(() => "error").catch(() => "no-error"),
    popup.waitForTimeout(120000).then(() => "timeout"),
  ]);
  const docStatus = await popup.locator("#doc-status").textContent().catch(() => "(no #doc-status)");
  const docReviewHidden = await popup.locator("#doc-review").getAttribute("hidden").catch(() => null);
  console.log("DIAG doc state:", docReady, "status:", JSON.stringify(docStatus), "review hidden:", docReviewHidden);
  if (docReady !== "review") {
    console.log("DIAG popup console:\n  " + (popupConsole.join("\n  ") || "(none)"));
    console.log("DIAG sw log:\n  " + (await swLog()));
    const hasDoc = await sw
      .evaluate(() => chrome.offscreen.hasDocument().catch((e) => `err: ${String(e)}`))
      .catch(() => "(sw unavailable)");
    console.log("DIAG offscreen hasDocument:", hasDoc);
    throw new Error(`Document preview did not complete (${docReady}); see diagnostics above.`);
  }
  // The redact button only enables once at least one review finding is
  // selected, so check the first doc finding before waiting for it.
  const docFindings = popup.locator("#doc-findings input[type='checkbox']");
  await docFindings.first().waitFor({ state: "visible", timeout: 30000 });
  console.log("DIAG doc finding count:", await docFindings.count());
  await docFindings.first().check();
  await popup.waitForFunction(
    () => !document.getElementById("doc-redact-btn").disabled,
    undefined,
    { timeout: 60000 }
  );
  await popup.waitForTimeout(400);

  // 5. Document review: detected boxes + redact button.
  await popup.screenshot({ path: join(outDir, "05-document-review.png") });

  // 6. Download confirmation dialog.
  await popup.click("#doc-redact-btn");
  await popup.waitForSelector("#doc-confirm-dialog[open]", { timeout: 10000 });
  await popup.waitForTimeout(200);
  await popup.screenshot({ path: join(outDir, "06-download-confirm.png") });
  await popup.click("#doc-cancel");

  console.log(`Screenshots written to ${outDir}`);
} finally {
  await context.close();
  await new Promise((r) => server.close(r));
  rmSync(shotBuild, { recursive: true, force: true });
}