// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect } from "vitest";
import {
  shouldInvalidateBatch,
  getAffectedNodeIds,
  type MutationBatch,
} from "../src/content/normalization/mutation.js";

function makeNode(): Node {
  return { nodeType: 1, firstChild: null, nextSibling: null } as unknown as Node;
}

function makeTextNode(): Text {
  return { nodeType: 3, firstChild: null, nextSibling: null } as unknown as Text;
}

describe("shouldInvalidateBatch", () => {
  it("returns false for empty batch", () => {
    const batch: MutationBatch = { addedNodes: [], removedNodes: [], mutatedTextNodes: [], timestamp: 0 };
    expect(shouldInvalidateBatch(batch)).toBe(false);
  });

  it("returns true when nodes are added", () => {
    const batch: MutationBatch = { addedNodes: [makeNode()], removedNodes: [], mutatedTextNodes: [], timestamp: 0 };
    expect(shouldInvalidateBatch(batch)).toBe(true);
  });

  it("returns true when nodes are removed", () => {
    const batch: MutationBatch = { addedNodes: [], removedNodes: [makeNode()], mutatedTextNodes: [], timestamp: 0 };
    expect(shouldInvalidateBatch(batch)).toBe(true);
  });

  it("returns true when text nodes are mutated", () => {
    const batch: MutationBatch = { addedNodes: [], removedNodes: [], mutatedTextNodes: [makeTextNode()], timestamp: 0 };
    expect(shouldInvalidateBatch(batch)).toBe(true);
  });
});

describe("getAffectedNodeIds", () => {
  it("returns empty set for empty batch", () => {
    const nodeIds = new Map<string, Node>();
    nodeIds.set("seg_0", makeTextNode());
    const batch: MutationBatch = { addedNodes: [], removedNodes: [], mutatedTextNodes: [], timestamp: 0 };
    const affected = getAffectedNodeIds(batch, nodeIds);
    expect(affected.size).toBe(0);
  });

  it("finds removed nodes", () => {
    const node = makeTextNode();
    const nodeIds = new Map<string, Node>();
    nodeIds.set("seg_0", node);
    const batch: MutationBatch = { addedNodes: [], removedNodes: [node], mutatedTextNodes: [], timestamp: 0 };
    const affected = getAffectedNodeIds(batch, nodeIds);
    expect(affected.has("seg_0")).toBe(true);
  });

  it("finds mutated text nodes", () => {
    const node = makeTextNode();
    const nodeIds = new Map<string, Node>();
    nodeIds.set("seg_0", node);
    const batch: MutationBatch = { addedNodes: [], removedNodes: [], mutatedTextNodes: [node], timestamp: 0 };
    const affected = getAffectedNodeIds(batch, nodeIds);
    expect(affected.has("seg_0")).toBe(true);
  });

  it("finds nodes contained in removed subtrees", () => {
    const parent = makeNode();
    const child = makeTextNode();
    (parent as unknown as { contains: (n: Node) => boolean }).contains = (n: Node) => n === child;
    const nodeIds = new Map<string, Node>();
    nodeIds.set("seg_0", child);
    const batch: MutationBatch = { addedNodes: [], removedNodes: [parent], mutatedTextNodes: [], timestamp: 0 };
    const affected = getAffectedNodeIds(batch, nodeIds);
    expect(affected.has("seg_0")).toBe(true);
  });
});
