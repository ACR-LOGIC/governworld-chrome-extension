// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
//
// End-to-end check of the Document Studio journey in a real browser:
// pick a file -> progress appears -> findings render -> the studio survives a
// popup reload -> redaction completes -> the file is actually downloaded -> the
// print view is offered.
//
// This path had no automated coverage, which is how v0.1.0 shipped with every
// status and error invisible, a spinner that never stopped, and a document that
// vanished when the popup closed. The photo E2E only exercises images, and the
// Playwright specs need a fixture server and are not part of CI.
//
// Requires a prior `npm run build`. Runs headed, so it needs a display.
import { chromium } from "playwright";
import { browserChannelArgs, browserProfileDir } from "./browser-launch.mjs";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ext = join(root, "dist");
const fixture = join(root, "tests", "fixtures", "sample.pdf");

if (!existsSync(ext)) {
  console.error("dist/ is missing - run `npm run build` first.");
  process.exit(1);
}
if (!existsSync(fixture)) {
  console.error(`fixture missing: ${fixture}`);
  process.exit(1);
}

const STAGE_TIMEOUT_MS = 90_000;
const b64 = readFileSync(fixture).toString("base64");
const work = mkdtempSync(join(tmpdir(), "gw-docflow-"));

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const context = await chromium.launchPersistentContext(browserProfileDir(join(work, "profile")), {
  headless: false,
  ...browserChannelArgs(),
  acceptDownloads: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--no-first-run"],
});

try {
  const worker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 20_000 }));
  const extId = new URL(worker.url()).host;
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`chrome-extension://${extId}/popup.html`);

  // initPopup awaits storage before it wires a single listener, so wait for it
  // to settle rather than racing it the way a fast automated click would.
  await page.waitForFunction(() => document.getElementById("doc-file-input") !== null, null, { timeout: 15_000 });
  await page.waitForTimeout(2_500);

  const ui = () =>
    page.evaluate(() => {
      const g = (id) => document.getElementById(id);
      const status = g("doc-status");
      const progress = g("doc-progress");
      return {
        studio: g("doc-workspace") ? !g("doc-workspace").hasAttribute("hidden") : false,
        file: (g("doc-filename")?.textContent || "").trim(),
        findings: (g("doc-findings-count")?.textContent || "").trim(),
        statusText: (g("doc-status-text")?.textContent || "").trim(),
        statusVisible: status ? !status.hasAttribute("hidden") : false,
        statusIsError: status ? status.classList.contains("status--error") : false,
        progressVisible: progress ? !progress.hasAttribute("hidden") : false,
        redactEnabled: g("doc-redact-btn") ? !g("doc-redact-btn").disabled : false,
        printBar: g("doc-print-bar") ? !g("doc-print-bar").hasAttribute("hidden") : false,
      };
    });

  console.log("\n1. Pick a document");
  // A real File plus a real `change` event, which is what the OS file dialog
  // produces. Playwright's setInputFiles intermittently fails to deliver the
  // event in this environment, so it is deliberately not used here.
  await page.evaluate(async (data) => {
    const input = document.getElementById("doc-file-input");
    const bin = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bin], "sample.pdf", { type: "application/pdf" }));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, b64);

  await page.waitForTimeout(1_200);
  const during = await ui();
  check(
    "progress is visible while processing",
    during.progressVisible,
    `progressVisible=${during.progressVisible}`
  );
  check(
    "status is visible while processing",
    during.statusVisible && during.statusText.length > 0,
    `"${during.statusText}"`
  );

  console.log("\n2. Findings render");
  const t0 = Date.now();
  await page.waitForFunction(
    () => {
      const w = document.getElementById("doc-workspace");
      return w && !w.hasAttribute("hidden");
    },
    null,
    { timeout: STAGE_TIMEOUT_MS }
  );
  const previewMs = Date.now() - t0;
  const previewed = await ui();
  check("document studio opened", previewed.studio, `in ${(previewMs / 1000).toFixed(1)}s`);
  check("a filename is shown", previewed.file === "sample.pdf", `"${previewed.file}"`);
  check("findings were detected", /\d+ detected/.test(previewed.findings), `"${previewed.findings}"`);
  check("redaction is available", previewed.redactEnabled);
  check(
    "the spinner stopped after finishing",
    !previewed.progressVisible,
    `progressVisible=${previewed.progressVisible}`
  );
  check(
    "no stale scanning message is left behind",
    !/scanning/i.test(previewed.statusText),
    `"${previewed.statusText}"`
  );

  console.log("\n3. The studio survives the popup being closed and reopened");
  await page.reload();
  await page.waitForTimeout(3_000);
  const restored = await ui();
  check("studio restored after reload", restored.studio);
  check("findings restored", /\d+ detected/.test(restored.findings), `"${restored.findings}"`);

  console.log("\n4. Redact and download");
  await page.click("#doc-redact-btn");
  await page.waitForTimeout(500);
  const dialogOpen = await page.evaluate(() => document.getElementById("doc-confirm-dialog")?.open ?? false);
  check("confirmation dialog opened", dialogOpen);
  if (dialogOpen) {
    await page.click("#doc-confirm");
    await page.waitForFunction(
      () => {
        const b = document.getElementById("doc-print-bar");
        const s = document.getElementById("doc-status");
        const isError = s && s.classList.contains("status--error");
        return (b && !b.hasAttribute("hidden")) || isError;
      },
      null,
      { timeout: STAGE_TIMEOUT_MS }
    );
  }
  const saved = await ui();
  check("the print view is offered", saved.printBar);
  check("a success message is shown", /saved/i.test(saved.statusText), `"${saved.statusText}"`);
  check("the message is not an error", !saved.statusIsError);
  check(
    "the spinner stopped after redaction",
    !saved.progressVisible,
    `progressVisible=${saved.progressVisible}`
  );

  const downloads = await worker.evaluate(async () => {
    const items = await chrome.downloads.search({ limit: 5, orderBy: ["-startTime"] });
    return items.map((d) => ({ state: d.state, error: d.error, exists: d.exists }));
  });
  // The download is requested with saveAs: true, so in an automated session
  // with nobody to answer the save dialog it can legitimately still be
  // in_progress. What must hold is that the download was created, has no
  // error, and has produced a file.
  const written = downloads.filter((d) => d.exists && !d.error && (d.state === "complete" || d.state === "in_progress"));
  check("a download was created and produced a file", written.length > 0, JSON.stringify(downloads));
  const interrupted = downloads.filter((d) => d.state === "interrupted");
  check("no download was interrupted", interrupted.length === 0, JSON.stringify(interrupted));

  check("no uncaught page errors", pageErrors.length === 0, JSON.stringify(pageErrors));
} finally {
  await context.close();
}

console.log(
  failures.length === 0
    ? "\nDocument Studio flow: all checks passed."
    : `\nDocument Studio flow: ${failures.length} check(s) failed: ${failures.join(", ")}`
);
process.exit(failures.length === 0 ? 0 : 1);
