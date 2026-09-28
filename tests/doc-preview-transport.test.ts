// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Regression cover for the defect that let a page preview ride inside a runtime
// message: the Document Studio never opened because the worker broadcast a
// full-page base64 data URL in POPUP_DOC_STATE and validateMessage rejected the
// whole message with "Message exceeds size limit", which the popup drops
// silently. A page preview must be referenced by key, not inlined.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateMessage } from "../src/shared/messages.js";
import { MAX_MESSAGE_BYTES, type DocPageMeta } from "../src/shared/types.js";
import { PREVIEW_KEY_RE, isPreviewKey, previewKey } from "../src/shared/docStore.js";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(extRoot, p), "utf8");

const finding = {
  id: "doc:0:0",
  category: "ssn" as const,
  confidence: 0.93,
  source: "local-rules" as const,
  preview: "***-**-9999",
  nodeId: "doc:0",
  startOffset: 0,
  endOffset: 11,
  rects: [{ x: 10, y: 20, width: 100, height: 22 }],
  selected: true,
};

function docState(page: Partial<DocPageMeta>) {
  return {
    type: "POPUP_DOC_STATE",
    requestId: "r1",
    docId: "d1",
    name: "doc.png",
    fileKey: "key1",
    mimeType: "image/png",
    kind: "image",
    pages: [{ index: 0, widthPx: 1240, heightPx: 1754, previewKey: "key1::preview::0", findings: [finding], ...page }],
  };
}

describe("document page previews are referenced, not inlined", () => {
  it("accepts a POPUP_DOC_STATE whose page carries a preview key", () => {
    expect(validateMessage(docState({})).ok).toBe(true);
  });

  it("rejects a preview key that is not a well-formed store key", () => {
    for (const bad of ["../../secrets", "http://evil.example/pg.png", "", "key1::preview::x", "a".repeat(200)]) {
      expect(validateMessage(docState({ previewKey: bad })).ok, bad).toBe(false);
    }
  });

  it("keeps a realistic multi-page document state under the message size limit", () => {
    // 20 pages (MAX_DOC_PAGES) with several findings each must still fit, which is
    // only true because the images are referenced rather than embedded.
    const pages = Array.from({ length: 20 }, (_, i) => ({
      index: i,
      widthPx: 1240,
      heightPx: 1754,
      previewKey: previewKey("key1", i),
      findings: Array.from({ length: 6 }, (_, f) => ({ ...finding, id: `doc:${i}:${f}` })),
    }));
    const message = { ...docState({}), pages };
    expect(JSON.stringify(message).length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(validateMessage(message).ok).toBe(true);
  });

  it("documents the failure mode: an inlined data URL is rejected wholesale", () => {
    // Guards the diagnosis. If someone reinlines previews this must fail, and the
    // failure is total (the whole message is dropped, not just the field).
    const inlined = { ...docState({}), pages: [{ ...docState({}).pages[0], previewDataUrl: "data:image/png;base64," + "A".repeat(200_000) }] };
    expect(JSON.stringify(inlined).length).toBeGreaterThan(MAX_MESSAGE_BYTES);
  });

  it("derives and recognises preview keys", () => {
    const key = previewKey("abc-123", 7);
    expect(key).toBe("abc-123::preview::7");
    expect(isPreviewKey(key)).toBe(true);
    expect(PREVIEW_KEY_RE.test(key)).toBe(true);
  });

  it("no longer names previewDataUrl anywhere in the message path", () => {
    // The popup resolves previews through the shared store; the field must not
    // reappear in the wire types or the controller.
    for (const f of [
      "src/shared/types.ts",
      "src/shared/messages.ts",
      "src/document-pipeline/adapter.ts",
      "src/document-pipeline/impl.ts",
      "src/offscreen/offscreen.ts",
      "src/service-worker/documents.ts",
      "src/popup/popup.ts",
    ]) {
      expect(read(f), `${f} still references previewDataUrl`).not.toContain("previewDataUrl");
    }
  });
});
