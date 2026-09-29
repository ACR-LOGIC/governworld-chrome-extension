// Minimal PNG decode/encode, no external image dependency.
//
// The project deliberately carries no image libraries: the icon generator has
// always been pure Node plus zlib. This keeps that property while allowing the
// real logo master to be processed rather than an SDF approximation of it.
//
// Supports what the logo master and the icons need: 8-bit non-interlaced
// greyscale/RGB/RGBA, encode as 8-bit RGBA.

import { deflateSync, inflateSync } from "node:zlib";

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

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

/** Encode 8-bit RGBA pixels as a PNG. */
export function encodePng(width, height, rgba) {
  const sig = Buffer.from(SIG);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Decode a non-interlaced 8-bit PNG to { width, height, channels, data }. */
export function decodePng(buf) {
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== SIG[i]) throw new Error("not a PNG");
  }
  let pos = 8;
  let ihdr = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      ihdr = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        interlace: body[12],
      };
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  if (!ihdr) throw new Error("no IHDR chunk");
  if (ihdr.bitDepth !== 8) throw new Error(`unsupported bit depth ${ihdr.bitDepth}`);
  if (ihdr.interlace !== 0) throw new Error("interlaced PNG is not supported");
  const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const channels = CHANNELS[ihdr.colorType];
  if (!channels) throw new Error(`unsupported colour type ${ihdr.colorType}`);
  if (ihdr.colorType === 3) throw new Error("palette PNG is not supported");

  const { width, height } = ihdr;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const rv = raw[src + x];
      const a = x >= channels ? out[dst + x - channels] : 0;
      const b = y > 0 ? out[up + x] : 0;
      const c = x >= channels && y > 0 ? out[up + x - channels] : 0;
      let v;
      switch (filter) {
        case 0: v = rv; break;
        case 1: v = rv + a; break;
        case 2: v = rv + b; break;
        case 3: v = rv + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = rv + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`bad filter ${filter} on row ${y}`);
      }
      out[dst + x] = v & 0xff;
    }
  }
  return { width, height, channels, data: out, colorType: ihdr.colorType };
}

/**
 * Box-filtered resample of RGBA source pixels to a new size.
 * Averaging in premultiplied space keeps the near-black glow from producing a
 * dark halo when the emblem is scaled down onto a transparent edge.
 */
export function resampleRgba(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const xr = sw / dw;
  const yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.floor(y * yr);
    const sy1 = Math.max(sy0 + 1, Math.min(sh, Math.ceil((y + 1) * yr)));
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.floor(x * xr);
      const sx1 = Math.max(sx0 + 1, Math.min(sw, Math.ceil((x + 1) * xr)));
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * sw + sx) * 4;
          const sa = src[i + 3];
          // Premultiply so transparent (black) pixels do not darken the edge.
          r += src[i] * sa;
          g += src[i + 1] * sa;
          b += src[i + 2] * sa;
          a += sa;
          wsum += 1;
        }
      }
      const o = (y * dw + x) * 4;
      if (a > 0) {
        out[o] = Math.min(255, Math.round(r / a));
        out[o + 1] = Math.min(255, Math.round(g / a));
        out[o + 2] = Math.min(255, Math.round(b / a));
      }
      out[o + 3] = Math.round(a / wsum);
    }
  }
  return out;
}

/**
 * Box-filtered resample of *premultiplied* RGBA, averaging all four channels
 * as-is.
 *
 * Callers that already hold premultiplied colour and are about to composite
 * source-over use this instead of resampleRgba, for two reasons: the data is not
 * premultiplied twice, and near-black pixels sitting under a low alpha are
 * never divided back up. That division is what turns the logo master's faint
 * field glow into a visible pale rectangle when a key is derived from
 * luminance.
 */
export function resamplePremultiplied(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const xr = sw / dw;
  const yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.floor(y * yr);
    const sy1 = Math.max(sy0 + 1, Math.min(sh, Math.ceil((y + 1) * yr)));
    const rows = sy1 - sy0;
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.floor(x * xr);
      const sx1 = Math.max(sx0 + 1, Math.min(sw, Math.ceil((x + 1) * xr)));
      const cols = sx1 - sx0;
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * sw + sx) * 4;
          r += src[i];
          g += src[i + 1];
          b += src[i + 2];
          a += src[i + 3];
        }
      }
      const n = rows * cols;
      const o = (y * dw + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}
