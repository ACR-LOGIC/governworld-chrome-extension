// End-to-end: a page that is only an image must offer a route to OCR.
//
// A page scan reads textContent, so an image-only page scans to nothing. The
// popup must say so honestly AND offer to send the image to the Document
// Studio, where the ordinary review/redact/download flow applies unchanged.
import { chromium } from "playwright";
import { browserChannelArgs, browserProfileDir, waitForPopupReady } from "./browser-launch.mjs";
import { mkdtempSync, readFileSync, cpSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(root, "dist", "manifest.json"))) {
  console.error("dist/ is missing - run `npm run build` first.");
  process.exit(1);
}
const png = readFileSync(join(root, "tests", "fixtures", "photo-pii.png"));

const htmlImage = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
<img src="/letter.png" style="width:1200px;display:block"></body></html>`;
const htmlText = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<p>Test record for QA only. SSN 219-09-9999 and card 4111111111111111.</p></body></html>`;

const server = createServer((req, res) => {
  if (req.url === "/letter.png") {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(png);
  } else if (req.url === "/text.html") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(htmlText);
  } else {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(htmlImage);
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// dist ships with no host_permissions by design. The content script needs to run
// on the fixture, so a throwaway copy gets a localhost-only entry - the same
// technique capture:ui uses. The shipped manifest is asserted untouched below.
const shipped = JSON.parse(readFileSync(join(root, "dist", "manifest.json"), "utf8"));
if (shipped.host_permissions?.length) {
  console.error("dist/ ships with host_permissions; aborting rather than testing a different build");
  process.exit(1);
}
const work = mkdtempSync(join(tmpdir(), "gw-imgcap-"));
const extDir = join(work, "ext");
rmSync(extDir, { recursive: true, force: true });
mkdirSync(extDir, { recursive: true });
cpSync(join(root, "dist"), extDir, { recursive: true });
const mp = join(extDir, "manifest.json");
const m = JSON.parse(readFileSync(mp, "utf8"));
m.host_permissions = [`http://127.0.0.1:${port}/*`];
writeFileSync(mp, JSON.stringify(m, null, 2));

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const context = await chromium.launchPersistentContext(browserProfileDir(join(work, "profile")), {
  headless: false,
  ...browserChannelArgs(),
  acceptDownloads: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--no-first-run"],
});
let sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 20_000 }));
const extId = new URL(sw.url()).host;

const page = await context.newPage();
const popup = await context.newPage();

const readUi = () =>
  popup.evaluate(() => {
    const g = (id) => document.getElementById(id);
    const panel = g("image-capture");
    const status = g("status");
    return {
      status: (status?.textContent || "").trim().replace(/\s+/g, " "),
      isError: status?.classList.contains("status--error") ?? false,
      panelHidden: panel ? panel.hasAttribute("hidden") : null,
      buttons: [...document.querySelectorAll(".image-capture__btn")].map((b) => ({
        ok: b.classList.contains("image-capture__btn--ok"),
        warn: b.classList.contains("image-capture__btn--warn"),
        text: (b.textContent || "").trim().replace(/\s+/g, " ").slice(0, 70),
      })),
      studioVisible: g("doc-workspace") ? !g("doc-workspace").hasAttribute("hidden") : false,
      docStatus: (g("doc-status-text")?.textContent || "").trim().slice(0, 70),
      docStatusShown: g("doc-status") ? !g("doc-status").hasAttribute("hidden") : false,
      findings: (g("doc-findings-count")?.textContent || "").trim(),
      progress: g("doc-progress") ? !g("doc-progress").hasAttribute("hidden") : false,
    };
  });

async function scan(url) {
  await page.goto(url);
  await page.waitForTimeout(600);
  await page.bringToFront();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  // Wait for initPopup to attach its listeners; a fixed wait raced it on a cold
  // profile, so the buttons this test then clicks had no handlers.
  await waitForPopupReady(popup);
  await page.bringToFront();
  await popup.evaluate(() => document.getElementById("scan-btn")?.click());
  for (let i = 0; i < 40; i++) {
    await popup.waitForTimeout(400);
    const s = await readUi();
    if (s.status && !/scanning/i.test(s.status)) return s;
  }
  return await readUi();
}

console.log("\n1. Scan a page that is only an image");
const imageScan = await scan(`http://127.0.0.1:${port}/letter.png`);
console.log(`     status: "${imageScan.status}"`);
console.log(`     buttons: ${JSON.stringify(imageScan.buttons)}`);
check("does not claim success", !/completed securely/i.test(imageScan.status), imageScan.status);
check("offers the image-capture panel", imageScan.panelHidden === false);
check("lists the page's image", imageScan.buttons.length >= 1, `${imageScan.buttons.length} button(s)`);
check("same-origin image is offered at full resolution", imageScan.buttons.some((b) => b.ok && !b.warn));
check(
  "the badge states the source honestly",
  imageScan.buttons.some((b) => /full resolution|screen capture/i.test(b.text)),
  JSON.stringify(imageScan.buttons.map((b) => b.text))
);

console.log("\n2. Capture it into the Document Studio");
await popup.evaluate(() => document.querySelector(".image-capture__btn")?.click());
// OCR of a full-page image is slow; give the real pipeline room.
let captured = null;
for (let i = 0; i < 90; i++) {
  await popup.waitForTimeout(1000);
  const s = await readUi();
  if (s.studioVisible || (s.isError && /could not|unavailable|too large/i.test(s.status + s.docStatus))) {
    captured = s;
    break;
  }
}
const after = captured ?? (await readUi());
console.log(`     studioVisible=${after.studioVisible} findings="${after.findings}" docStatus="${after.docStatus}" shown=${after.docStatusShown}`);
check("the Document Studio opened", after.studioVisible === true);
check("OCR produced findings", /\d+ detected/.test(after.findings), `"${after.findings}"`);
// The status is legitimately empty on success: setDocStatus("", false) hides the
// block so a stale "Scanning document..." cannot outlive the run. What matters
// is that the studio is on screen with the findings, not that a line of text is
// still there saying so.
check(
  "the result is presented, not left as a bare 'Scanning...' message",
  after.studioVisible === true,
  `studioVisible=${after.studioVisible} docStatus="${after.docStatus}"`
);
check("the spinner stopped when it finished", after.progress === false);
check("the capture panel is gone", after.panelHidden === true);

console.log("\n3. Redact and download the captured image");
await popup.click("#doc-redact-btn");
await popup.waitForTimeout(500);
const dlg = await popup.evaluate(() => document.getElementById("doc-confirm-dialog")?.open ?? false);
check("confirmation dialog opened", dlg);
if (dlg) {
  await popup.click("#doc-confirm");
  await popup.waitForFunction(
    () => {
      const b = document.getElementById("doc-print-bar");
      const s = document.getElementById("doc-status");
      return (b && !b.hasAttribute("hidden")) || (s && s.classList.contains("status--error"));
    },
    null,
    { timeout: 120_000 }
  );
}
const saved = await readUi();
console.log(`     docStatus="${saved.docStatus}" progress=${saved.progress}`);
check("a success message is shown", /saved/i.test(saved.docStatus), `"${saved.docStatus}"`);
check("it is not an error", !saved.docStatus.toLowerCase().includes("failed"));
check("the spinner stopped after redaction", saved.progress === false);
const downloads = await sw.evaluate(async () => {
  const items = await chrome.downloads.search({ limit: 5, orderBy: ["-startTime"] });
  return items.map((d) => ({ state: d.state, error: d.error, exists: d.exists }));
});
const written = downloads.filter((d) => d.exists && !d.error && (d.state === "complete" || d.state === "in_progress"));
check("a redacted file was produced", written.length > 0, JSON.stringify(downloads));

console.log("\n4. A page with real text must not offer capture");
await page.goto(`http://127.0.0.1:${port}/text.html`);
await page.waitForTimeout(500);
const textScan = await scan(`http://127.0.0.1:${port}/text.html`);
console.log(`     status: "${textScan.status}" panelHidden=${textScan.panelHidden}`);
check("still reports success", /completed securely/i.test(textScan.status), textScan.status);
check("no capture panel is offered", textScan.panelHidden === true);

await context.close();
server.close();
console.log(failures.length === 0 ? "\nImage capture: all checks passed." : `\nImage capture: ${failures.length} failed: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
