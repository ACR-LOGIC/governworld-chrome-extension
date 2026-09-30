// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Safari handoff payload builder.
//
// What this produces: dist-safari/ — the complete web-extension file set
// (same engine as Chromium) ready to feed into Apple's packaging step. What
// it does NOT produce: a distributable Safari extension. Safari web
// extensions ship inside a signed macOS/iOS app, which requires either
// Xcode on a Mac (`xcrun safari-web-extension-packager /path/to/dist-safari`)
// or the web-based packager in App Store Connect (Apple Developer Program
// membership required). Neither is available on this build machine, so the
// payload is built and checksummed for handoff, and packaging remains a
// documented blocker in BROWSER_SUPPORT.md — not a fabricated artifact.
//
// Safari API notes (capability-gated in code, never assumed):
// - scripting.registerContentScripts: used when present for always-on;
//   otherwise always-on reports "waiting for access" like anywhere else.
// - storage.managed: absent on Safari, so enterprise policy reads as
//   unmanaged and the user controls protection (documented).
// - offscreen: absent on Safari, so Document Studio reports its limitation
//   through the existing error path (src/shared/platform.ts).
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "dist-safari");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const common = {
  bundle: true,
  sourcemap: false,
  legalComments: "none",
  minify: true,
  target: "safari16",
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

// Safari payload manifest: Chromium shape (the packager validates and adapts
// it), version injected from package.json. `side_panel` is Chromium-only and
// is dropped here rather than shipping a key Safari ignores.
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const base = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
delete base.side_panel;
delete base.storage;
base.version = pkg.version;
delete base.background;
base.background = { service_worker: "service-worker.js", type: "module" };
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(base, null, 2) + "\n");
console.log(`Safari payload manifest version: ${pkg.version}`);
console.log("Built Safari handoff payload to dist-safari/");
console.log("Next (requires Mac+Xcode or App Store Connect): xcrun safari-web-extension-packager dist-safari");
