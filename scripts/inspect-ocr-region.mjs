// Diagnostic: OCR a fixture with the same output request and traversal the
// extension uses, then report every token that lands inside a region marked
// mustRemainUnchanged. Used to explain an over-redaction regression rather than
// guess at it.
//
//   node scripts/inspect-ocr-region.mjs tests/fixtures/photo-pii.png

import { createWorker } from "tesseract.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const image = process.argv[2] ?? join(root, "tests", "fixtures", "photo-pii.png");
const regionsPath = image.replace(/\.png$/, ".regions.json");
if (!existsSync(regionsPath)) {
  console.error(`no regions file for ${image}`);
  process.exit(1);
}
const regions = JSON.parse(readFileSync(regionsPath, "utf8"));

const assetsDir = join(root, "dist", "assets");
const worker = await createWorker("eng", 1, {
  langPath: join(assetsDir, "tessdata"),
  logger: () => {},
});

try {
  const { data } = await worker.recognize(image, undefined, { blocks: true, text: true });
  const words = [];
  for (const block of data.blocks ?? []) {
    for (const p of block.paragraphs ?? []) {
      for (const line of p.lines ?? []) {
        for (const w of line.words ?? []) words.push(w);
      }
    }
  }
  console.log(`image: ${image}`);
  console.log(`blocks=${(data.blocks ?? []).length} words=${words.length}\n`);

  const hits = (r) =>
    words.filter((w) => {
      const cx = (w.bbox.x0 + w.bbox.x1) / 2;
      const cy = (w.bbox.y0 + w.bbox.y1) / 2;
      return cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height;
    });

  console.log("regions that must be REDACTED (a hit is expected):");
  for (const r of regions.regions) {
    const h = hits(r);
    console.log(`  ${r.label.padEnd(12)} text=${JSON.stringify(r.text).padEnd(24)} ocr=${JSON.stringify(h.map((w) => w.text).join(" "))}`);
  }

  console.log("\nregions that must stay UNCHANGED (a hit is a bug):");
  for (const r of regions.mustRemainUnchanged) {
    const h = hits(r);
    const flag = h.length ? "  <-- COLLATERAL" : "";
    console.log(`  ${r.label.padEnd(14)} ocr=${JSON.stringify(h.map((w) => w.text).join(" "))}${flag}`);
    for (const w of h) {
      console.log(`      "${w.text}" bbox=${JSON.stringify(w.bbox)} conf=${w.confidence.toFixed(1)}`);
    }
  }
} finally {
  await worker.terminate();
}
