// Proves the full-screen review surface actually works: the document is shown at
// natural size, a drawn box is accepted, style changes repaint it, select/clear
// work, and a redaction produced through the page writes a file.
//
// The popup studio is 360px wide, so this is the only place drawing can be
// verified at all: at popup scale a box lands on pixels nobody can read.
import { chromium } from "playwright";
import { browserChannelArgs, browserProfileDir, stageFileInPopup } from "./browser-launch.mjs";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(root, "dist", "review.html"))) {
  console.error("dist/ is missing - run `npm run build` first.");
  process.exit(1);
}
const png = readFileSync(join(root, "tests", "fixtures", "photo-pii.png"));

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const work = mkdtempSync(join(tmpdir(), "gw-review-"));
const context = await chromium.launchPersistentContext(browserProfileDir(join(work, "profile")), {
  headless: false,
  ...browserChannelArgs(),
  acceptDownloads: true,
  args: [`--disable-extensions-except=${join(root, "dist")}`, `--load-extension=${join(root, "dist")}`, "--no-first-run"],
});
let sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 20_000 }));
const extId = new URL(sw.url()).host;

const popup = await context.newPage();
await popup.goto(`chrome-extension://${extId}/popup.html`);

// Stage a real image through the ordinary upload path, exactly as a user does.
// This waits for the popup to be interactive first: initPopup attaches its
// listeners ~3.6s after load, and dispatching before then stages nothing while
// still reporting a product failure.
await stageFileInPopup(popup, png, "letter.png", "image/png");

console.log("\n1. Preview the image in the studio");
let ready = false;
for (let i = 0; i < 90; i++) {
  await popup.waitForTimeout(1000);
  const visible = await popup.evaluate(() => {
    const w = document.getElementById("doc-workspace");
    return w ? !w.hasAttribute("hidden") : false;
  });
  if (visible) { ready = true; console.log(`   studio ready after ~${i + 1}s`); break; }
}
check("the studio previewed the image", ready);
if (!ready) {
  await context.close();
  process.exit(1);
}

console.log("\n2. Open the full-screen review page");
const reviewPromise = context.waitForEvent("page", { timeout: 20_000 });
await popup.evaluate(() => document.getElementById("doc-open-review-btn")?.click());
const review = await reviewPromise.catch(() => null);
check("a review tab opened", review !== null);
if (!review) {
  await context.close();
  process.exit(1);
}
await review.waitForLoadState("domcontentloaded");
await review.waitForTimeout(2500);

const ui = () =>
  review.evaluate(() => {
    const g = (id) => document.getElementById(id);
    const overlay = document.querySelector(".review__overlay");
    const img = document.querySelector(".review__pageimg");
    const ov = overlay?.getBoundingClientRect();
    const im = img?.getBoundingClientRect();
    return {
      name: (g("doc-name")?.textContent || "").trim(),
      findings: Number((g("findings-count")?.textContent || "0").trim()) || 0,
      findingRows: document.querySelectorAll("#findings li").length,
      overlay: ov ? { w: Math.round(ov.width), h: Math.round(ov.height) } : null,
      overlayBacking: overlay ? { w: overlay.width, h: overlay.height } : null,
      image: im ? { w: Math.round(im.width), h: Math.round(im.height) } : null,
      noticeShown: g("source-notice") ? !g("source-notice").hasAttribute("hidden") : false,
      actionStatus: (g("action-status")?.textContent || "").trim(),
      redactDisabled: g("redact")?.disabled ?? true,
    };
  });

const s = await ui();
console.log(`   name="${s.name}" findings=${s.findings} overlay=${JSON.stringify(s.overlay)} backing=${JSON.stringify(s.overlayBacking)}`);
check("the document name is shown", s.name === "letter.png", `"${s.name}"`);
check("findings are listed", s.findingRows > 0, `${s.findingRows} rows`);
check("the page renders at a usable size", (s.overlay?.w ?? 0) > 300, `overlay ${s.overlay?.w}px wide`);

console.log("\n3. Draw a box on the page");
// A real drag across the document, in page coordinates.
const box = await review.evaluate(() => {
  const o = document.querySelector(".review__overlay");
  const r = o.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
});
const before = (await ui()).findings;
await review.mouse.move(box.x + box.w * 0.2, box.y + box.h * 0.3);
await review.mouse.down();
await review.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.4, { steps: 12 });
await review.mouse.up();
await review.waitForTimeout(600);

const afterDraw = await ui();
console.log(`   findings before=${before} after=${afterDraw.findings}`);
check("a drawn box is accepted", afterDraw.findings === before + 1, `${before} -> ${afterDraw.findings}`);
check("the redaction button became available", afterDraw.redactDisabled === false);

console.log("\n4. Change the style and confirm the box repaints");
const paintedBefore = await review.evaluate(() => {
  const c = document.querySelector(".review__overlay");
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let black = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] < 40 && d[i + 1] < 40 && d[i + 2] < 40) black++;
  return black;
});
await review.selectOption("#style", "whiteout");
await review.waitForTimeout(500);
const paintedAfter = await review.evaluate(() => {
  const c = document.querySelector(".review__overlay");
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let white = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 215 && d[i + 1] > 215 && d[i + 2] > 215) white++;
  return white;
});
console.log(`   black px=${paintedBefore} white px after whiteout=${paintedAfter}`);
check("the drawn box is actually painted", paintedBefore > 0, `${paintedBefore} px`);
check("changing the style repaints it", paintedAfter > 0, `${paintedAfter} white px`);

console.log("\n5. Select all / clear all respond");
await review.click("#select-none");
await review.waitForTimeout(300);
const cleared = await ui();
check("clear all disables redaction", cleared.redactDisabled === true, `rows=${cleared.findingRows}`);
await review.click("#select-all");
await review.waitForTimeout(300);
const reselected = await ui();
check("select all re-enables redaction", reselected.redactDisabled === false);

console.log("\n6. Redact and download from the review page");
await review.selectOption("#style", "blackout");
await review.waitForTimeout(200);
const dlBefore = await sw.evaluate(async () => (await chrome.downloads.search({ limit: 10 })).length);
await review.click("#redact");
await review.waitForTimeout(400);
const dlg = await review.evaluate(() => document.getElementById("confirm")?.open ?? false);
check("the confirm dialog opened", dlg);
if (dlg) {
  await review.click("#confirm-go");
  // The worker calls chrome.downloads.download with saveAs:true, so a NATIVE save
  // dialog opens and blocks until it is answered. Nothing answers it here, and an
  // unanswered dialog can leave the redaction unfinished — which surfaced as an
  // intermittent "The redaction could not be completed." with no worker error to
  // explain it. So wait on the download itself instead of the page's own status
  // text, which only reflects what the worker managed to report.
  let saved = false;
  for (let i = 0; i < 120; i++) {
    const list = await sw.evaluate(async () => (await chrome.downloads.search({ limit: 10 })).length);
    if (list > dlBefore) {
      saved = true;
      break;
    }
    await review.waitForTimeout(1000);
  }
  check("a new download was produced", saved, saved ? `${dlBefore} -> ${dlBefore + 1}+` : `${dlBefore} -> unchanged`);
  const dlAfter = await sw.evaluate(async () =>
    (await chrome.downloads.search({ limit: 10 })).map((d) => ({ state: d.state, exists: d.exists, error: d.error }))
  );
  check("the download has no error", dlAfter.every((d) => !d.error), JSON.stringify(dlAfter));

  for (let i = 0; i < 90; i++) {
    await review.waitForTimeout(1000);
    const t = (await ui()).actionStatus;
    if (/saved/i.test(t) || /could not|failed/i.test(t)) break;
  }
}
const finalStatus = (await ui()).actionStatus;
console.log(`   status: "${finalStatus}"`);
check("the page reports the redaction succeeded", /saved/i.test(finalStatus), `"${finalStatus}"`);

await context.close();
console.log(failures.length === 0 ? "\nFull-screen review: all checks passed." : `\nFull-screen review: ${failures.length} failed: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
