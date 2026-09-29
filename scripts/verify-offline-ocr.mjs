// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Offline OCR smoke test. Builds a synthetic PNG with a bitmap-font string,
// then runs Tesseract entirely from the bundled assets (worker/core/tessdata in
// dist/assets) with no network access. Run from apps/redaction-extension:
//   npm run test:offline-ocr
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorker } from "tesseract.js";

const root = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(root, "..");
const assetsDir = join(pkgRoot, "dist", "assets");

if (!existsSync(join(assetsDir, "tessdata", "eng.traineddata.gz"))) {
  throw new Error("Missing dist/assets/tessdata/eng.traineddata.gz. Run `npm run build` first.");
}

// --- Minimal 5x7 bitmap font (synthetic glyphs, public-domain shapes) ---
const GLYPHS = {
  H: [".###.","#...#","#...#","#####","#...#","#...#","#...#"],
  E: ["####.","#....","####.","#....","#....","#....","####."],
  L: ["#....","#....","#....","#....","#....","#....","####."],
  O: [".###.","#...#","#...#","#...#","#...#","#...#",".###."],
  " ": [".....",".....",".....",".....",".....",".....","....."],
};
const SCALE = 12;
const PAD = 8;

function renderText(text) {
  const glyphs = [...text.toUpperCase()].map((c) => GLYPHS[c] ?? GLYPHS[" "]);
  const glyphW = 5;
  const glyphH = 7;
  const spacing = 2 * SCALE;
  const w = (glyphW * SCALE) * glyphs.length + spacing * (glyphs.length - 1) + PAD * 2;
  const h = glyphH * SCALE + PAD * 2;
  const px = new Uint8Array(w * h * 3).fill(255); // white
  glyphs.forEach((g, gi) => {
    const gx = PAD + gi * (glyphW * SCALE + spacing);
    const gy = PAD;
    for (let y = 0; y < glyphH; y++) {
      for (let x = 0; x < glyphW; x++) {
        if (g[y][x] !== "#") continue;
        for (let sy = 0; sy < SCALE; sy++) {
          for (let sx = 0; sx < SCALE; sx++) {
            const pxX = gx + x * SCALE + sx;
            const pxY = gy + y * SCALE + sy;
            const i = (pxY * w + pxX) * 3;
            px[i] = 0; px[i + 1] = 0; px[i + 2] = 0;
          }
        }
      }
    }
  });
  return { px, w, h };
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng({ px, w, h }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // truecolor
  const scanlines = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    scanlines[y * (w * 3 + 1)] = 0; // filter: none
    px.subarray(y * w * 3, (y + 1) * w * 3).forEach((v, i) => {
      scanlines[y * (w * 3 + 1) + 1 + i] = v;
    });
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(scanlines)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const text = "HELLO";
const img = renderText(text);
const png = encodePng(img);
const tmpDir = join(pkgRoot, ".tmp-ocr-smoke");
mkdirSync(tmpDir, { recursive: true });
const pngPath = join(tmpDir, "sample.png");
writeFileSync(pngPath, png);

const worker = await createWorker("eng", 1, {
  // Node path: worker/core are resolved from the local node_modules (offline).
  // The language data is read from the vendored dist asset — the exact file the
  // browser build resolves via chrome.runtime.getURL("assets/tessdata/...").
  langPath: join(assetsDir, "tessdata"),
  logger: () => {},
});

try {
  // Request the same output the extension requests, and traverse it the same
  // way. tesseract.js 7 does NOT include `blocks` in the default output, so a
  // bare recognize() would report success while data.blocks is null — and the
  // document pipeline would silently redact nothing. Asserting the traversal
  // here is what catches that class of regression; checking data.text alone
  // does not.
  const { data } = await worker.recognize(pngPath, undefined, { blocks: true, text: true });
  const normalized = data.text.toUpperCase().replace(/\s+/g, " ").trim();
  console.log(`OCR output: ${JSON.stringify(normalized)}`);
  if (!/HELLO/.test(normalized)) {
    throw new Error(`OCR output did not match expectation: ${JSON.stringify(normalized)}`);
  }

  if (!data.blocks || data.blocks.length === 0) {
    throw new Error(
      "recognize() returned no blocks. tesseract.js no longer populates them by default, " +
        "so the extension must pass { blocks: true } — see src/document-pipeline/ocr.ts."
    );
  }

  // Mirror ocrCanvas(): page -> blocks -> paragraphs -> lines -> words.
  const words = [];
  let lineCount = 0;
  for (const block of data.blocks) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        lineCount += 1;
        for (const w of line.words ?? []) words.push(w);
      }
    }
  }
  const wordText = words.map((w) => w.text).join("").toUpperCase();
  console.log(`OCR blocks=${data.blocks.length} lines=${lineCount} words=${words.length} text=${JSON.stringify(wordText)}`);
  if (words.length === 0) {
    throw new Error("blocks present but the block/paragraph/line/word traversal yielded no words");
  }
  if (!/HELLO/.test(wordText)) {
    throw new Error(`word traversal lost the text: ${JSON.stringify(wordText)}`);
  }
  for (const w of words) {
    if (typeof w.bbox?.x0 !== "number" || typeof w.bbox?.y0 !== "number") {
      throw new Error("word is missing a numeric bbox; page coordinates are required to draw redactions");
    }
  }
  console.log("Offline OCR smoke test passed (no network, block traversal verified).");
} finally {
  await worker.terminate();
}