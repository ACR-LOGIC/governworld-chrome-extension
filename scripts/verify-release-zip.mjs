// Load the actual release ZIP (not dist/) in a real browser and confirm it runs.
// Packaging bugs live in the gap between "dist/ works" and "the uploaded artifact
// works": a wrong zip root, a missing file, or a stale artifact all pass every
// other gate. This extracts the zip to a temp dir and loads that.
//
//   node scripts/verify-release-zip.mjs release/governworld-redaction-<sha>.zip
import { chromium } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const zipArg = process.argv[2];
if (!zipArg) {
  console.error("usage: node scripts/verify-release-zip.mjs <zip>");
  process.exit(1);
}
const zip = resolve(root, zipArg);
if (!existsSync(zip)) {
  console.error(`zip not found: ${zip}`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "gw-zip-"));
const fail = [];
const ok = (label, detail = "") => console.log(`  [ok] ${label}${detail ? ` ${detail}` : ""}`);

try {
  // Expand with .NET so this needs no extra npm dependency.
  execFileSync(
    "pwsh",
    [
      "-NoProfile",
      "-Command",
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${zip}','${work}')`,
    ],
    { stdio: "inherit" },
  );

  // The store rejects a zip with a wrapping directory: manifest.json must be at
  // the archive root.
  const manifestPath = join(work, "manifest.json");
  if (!existsSync(manifestPath)) {
    console.error("FAIL: manifest.json is not at the zip root (the zip has a wrapping folder)");
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  ok("manifest.json at zip root", `mv${manifest.manifest_version} v${manifest.version}`);

  // Every path the manifest resolves must exist in the archive.
  const referenced = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    manifest.side_panel?.default_path,
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
  ].filter(Boolean);
  for (const rel of referenced) {
    if (existsSync(join(work, rel))) ok(`referenced: ${rel}`);
    else fail.push(`manifest references ${rel} but it is absent from the zip`);
  }

  // The OCR pipeline must be self-contained: no network fetch at runtime.
  for (const asset of [
    "assets/pdf.worker.min.mjs",
    "assets/tesseract.worker.min.js",
    "assets/tesseract-core.wasm",
    "assets/tessdata/eng.traineddata.gz",
  ]) {
    if (existsSync(join(work, asset))) ok(`offline asset: ${asset}`);
    else fail.push(`offline asset missing from zip: ${asset}`);
  }

  // Both legal documents must ship and be linked from the popup.
  for (const page of ["privacy.html", "legal.html"]) {
    if (existsSync(join(work, page))) ok(`legal page packaged: ${page}`);
    else fail.push(`${page} missing from zip`);
  }
  const popupHtml = readFileSync(join(work, manifest.action.default_popup), "utf8");
  for (const id of ["privacy-link", "terms-link"]) {
    if (popupHtml.includes(`id="${id}"`)) ok(`popup links ${id}`);
    else fail.push(`popup has no ${id}; the legal page would be unreachable`);
  }

  if (fail.length) {
    console.error(`\nFAIL: ${fail.length} packaging problem(s):`);
    for (const f of fail) console.error(`  - ${f}`);
    process.exit(1);
  }

  // Load the extracted artifact in a real browser and open every page.
  const profile = join(work, "profile");
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${work}`,
      `--load-extension=${work}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 30_000 }));
  const id = new URL(worker.url()).host;
  console.log(`\n  extension id: ${id} (loaded from the extracted zip)`);

  const pages = ["popup.html", "sidepanel.html", "landing.html", "privacy.html", "legal.html"];
  const pageErrors = [];
  for (const name of pages) {
    const p = await context.newPage();
    p.on("pageerror", (e) => pageErrors.push(`${name}: ${e.message}`));
    p.on("console", (m) => {
      if (m.type() !== "error") return;
      const t = m.text();
      if (/favicon/i.test(t) || /404/.test(t)) return;
      pageErrors.push(`${name}: ${t}`);
    });
    await p.goto(`chrome-extension://${id}/${name}`, { waitUntil: "load" });
    await p.waitForTimeout(600);
    const csp = await p.evaluate(() => Boolean(document.querySelector("script:not([src])")));
    if (csp) fail.push(`${name} contains an inline script`);
    else ok(`page loads CSP-clean: ${name}`);
    await p.close();
  }

  // The service worker must answer a real message from the artifact.
  const alive = await worker.evaluate(async () => {
    try {
      const r = await chrome.runtime.getManifest();
      return { ok: true, name: r.name, version: r.version };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
  if (alive.ok) ok("service worker alive", `${alive.name} v${alive.version}`);
  else fail.push(`service worker: ${alive.error}`);

  await context.close();

  if (pageErrors.length) {
    console.error(`\nFAIL: page errors from the packaged extension:`);
    for (const e of pageErrors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log(`\nRelease zip verified: ${zipArg}`);
  console.log(`  ${referenced.length} manifest references, offline assets, both legal pages,`);
  console.log(`  and all ${pages.length} pages load from the extracted artifact.`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
