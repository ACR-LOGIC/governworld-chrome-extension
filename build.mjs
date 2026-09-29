// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const outDir = join(root, "dist");
const dev = process.argv.includes("--dev");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const common = {
  bundle: true,
  sourcemap: false,
  legalComments: "none",
  minify: !dev,
  target: "chrome109",
  logLevel: "info",
};

const entries = [
  { entry: "src/service-worker/index.ts", out: "service-worker.js", format: "esm" },
  { entry: "src/content/content.ts", out: "content.js", format: "iife" },
  { entry: "src/popup/entry.ts", out: "popup.js", format: "iife" },
  { entry: "src/sidepanel/sidepanel.ts", out: "sidepanel.js", format: "iife" },
  { entry: "src/offscreen/offscreen.ts", out: "offscreen.js", format: "esm" },
  // Print/PDF view. Its own entry so the print path never pulls the popup's
  // controller into the page, and so the page has no scan logic at all.
  { entry: "src/popup/redact.ts", out: "redact.js", format: "iife" },
];

for (const { entry, out, format } of entries) {
  await build({
    ...common,
    entryPoints: [join(root, entry)],
    outfile: join(outDir, out),
    format,
  });
}

copyFileSync(join(root, "src/popup", "index.html"), join(outDir, "popup.html"));
copyFileSync(join(root, "src/popup", "popup.css"), join(outDir, "popup.css"));
copyFileSync(join(root, "src/offscreen", "offscreen.html"), join(outDir, "offscreen.html"));
copyFileSync(join(root, "src/sidepanel", "sidepanel.html"), join(outDir, "sidepanel.html"));
copyFileSync(join(root, "src/sidepanel", "sidepanel.css"), join(outDir, "sidepanel.css"));
copyFileSync(join(root, "src/landing", "index.html"), join(outDir, "landing.html"));
copyFileSync(join(root, "src/landing", "landing.js"), join(outDir, "landing.js"));
copyFileSync(join(root, "src/popup", "privacy.html"), join(outDir, "privacy.html"));
copyFileSync(join(root, "src/popup", "legal.html"), join(outDir, "legal.html"));
copyFileSync(join(root, "src/popup", "redact.html"), join(outDir, "redact.html"));
copyFileSync(join(root, "manifest.json"), join(outDir, "manifest.json"));
copyFileSync(join(root, "PRIVACY.md"), join(outDir, "PRIVACY.md"));
copyFileSync(join(root, "PERMISSIONS.md"), join(outDir, "PERMISSIONS.md"));

// Extension icons (generated deterministically via scripts/make-icons.mjs).
const iconsDir = join(outDir, "icons");
mkdirSync(iconsDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  copyFileSync(join(root, "icons", `icon-${size}.png`), join(iconsDir, `icon-${size}.png`));
}

// Bundled worker assets (pdf.js worker + tesseract worker/core). Loaded via
// chrome.runtime.getURL so the pipeline never hits the network in local mode.
const assetsDir = join(outDir, "assets");
mkdirSync(assetsDir, { recursive: true });
copyFileSync(
  join(root, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs"),
  join(assetsDir, "pdf.worker.min.mjs")
);
copyFileSync(
  join(root, "node_modules/tesseract.js/dist/worker.min.js"),
  join(assetsDir, "tesseract.worker.min.js")
);
copyFileSync(
  join(root, "node_modules/tesseract.js-core/tesseract-core.wasm.js"),
  join(assetsDir, "tesseract-core.wasm.js")
);
copyFileSync(
  join(root, "node_modules/tesseract.js-core/tesseract-core.wasm"),
  join(assetsDir, "tesseract-core.wasm")
);

// Vendor OCR language data. The build fails closed if the model is absent so a
// build can never silently ship without offline OCR.
const tessdataDir = join(assetsDir, "tessdata");
mkdirSync(tessdataDir, { recursive: true });
const tessdataSrc = join(root, "vendor", "tessdata", "eng.traineddata.gz");
if (!existsSync(tessdataSrc)) {
  throw new Error(
    "Missing vendored OCR language data at vendor/tessdata/eng.traineddata.gz. " +
      "Download it from https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz and retry."
  );
}
copyFileSync(tessdataSrc, join(tessdataDir, "eng.traineddata.gz"));

console.log("Built extension to dist/");