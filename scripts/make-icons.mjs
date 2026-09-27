// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Generates the extension icon set (16/32/48/128) as PNGs with zero image
// dependencies. Supersampled SDF design: deep-navy gradient tile, cyan shield
// with a scan-line, and a solid white redaction bar. Run: node scripts/make-icons.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "icons");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// ---- design (SDF, supersampled at SS for crisp edges) ----
const BASE = 128;
const SS = 4; // supersample factor

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Signed distance to a rounded rectangle centered at (cx,cy). Negative = inside. */
function sdRoundedRect(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - (hw - r);
  const dy = Math.abs(y - cy) - (hh - r);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}

/** Signed distance to a shield path (vertical axis of symmetry through cx). */
function sdShield(x, y, cx, top, hw, tip, hh) {
  const sx = Math.abs(x - cx);
  const cy = tip + hh;
  // Left/right edges slope from (hw,top) to (0,tip).
  const edgeX = sx <= (hw * (y - top)) / (tip - top) ? sx : 1e9;
  // Bounding: above top or below tip is outside.
  if (y < top || y > tip) return 1e9;
  return edgeX;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Render one supersampled sub-pixel. Returns [r,g,b,a]. */
function sample(x, y) {
  // 1. Background tile: rounded square with vertical gradient + faint top glow.
  const tile = sdRoundedRect(x, y, BASE / 2, BASE / 2, BASE / 2 - 1, BASE / 2 - 1, 30);
  let a = 0;
  let r = 0, g = 0, b = 0;

  if (tile <= 0) {
    const t = y / BASE;
    // deep navy vertical gradient
    let cr = lerp(0x14, 0x09, t);
    let cg = lerp(0x2b, 0x15, t);
    let cb = lerp(0x48, 0x28, t);
    // subtle top inner highlight
    const glow = clamp(1 - y / 42, 0, 1) * 0.18;
    cr += glow * 60;
    cg += glow * 90;
    cb += glow * 120;
    a = 1;
    r = cr;
    g = cg;
    b = cb;
  } else {
    return [0, 0, 0, 0];
  }

  // 2. Shield body (fill + cyan stroke).
  const SHIELD_CX = BASE / 2;
  const SHIELD_TOP = 22;
  const SHIELD_TIP = 104;
  const SHIELD_HW = 30;
  const SHIELD_STROKE = 5;

  const edgeHalfW = (SHIELD_HW * (y - SHIELD_TOP)) / (SHIELD_TIP - SHIELD_TOP);
  const insideShield = y >= SHIELD_TOP && y <= SHIELD_TIP && Math.abs(x - SHIELD_CX) <= edgeHalfW;
  const edgeDist = Math.abs(Math.abs(x - SHIELD_CX) - edgeHalfW);

  if (insideShield) {
    // Fill: slightly lighter navy than the tile.
    const fill = [0x15, 0x32, 0x52];
    // Smooth fill under the stroke band.
    if (edgeDist > SHIELD_STROKE) {
      r = lerp(r, fill[0], 0.85);
      g = lerp(g, fill[1], 0.85);
      b = lerp(b, fill[2], 0.85);
    } else {
      // Cyan stroke band.
      const s = clamp((SHIELD_STROKE - edgeDist) / SHIELD_STROKE, 0, 1);
      const cyCol = [0x22, 0xd3, 0xee];
      r = lerp(r, cyCol[0], s);
      g = lerp(g, cyCol[1], s);
      b = lerp(b, cyCol[2], s);
    }
  }

  // 3. Scan line across the shield top.
  const SCAN_Y = 36;
  const SCAN_H = 3;
  const scanEdge = Math.abs(y - SCAN_Y) - SCAN_H / 2;
  const scanInX = Math.abs(x - SHIELD_CX) <= (SHIELD_HW * (SCAN_Y - SHIELD_TOP)) / (SHIELD_TIP - SHIELD_TOP) - 2;
  if (scanInX && scanEdge <= 0) {
    const s = 1;
    r = lerp(r, 0x22, s);
    g = lerp(g, 0xd3, s);
    b = lerp(b, 0xee, s);
  }

  // 4. White redaction bar (rounded) through the middle.
  const bar = sdRoundedRect(x, y, SHIELD_CX, 66, 24, 7, 4);
  if (bar <= 0) {
    const aa = clamp(-bar, 0, 1);
    r = lerp(r, 255, aa);
    g = lerp(g, 255, aa);
    b = lerp(b, 255, aa);
  }

  // 5. Small cyan "overridden" notch dot below the bar (evidence accent).
  const dot = Math.hypot(x - SHIELD_CX, y - 86) - 3;
  if (dot <= 0 && Math.abs(x - SHIELD_CX) <= edgeHalfW) {
    const aa = clamp(-dot, 0, 1);
    r = lerp(r, 0x22, aa);
    g = lerp(g, 0xd3, aa);
    b = lerp(b, 0xee, aa);
  }

  return [r, g, b, a * 255];
}

function renderBase() {
  const W = BASE * SS;
  const px = new Float64Array(W * W * 4);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const [r, g, b, a] = sample((x + 0.5) / SS, (y + 0.5) / SS);
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = a;
    }
  }
  return px;
}

function downscale(px, size) {
  const out = Buffer.alloc(size * size * 4);
  const factor = (BASE * SS) / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      const x0 = Math.floor(x * factor);
      const y0 = Math.floor(y * factor);
      const x1 = Math.min(BASE * SS, Math.ceil((x + 1) * factor));
      const y1 = Math.min(BASE * SS, Math.ceil((y + 1) * factor));
      let count = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * (BASE * SS) + sx) * 4;
          r += px[i];
          g += px[i + 1];
          b += px[i + 2];
          a += px[i + 3];
          count++;
        }
      }
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / count);
      out[o + 1] = Math.round(g / count);
      out[o + 2] = Math.round(b / count);
      out[o + 3] = Math.round(a / count);
    }
  }
  return out;
}

mkdirSync(outDir, { recursive: true });
const base = renderBase();
for (const size of [16, 32, 48, 128]) {
  const png = encodePng(size, size, downscale(base, size));
  writeFileSync(join(outDir, `icon-${size}.png`), png);
  console.log(`wrote icons/icon-${size}.png (${png.length} bytes)`);
}
