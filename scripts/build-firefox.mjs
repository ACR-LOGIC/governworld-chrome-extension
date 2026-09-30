// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Firefox package builder. Same engine, Firefox-shaped manifest.
//
// Firefox runs MV3 background contexts as event-page documents (not service
// workers), exposes the sidebar via sidebar_action (not sidePanel), and has
// no offscreen API — so the manifest omits the Chromium-only `offscreen` and
// `sidePanel` permission keys that would fail installation, and the Document
// Studio reports its limitation through the existing error path (see
// src/shared/platform.ts). The locked add-on ID lives in
// manifest.firefox.json and must never be regenerated: changing it after
// publication breaks upgrades. The version is injected from package.json so
// the manifest shape has exactly one source of truth.
//
// Output: dist-firefox/ (load via about:debugging, or `web-ext build`).
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "dist-firefox");
const dev = process.argv.includes("--dev");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const common = {
  bundle: true,
  sourcemap: false,
  legalComments: "none",
  minify: !dev,
  target: "firefox109",
  logLevel: "info",
};

const entries = [
  { entry: "src/service-worker/index.ts", out: "service-worker.js", format: "esm" },
  { entry: "src/content/content.ts", out: "content.js", format: "iife" },
  { entry: "src/popup/entry.ts", out: "popup.js", format: "iife" },
  { entry: "src/sidepanel/sidepanel.ts", out: "sidepanel.js", format: "iife" },
  { entry: "src/offscreen/offscreen.ts", out: "offscreen.js", format: "esm" },
  { entry: "src/popup/redact.ts", out: "redact.js", format: "iife" },
  { entry: "src/popup/review.ts", out: "review.js", format: "iife" },
];

for (const { entry, out, format } of entries) {
  await build({
    ...common,
    entryPoints: [join(root, entry)],
    outfile: join(outDir, out),
    format,
  });
}

for (const [from, to] of [
  ["src/popup/index.html", "popup.html"],
  ["src/popup/popup.css", "popup.css"],
  ["src/offscreen/offscreen.html", "offscreen.html"],
  ["src/sidepanel/sidepanel.html", "sidepanel.html"],
  ["src/sidepanel/sidepanel.css", "sidepanel.css"],
  ["src/landing/index.html", "landing.html"],
  ["src/landing/landing.js", "landing.js"],
  ["src/popup/privacy.html", "privacy.html"],
  ["src/popup/legal.html", "legal.html"],
  ["src/popup/redact.html", "redact.html"],
  ["src/popup/review.html", "review.html"],
  ["src/popup/review.css", "review.css"],
  ["PRIVACY.md", "PRIVACY.md"],
  ["PERMISSIONS.md", "PERMISSIONS.md"],
]) {
  copyFileSync(join(root, ...from.split("/")), join(outDir, to));
}

const iconsDir = join(outDir, "icons");
mkdirSync(iconsDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  copyFileSync(join(root, "icons", `icon-${size}.png`), join(iconsDir, `icon-${size}.png`));
}

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

const tessdataDir = join(assetsDir, "tessdata");
mkdirSync(tessdataDir, { recursive: true });
const langSource = readFileSync(join(root, "src", "shared", "ocrLanguages.ts"), "utf8");
const langEntries = [...langSource.matchAll(/code:\s*"([a-z]{3})"[^}]*?file:\s*"([^"]+)"/g)].map((m) => ({
  code: m[1],
  file: m[2],
}));
if (langEntries.length === 0) {
  throw new Error("Could not read BUNDLED_OCR_LANGUAGES from src/shared/ocrLanguages.ts; refusing to build.");
}
for (const { code, file } of langEntries) {
  const src = join(root, "vendor", "tessdata", file);
  if (!existsSync(src)) {
    throw new Error(
      `Missing vendored OCR language data at vendor/tessdata/${file} (declared for "${code}" in ` +
        "src/shared/ocrLanguages.ts). Add the traineddata or remove the language, then retry."
    );
  }
  copyFileSync(src, join(tessdataDir, file));
}

// Firefox manifest: shape from manifest.firefox.json, version from package.json.
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const ffManifest = JSON.parse(readFileSync(join(root, "manifest.firefox.json"), "utf8"));
ffManifest.version = pkg.version;
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(ffManifest, null, 2) + "\n");
console.log(`Firefox manifest version: ${pkg.version}, gecko id: ${ffManifest.browser_specific_settings.gecko.id}`);
console.log(`Vendored OCR languages: ${langEntries.map((l) => l.code).join(", ")}`);
console.log("Built Firefox extension to dist-firefox/");
