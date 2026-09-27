// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect } from "vitest";
import { bytesToBase64, base64ToBytes, isOffscreenRequest, OFFSCREEN_CHANNEL } from "../src/document-pipeline/contract.js";

describe("bytesToBase64 / base64ToBytes round-trip", () => {
  it("round-trips empty input", () => {
    const empty = new Uint8Array(0);
    const encoded = bytesToBase64(empty);
    expect(encoded).toBe("");
    expect(base64ToBytes(encoded)).toEqual(empty);
  });

  it("round-trips a Uint8Array", () => {
    const data = new Uint8Array([104, 101, 108, 108, 111]);
    expect(base64ToBytes(bytesToBase64(data))).toEqual(data);
  });

  it("round-trips an ArrayBuffer", () => {
    const data = new Uint8Array([1, 2, 3, 255, 0, 128]).buffer as ArrayBuffer;
    const roundTripped = base64ToBytes(bytesToBase64(data));
    expect(roundTripped).toEqual(new Uint8Array(data));
  });

  it("encodes only the visible bytes of a Uint8Array subarray view", () => {
    const backing = new Uint8Array([9, 9, 42, 9, 9]);
    const view = backing.subarray(2, 3);
    const roundTripped = base64ToBytes(bytesToBase64(view));
    expect(roundTripped).toEqual(new Uint8Array([42]));
  });

  it("handles data larger than the 0x8000 chunk boundary without corruption", () => {
    const len = 0x8000 + 123;
    const data = new Uint8Array(len);
    for (let i = 0; i < len; i++) data[i] = i % 251;
    const roundTripped = base64ToBytes(bytesToBase64(data));
    expect(roundTripped.length).toBe(len);
    expect(roundTripped).toEqual(data);
  });

  it("preserves every byte value across the full 0-255 range", () => {
    const data = new Uint8Array(256);
    for (let i = 0; i < 256; i++) data[i] = i;
    const roundTripped = base64ToBytes(bytesToBase64(data));
    expect(roundTripped.length).toBe(256);
    expect(roundTripped).toEqual(data);
  });

  it("round-trips a large byte pattern spanning multiple chunk boundaries", () => {
    const len = 3 * 0x8000 + 17;
    const data = new Uint8Array(len);
    for (let i = 0; i < len; i++) data[i] = (i * 31 + 7) & 0xff;
    const roundTripped = base64ToBytes(bytesToBase64(data));
    expect(roundTripped).toEqual(data);
  });

  it("produces standard base64 for a known vector", () => {
    expect(bytesToBase64(new Uint8Array([104, 101, 108, 108, 111]))).toBe("aGVsbG8=");
    expect(bytesToBase64(new Uint8Array(0))).toBe("");
  });
});

describe("isOffscreenRequest (document kind gate)", () => {
  const base = {
    channel: OFFSCREEN_CHANNEL,
    op: "preview",
    jobId: "job-1",
    bytes: "",
    name: "doc",
    mimeType: "application/pdf",
    enabledCategories: [],
    maxPages: 20,
  };

  it("accepts pdf, image, and docx preview requests", () => {
    for (const kind of ["pdf", "image", "docx"]) {
      expect(isOffscreenRequest({ ...base, kind })).toBe(true);
    }
  });

  it("accepts docx redact requests", () => {
    expect(
      isOffscreenRequest({ ...base, op: "redact", kind: "docx", boxes: [], padding: 4 })
    ).toBe(true);
  });

  it("rejects unknown document kinds", () => {
    expect(isOffscreenRequest({ ...base, kind: "xlsx" })).toBe(false);
  });

  it("rejects malformed requests", () => {
    expect(isOffscreenRequest(null)).toBe(false);
    expect(isOffscreenRequest({})).toBe(false);
    expect(isOffscreenRequest({ ...base, op: "explode" })).toBe(false);
  });
});