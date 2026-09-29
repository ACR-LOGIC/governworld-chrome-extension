// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
//
// Generates the extension icon set (16/32/48/128) plus a 512px emblem from the
// GovernWorld logo master. Run:
//
//   node scripts/make-icons.mjs <path-to-master.png>
//
// With no argument it uses the copy committed at brand/logo-master.png, so the
// icons are reproducible from the repository alone.
//
// Why this is a raster pipeline rather than the old SDF drawing: the shipped
// artwork is the brand's logo, and a hand-drawn approximation of it is not the
// brand. Still no image dependency — decode/encode are pure Node plus zlib
// (scripts/lib/png.mjs).
//
// Geometry is measured from the master, not guessed. The emblem (globe, shield
// with the GW monogram and padlock, and the orbital rings) occupies
// y 131..838 and x 182..1081 in the 1254x1254 master, and the GOVERNORLD
// wordmark starts at y 849. The emblem is 899x707 — wider than tall — so a
// square crop that kept the whole emblem would drag in the top of the
// wordmark. Instead the emblem is composited whole, centred, onto a rounded
// tile in the brand's own deep navy, which is what the surrounding UI uses.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, encodePng, resamplePremultiplied } from "./lib/png.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const iconDir = join(root, "icons");
const committed = join(root, "brand", "logo-master.png");
const masterPath = process.argv[2] ?? committed;

if (!readFileSync) throw new Error("unreachable");
let master;
try {
  master = readFileSync(masterPath);
} catch {
  console.error(`logo master not found: ${masterPath}`);
  console.error("pass the master explicitly, e.g. node scripts/make-icons.mjs C:/path/to/logo.png");
  process.exit(1);
}

const src = decodePng(master);
const { width: MW, height: MH, channels: MC, data: MD } = src;
console.log(`master: ${masterPath}`);
console.log(`        ${MW}x${MH}, colourType=${src.colorType}`);

// Emblem bounds in master coordinates, verified by scripts/logo-measure.mjs.
const EMBLEM = { x0: 182, y0: 131, x1: 1081, y1: 838 };
const emW = EMBLEM.x1 - EMBLEM.x0;
const emH = EMBLEM.y1 - EMBLEM.y0;

// Fraction of the tile the emblem spans. Leaves a clear margin so the mark does
// not touch the tile edge, which matters at 16px.
const FILL = 0.88;

// Brand tile. The master's own field is near-black; the UI uses a deep navy, so
// the tile matches the UI rather than introducing a second black.
const TILE_TOP = [0x0e, 0x1a, 0x30];
const TILE_BOTTOM = [0x07, 0x0d, 0x1a];

/** Smoothstep from 0 to 1 between edge0 and edge1. */
function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Sample the master into *premultiplied* RGBA, cropping to the emblem and
 * keying out the master's near-black field.
 *
 * Without the key, the emblem carries its own dark rectangle and the tile
 * gradient shows only as a border around it. The mark is emissive artwork on a
 * near-black ground, so luminance separates cleanly: the field sits at roughly
 * 0..30 and the artwork starts around 40. A hard threshold would leave a jagged
 * edge, so this ramps over that band.
 *
 * Colour is stored premultiplied and resampled with resamplePremultiplied. The
 * obvious alternative — storing straight alpha and dividing the colour back out
 * by it — rescales the master's faint field glow into a visible pale rectangle,
 * because that field is near-black noise at a low alpha.
 */
function cropEmblemPremultiplied() {
  const out = Buffer.alloc(emW * emH * 4);
  for (let y = 0; y < emH; y++) {
    for (let x = 0; x < emW; x++) {
      const si = ((y + EMBLEM.y0) * MW + (x + EMBLEM.x0)) * MC;
      const di = (y * emW + x) * 4;
      const r = MD[si];
      const g = MD[si + 1];
      const b = MD[si + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const a = smoothstep(2, 40, lum);
      out[di] = Math.round(r * a);
      out[di + 1] = Math.round(g * a);
      out[di + 2] = Math.round(b * a);
      out[di + 3] = Math.round(a * 255);
    }
  }
  return out;
}

/** Composite the emblem onto a rounded navy tile at `size`. */
function renderTile(size) {
  const SS = 3; // supersample, so the rounded corners stay clean at 16px
  const W = size * SS;
  const emblem = cropEmblemPremultiplied();

  // Fit the emblem to the tile by width, then centre it vertically.
  const targetW = W * FILL;
  const targetH = targetW * (emH / emW);
  const scaledW = Math.max(1, Math.round(targetW));
  const scaledH = Math.max(1, Math.round(targetH));
  const emblemScaled = resamplePremultiplied(emblem, emW, emH, scaledW, scaledH);
  const offX = Math.round((W - scaledW) / 2);
  const offY = Math.round((W - scaledH) / 2);

  // Rounded-square radius, matching the --radius-sm language of the UI.
  const radius = W * 0.22;

  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x * SS + sx + 0.5;
          const py = y * SS + sy + 0.5;

          // Tile coverage with a 1px feather for antialiasing.
          const dx = Math.max(radius - px, px - (W - radius), 0);
          const dy = Math.max(radius - py, py - (W - radius), 0);
          const outside = Math.hypot(dx, dy) - radius;
          const tileA = Math.max(0, Math.min(1, 0.5 - outside));
          if (tileA <= 0) continue;

          const t = py / W;
          let tr = TILE_TOP[0] + (TILE_BOTTOM[0] - TILE_TOP[0]) * t;
          let tg = TILE_TOP[1] + (TILE_BOTTOM[1] - TILE_TOP[1]) * t;
          let tb = TILE_TOP[2] + (TILE_BOTTOM[2] - TILE_TOP[2]) * t;

          // Emblem over tile, source-over. Both terms stay in 0..255:
          // emblemScaled already holds premultiplied colour (r * a), so it is
          // added directly rather than divided back out.
          const ex = px - offX;
          const ey = py - offY;
          if (ex >= 0 && ey >= 0 && ex < scaledW && ey < scaledH) {
            const ei = (Math.floor(ey) * scaledW + Math.floor(ex)) * 4;
            const ea = emblemScaled[ei + 3] / 255;
            if (ea > 0) {
              tr = tr * (1 - ea) + emblemScaled[ei];
              tg = tg * (1 - ea) + emblemScaled[ei + 1];
              tb = tb * (1 - ea) + emblemScaled[ei + 2];
            }
          }

          r += tr * tileA;
          g += tg * tileA;
          b += tb * tileA;
          a += tileA;
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      if (a > 0) {
        out[o] = Math.min(255, Math.round(r / a));
        out[o + 1] = Math.min(255, Math.round(g / a));
        out[o + 2] = Math.min(255, Math.round(b / a));
      }
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

mkdirSync(iconDir, { recursive: true });
// Only the four sizes the manifest declares. The UI brand mark uses the 128px
// file at 32-44 CSS px, so a larger render would be an unreferenced binary in
// the repository.
for (const size of [16, 32, 48, 128]) {
  const png = encodePng(size, size, renderTile(size));
  writeFileSync(join(iconDir, `icon-${size}.png`), png);
  console.log(`wrote icons/icon-${size}.png (${size}x${size}, ${png.length} bytes)`);
}
console.log(`emblem source region: x ${EMBLEM.x0}..${EMBLEM.x1}  y ${EMBLEM.y0}..${EMBLEM.y1} (${emW}x${emH})`);
