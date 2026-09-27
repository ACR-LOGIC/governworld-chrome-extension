// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import mammoth from "mammoth";

/**
 * DOCX-page loading. Extracts raw text with mammoth, then lays it out on a
 * canvas at fixed 150-DPI letter geometry so the rest of the pipeline (OCR,
 * rect findings, flattened redaction) works unchanged. Runs inside the
 * offscreen document (DOM canvas available).
 */

export interface DocxPage {
  index: number;
  canvas: HTMLCanvasElement;
  widthPx: number;
  heightPx: number;
  widthPt: number;
  heightPt: number;
  hasTextLayer: boolean;
}

const DPI = 150;
const PAGE_WIDTH_PX = Math.floor(8.5 * DPI); // 1275
const PAGE_HEIGHT_PX = Math.floor(11 * DPI); // 1650
const MARGIN_PX = Math.floor(1 * DPI);
const FONT = `${Math.floor(0.14 * DPI)}px "Segoe UI", system-ui, sans-serif`;
const LINE_HEIGHT = Math.floor(0.2 * DPI);
const MAX_DOCX_CHARS = 200_000;
const MAX_DOCX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_DOCX_ENTRIES = 1_000;
const MAX_DOCX_RATIO = 100;

export function assertSafeDocxArchive(bytes: ArrayBuffer): void {
  const view = new DataView(bytes);
  let eocd = -1;
  const start = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= start; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("DOCX archive is invalid.");
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff || entryCount > MAX_DOCX_ENTRIES) throw new Error("DOCX archive limits are unsupported.");
  if (centralOffset + centralSize > bytes.byteLength) throw new Error("DOCX archive is truncated.");

  let offset = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) throw new Error("DOCX archive is invalid.");
    const flags = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    if ((flags & 1) !== 0 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) throw new Error("Encrypted or unsupported DOCX entries are not allowed.");
    if (uncompressedSize > MAX_DOCX_UNCOMPRESSED_BYTES - totalUncompressed) throw new Error("DOCX archive expands beyond the processing limit.");
    if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_DOCX_RATIO) throw new Error("DOCX archive compression ratio is unsafe.");
    totalUncompressed += uncompressedSize;
    offset += 46 + nameLength + extraLength + commentLength;
  }
}

function layoutPages(text: string, ctx: CanvasRenderingContext2D): string[][] {
  const paragraphs = text.split(/\r?\n/).map((p) => p.trim());
  const maxWidth = PAGE_WIDTH_PX - MARGIN_PX * 2;
  const lines: string[][] = [];
  let pageLines: string[] = [];
  const maxLinesPerPage = Math.floor((PAGE_HEIGHT_PX - MARGIN_PX * 2) / LINE_HEIGHT);

  const pushLine = (line: string) => {
    if (pageLines.length >= maxLinesPerPage) {
      lines.push(pageLines);
      pageLines = [];
    }
    pageLines.push(line);
  };

  for (const para of paragraphs) {
    if (para === "") {
      pushLine("");
      continue;
    }
    let remaining = para;
    while (remaining.length > 0) {
      let fit = remaining;
      while (ctx.measureText(fit).width > maxWidth && fit.length > 1) {
        // Trim by word if possible, else hard-cut.
        const cut = fit.lastIndexOf(" ", Math.floor((fit.length * maxWidth) / ctx.measureText(fit).width));
        fit = cut > 0 ? fit.slice(0, cut) : fit.slice(0, Math.max(1, fit.length - 8));
      }
      pushLine(fit);
      remaining = remaining.slice(fit.length).trimStart();
    }
  }
  if (pageLines.length > 0 || lines.length === 0) lines.push(pageLines);
  return lines;
}

export async function loadDocxPages(bytes: ArrayBuffer): Promise<DocxPage[]> {
  assertSafeDocxArchive(bytes);
  const input = { buffer: new Uint8Array(bytes.slice(0)) };
  const { value } = await mammoth.extractRawText(
    input as unknown as Parameters<typeof mammoth.extractRawText>[0]
  );
  const text = (value ?? "").slice(0, MAX_DOCX_CHARS);

  const canvas = document.createElement("canvas");
  canvas.width = PAGE_WIDTH_PX;
  canvas.height = PAGE_HEIGHT_PX;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas rendering is unavailable.");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = FONT;
  ctx.fillStyle = "#111111";
  ctx.textBaseline = "top";

  const pages = layoutPages(text, ctx);
  return pages.map((pageLines, index) => {
    const pageCanvas = document.createElement("canvas");
    pageCanvas.width = PAGE_WIDTH_PX;
    pageCanvas.height = PAGE_HEIGHT_PX;
    const pctx = pageCanvas.getContext("2d", { willReadFrequently: true });
    if (!pctx) throw new Error("Canvas rendering is unavailable.");
    pctx.fillStyle = "#ffffff";
    pctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
    pctx.font = FONT;
    pctx.fillStyle = "#111111";
    pctx.textBaseline = "top";
    let y = MARGIN_PX;
    for (const line of pageLines) {
      if (line !== "") pctx.fillText(line, MARGIN_PX, y);
      y += LINE_HEIGHT;
    }
    return {
      index,
      canvas: pageCanvas,
      widthPx: pageCanvas.width,
      heightPx: pageCanvas.height,
      widthPt: 612,
      heightPt: 792,
      hasTextLayer: false,
    };
  });
}
