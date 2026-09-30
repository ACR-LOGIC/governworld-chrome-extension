// End-to-end proof of the print/PDF stage.
//
// Drives the real flow in a real browser: stage a document through the offscreen
// redaction pipeline, then open redact.html against the stored manifest and
// check that the pages it renders are the pixel-verified redacted ones.
//
// This is deliberately not a unit test. The things that broke during the
// tesseract v7 upgrade — an output shape that returns zero tokens, a print
// handle that never gets written, a store key that does not resolve — all
// compiled cleanly and passed every unit test.
//
//   node scripts/verify-print-pipeline.mjs

import { chromium } from "@playwright/test";
import { browserChannelArgs, browserProfileDir } from "./browser-launch.mjs";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(".");
const dist = join(root, "dist");
const fixtures = join(root, "tests", "fixtures");
const work = mkdtempSync(join(tmpdir(), "gw-print-"));
const ext = join(work, "ext");
const PORT = 8083;
const ORIGIN = `http://localhost:${PORT}`;

if (!existsSync(join(dist, "manifest.json"))) {
  console.error("dist/manifest.json missing - run `npm run build` first.");
  process.exit(1);
}

const fail = [];
const ok = (label, detail = "") => console.log(`  [ok] ${label}${detail ? ` ${detail}` : ""}`);

cpSync(dist, ext, { recursive: true });
const manifestPath = join(ext, "manifest.json");
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
const downloads = join(work, "downloads");
mkdirSync(downloads, { recursive: true });

const context = await chromium.launchPersistentContext(browserProfileDir(join(work, "profile")), {
  headless: false,
  ...browserChannelArgs(),
  viewport: { width: 1280, height: 900 },
  acceptDownloads: true,
  args: [
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
    "--no-first-run",
    "--no-default-browser-check",
  ],
});

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 30_000 }));
  const id = new URL(worker.url()).host;
  ok("extension loaded", id);

  const policyPage = await context.newPage();
  const cdp = await context.newCDPSession(policyPage);
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true });

  const pageErrors = [];
  const popup = await context.newPage();
  popup.on("pageerror", (e) => pageErrors.push(`popup: ${e.message}`));
  await popup.goto(`chrome-extension://${id}/popup.html`, { waitUntil: "load" });
  await popup.waitForTimeout(3000);

  // --- stage the real fixture through the pipeline -------------------------
  await popup.click("#tab-btn-protection");
  await popup.waitForTimeout(300);
  await popup.setInputFiles("#doc-file-input", join(fixtures, "photo-pii.png"));

  await popup.waitForFunction(
    () => Number.parseInt(document.getElementById("doc-findings-count")?.textContent ?? "", 10) > 0,
    null,
    { timeout: 240_000 },
  );
  const findings = await popup.evaluate(() => document.getElementById("doc-findings-count")?.textContent?.trim());
  ok("document staged and OCR'd", `${findings} findings`);

  // Redact through the confirm dialog, exactly as a user would.
  await popup.click("#doc-redact-btn");
  await popup.waitForTimeout(500);
  await popup.click("#doc-confirm");

  await popup.waitForSelector("#doc-print-bar:not([hidden])", { timeout: 240_000 });
  ok("print bar revealed after redaction");

  const printFileKey = await worker.evaluate(async () => {
    // Read what the popup was told, via the store, the same source the page uses.
    const all = await chrome.storage.local.get(null);
    return typeof all.__lastPrintKey === "string" ? all.__lastPrintKey : null;
  });
  // The key lives in the popup's message payload; read it from the DOM handler's
  // effect instead by asking the store for every redacted manifest.
  const manifests = await popup.evaluate(async () => {
    const req = indexedDB.open("governworld-redaction", 1);
    const db = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const keys = await new Promise((res, rej) => {
      const tx = db.transaction("docfiles", "readonly");
      const rq = tx.objectStore("docfiles").getAllKeys();
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    return keys.filter((k) => typeof k === "string" && k.endsWith("::redacted-manifest"));
  });
  ok("redacted manifest staged in the store", manifests.join(", "));
  if (manifests.length === 0) fail.push("no redacted manifest was written to the shared store");

  const manifestKey = manifests[0];
  const fileKey = manifestKey.replace("::redacted-manifest", "");

  // --- open the print view the way the worker does -------------------------
  const printTab = await context.newPage();
  printTab.on("pageerror", (e) => pageErrors.push(`redact.html: ${e.message}`));
  await printTab.goto(`chrome-extension://${id}/redact.html?key=${encodeURIComponent(fileKey)}`, {
    waitUntil: "load",
  });

  await printTab.waitForFunction(
    () => document.querySelectorAll("#sheets .sheet img").length > 0,
    null,
    { timeout: 60_000 },
  );
  const view = await printTab.evaluate(() => {
    const sheets = [...document.querySelectorAll("#sheets .sheet")];
    return {
      sheets: sheets.length,
      images: document.querySelectorAll("#sheets img").length,
      allDecoded: [...document.querySelectorAll("#sheets img")].every((i) => i.complete && i.naturalWidth > 0),
      title: document.getElementById("print-title")?.textContent ?? "",
      count: document.getElementById("print-count")?.textContent ?? "",
      status: document.getElementById("print-status")?.textContent ?? "",
      printEnabled: document.getElementById("print-btn")?.disabled === false,
      pdfEnabled: document.getElementById("pdf-btn")?.disabled === false,
      sheetSizes: sheets.map((s) => `${Math.round(s.getBoundingClientRect().width)}x${Math.round(s.getBoundingClientRect().height)}`),
      sheetMm: sheets.map((s) => `${s.style.width}/${s.style.height}`),
      sheetAspect: sheets.map((s) => {
        const r = s.getBoundingClientRect();
        return r.height === 0 ? 0 : r.width / r.height;
      }),
    };
  });
  ok("print view rendered", JSON.stringify(view));

  if (view.sheets < 1) fail.push("print view rendered no sheets");
  if (!view.allDecoded) fail.push("not every page image finished decoding");
  if (!view.printEnabled) fail.push("print button stayed disabled after render");
  if (!view.pdfEnabled) fail.push("save-as-PDF button stayed disabled after render");
  if (/no longer available|malformed|could not/i.test(view.status)) fail.push(`print view reported: ${view.status}`);

  // Every sheet must carry a real physical size, and that size must match the
  // source page's aspect ratio. A zero or missing size is what made image
  // documents unusable here, and an aspect mismatch would silently distort the
  // printed page.
  for (const mm of view.sheetMm ?? []) {
    if (!/^\d+(\.\d+)?mm\/\d+(\.\d+)?mm$/.test(mm)) fail.push(`sheet has no physical size: ${mm}`);
  }
  for (const a of view.sheetAspect ?? []) {
    if (!Number.isFinite(a) || a <= 0) fail.push(`sheet has a degenerate aspect ratio: ${a}`);
    else if (Math.abs(a - 1240 / 1754) > 0.02) {
      fail.push(`sheet aspect ${a.toFixed(3)} does not match the source page (${(1240 / 1754).toFixed(3)})`);
    }
  }
  if (view.sheetMm?.length) ok("sheets sized to the source page", view.sheetMm.join(" "));

  // The pages shown must be the redacted ones, not the source: sample the sheet
  // pixels and require the redaction boxes to be dark.
  const sample = await printTab.evaluate(async () => {
    const img = document.querySelector("#sheets img");
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722 < 40) dark++;
    }
    return { w: c.width, h: c.height, darkFraction: dark / (d.length / 4) };
  });
  console.log(`  page pixels: ${JSON.stringify(sample)}`);
  if (sample.darkFraction < 0.005) {
    fail.push("the printed page has no dark redaction pixels; it looks like the unredacted source");
  } else {
    ok("printed page contains redaction pixels", `${(sample.darkFraction * 100).toFixed(2)}% dark`);
  }

  // window.print() must exist and must be reachable; do not actually print.
  const hasPrint = await printTab.evaluate(() => typeof window.print === "function");
  if (!hasPrint) fail.push("window.print is unavailable in the extension page");

  // A missing key must fail closed rather than rendering something.
  const badTab = await context.newPage();
  badTab.on("pageerror", (e) => pageErrors.push(`redact.html(bad key): ${e.message}`));
  await badTab.goto(`chrome-extension://${id}/redact.html`, { waitUntil: "load" });
  await badTab.waitForTimeout(1200);
  const bad = await badTab.evaluate(() => ({
    sheets: document.querySelectorAll("#sheets .sheet").length,
    printDisabled: document.getElementById("print-btn")?.disabled === true,
    note: document.getElementById("print-note")?.textContent ?? "",
  }));
  if (bad.sheets !== 0) fail.push("redact.html rendered sheets with no document key");
  if (!bad.printDisabled) fail.push("print stayed enabled with no document");
  ok("fails closed without a document", bad.note.slice(0, 60));

  if (pageErrors.length) {
    for (const e of pageErrors) fail.push(`page error: ${e}`);
  }

  if (fail.length) {
    console.error(`\nPRINT PIPELINE FAILED (${fail.length}):`);
    for (const f of fail) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\nPrint pipeline verified: stage -> store -> redact.html -> print.");
  void printFileKey;
} finally {
  await context.close().catch(() => {});
  server.close();
  rmSync(work, { recursive: true, force: true });
}
