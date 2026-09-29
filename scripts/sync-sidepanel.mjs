// Generates src/sidepanel/sidepanel.html and src/sidepanel/sidepanel.css from the
// popup sources so the two surfaces cannot drift.
//
// AGENTS.md documents this relationship, but the step was previously manual, which
// let a popup-only edit reach the popup while the sidepanel kept stale markup.
// The markup transform is: popup.css -> sidepanel.css, popup.js -> sidepanel.js,
// plus the category-list fieldset collapsed to a legend (the side panel is a
// narrow surface and does not carry the popup's live-region label paragraph).
//
// Run: npm run sync:sidepanel   (add --check to verify without writing)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const check = process.argv.includes("--check");

// The block literals below are written with "\n" and joined using the newline the
// source file actually uses. core.autocrlf=true on Windows means a checkout
// rewrites these files to CRLF, and a hardcoded "\n" comparison fails there while
// passing on Linux CI. Deriving the newline from the source keeps --check honest
// on every platform.

const CATEGORY_LINES = [
  '            <p class="footnote" data-i18n="categories_label">Protection Categories</p>',
  '            <fieldset id="category-list" class="category-list" aria-label="Detection categories list"></fieldset>',
];

const CATEGORY_LINES_SIDEPANEL = [
  '            <fieldset id="category-list" class="category-fieldset">',
  '              <legend data-i18n="categories_label">Protection Categories</legend>',
  '            </fieldset>',
];

/** CRLF when the file uses it, otherwise LF. */
function newlineOf(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function transformSidepanelHtml(popupHtml) {
  const nl = newlineOf(popupHtml);
  const out = popupHtml
    .replace('href="popup.css"', 'href="sidepanel.css"')
    .replace('src="popup.js"', 'src="sidepanel.js"');

  if (out === popupHtml) {
    throw new Error("popup.css/popup.js references not found in src/popup/index.html");
  }

  const block = CATEGORY_LINES.join(nl);
  if (!out.includes(block)) {
    throw new Error("category-list fieldset block not found in src/popup/index.html");
  }
  return out.replace(block, CATEGORY_LINES_SIDEPANEL.join(nl));
}

const targets = [
  {
    label: "src/sidepanel/sidepanel.html",
    from: join(root, "src", "popup", "index.html"),
    build: transformSidepanelHtml,
  },
  {
    // Byte-for-byte copy, per AGENTS.md. No transform.
    label: "src/sidepanel/sidepanel.css",
    from: join(root, "src", "popup", "popup.css"),
    build: (css) => css,
  },
];

let drifted = 0;
for (const { label, from, build } of targets) {
  const to = join(root, ...label.split("/"));
  const next = build(readFileSync(from, "utf8"));
  const current = readFileSync(to, "utf8");
  if (current === next) {
    console.log(`ok      ${label}`);
    continue;
  }
  if (check) {
    console.error(`DRIFT   ${label} — run: npm run sync:sidepanel`);
    drifted += 1;
    continue;
  }
  writeFileSync(to, next);
  console.log(`wrote   ${label}`);
}

if (drifted > 0) process.exit(1);
