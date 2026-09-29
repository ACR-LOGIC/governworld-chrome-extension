// Measure the logo at several luminance thresholds so the core mark can be
// separated from the faint glow and the decorative orbital rings. A single
// threshold conflates the two and produces a crop that is either too tight
// (clips the rings mid-stroke) or too loose (drags in the wordmark).
//
//   node scripts/logo-measure.mjs <path-to-master.png>

import { readFileSync } from "node:fs";
import { decodePng } from "./lib/png.mjs";

const path = process.argv[2];
if (!path) {
  console.error("usage: node scripts/logo-measure.mjs <png>");
  process.exit(1);
}

const { width: W, height: H, channels: C, data } = decodePng(readFileSync(path));
const lum = (x, y) => {
  const i = (y * W + x) * C;
  return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
};

console.log(`master: ${W}x${H} channels=${C}`);
console.log("");
for (const T of [16, 24, 40, 60, 90, 130]) {
  let minX = W, maxX = -1, minY = H, maxY = -1, n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (lum(x, y) > T) {
        n++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  console.log(
    `T=${String(T).padStart(3)}  px=${String(n).padStart(7)}  x ${String(minX).padStart(4)}..${String(maxX).padStart(4)} (w ${String(maxX - minX + 1).padStart(4)})  y ${String(minY).padStart(4)}..${String(maxY).padStart(4)} (h ${String(maxY - minY + 1).padStart(4)})`,
  );
}

const T = 40;
console.log(`\nper-band horizontal extent at T=${T} (every 20 rows):`);
for (let y = 100; y < 1040; y += 20) {
  let lo = W, hi = -1;
  for (let x = 0; x < W; x++) {
    if (lum(x, y) > T) {
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
  }
  console.log(hi < 0 ? `  y=${String(y).padStart(4)}  (empty)` : `  y=${String(y).padStart(4)}  x ${String(lo).padStart(4)}..${String(hi).padStart(4)} (w ${String(hi - lo + 1).padStart(4)})`);
}
