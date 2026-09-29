// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
//
// The single definition of how OCR tokens become text, and how a character
// offset in that text maps back to a token's page rectangle.
//
// This rule used to be written out twice — once in ocr.ts to build `fullText`,
// once in core.ts to recompute the offsets in `tokenSpans` — with a comment on
// each side warning that they had to stay in step. Nothing enforced it. When
// tesseract.js was upgraded to v7, ocr.ts started returning Tesseract's own
// `data.text` (which uses different spacing) and every unit test still passed,
// while redaction boxes were drawn over innocent content. Only the pixel-level
// photo E2E noticed.
//
// With one implementation there is nothing to keep in step: the text and the
// offsets are derived from the same function, so they cannot disagree.

export interface OcrTokenLike {
  text: string;
  lineIndex: number;
}

export interface TokenSpan<T extends OcrTokenLike> {
  start: number;
  end: number;
  token: T;
}

/** The separator that precedes token `i`, given the token before it. */
function separatorBefore(i: number, tokens: readonly OcrTokenLike[]): string {
  if (i === 0) return "";
  return tokens[i].lineIndex !== tokens[i - 1].lineIndex ? "\n" : " ";
}

/** Join tokens into the text that detection runs over. */
export function assembleOcrText(tokens: readonly OcrTokenLike[]): string {
  let out = "";
  for (let i = 0; i < tokens.length; i++) {
    out += separatorBefore(i, tokens) + tokens[i].text;
  }
  return out;
}

/**
 * Char offsets of every token within the text produced by assembleOcrText.
 * A match at [start, end) resolves to the tokens fully inside that range.
 */
export function tokenSpans<T extends OcrTokenLike>(tokens: readonly T[]): TokenSpan<T>[] {
  let pos = 0;
  const spans: TokenSpan<T>[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const sep = separatorBefore(i, tokens);
    const start = pos + sep.length;
    const end = start + tokens[i].text.length;
    pos = end;
    spans.push({ start, end, token: tokens[i] });
  }
  return spans;
}
