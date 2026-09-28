// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.

export interface MutationBatch {
  addedNodes: Node[];
  removedNodes: Node[];
  mutatedTextNodes: Text[];
  timestamp: number;
}

export type MutationCallback = (batch: MutationBatch) => void;

export interface MutationObserverHandle {
  disconnect(): void;
  pause(): void;
  resume(): void;
  isPaused(): boolean;
}

const DEBOUNCE_MS = 150;
const MAX_BATCH_SIZE = 500;

export function observeMutations(
  root: Node,
  callback: MutationCallback,
  options: { characterData?: boolean; childList?: boolean; subtree?: boolean } = {}
): MutationObserverHandle {
  const characterData = options.characterData ?? true;
  const childList = options.childList ?? true;
  const subtree = options.subtree ?? true;

  let paused = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingBatch: MutationBatch = { addedNodes: [], removedNodes: [], mutatedTextNodes: [], timestamp: 0 };

  const flush = () => {
    if (paused) return;
    if (pendingBatch.addedNodes.length === 0 && pendingBatch.removedNodes.length === 0 && pendingBatch.mutatedTextNodes.length === 0) {
      return;
    }
    const batch = { ...pendingBatch, timestamp: Date.now() };
    pendingBatch = { addedNodes: [], removedNodes: [], mutatedTextNodes: [], timestamp: 0 };
    callback(batch);
  };

  const scheduleFlush = () => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flush, DEBOUNCE_MS);
  };

  const observer = new MutationObserver((mutations) => {
    if (paused) return;

    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        for (const node of mutation.addedNodes) {
          if (pendingBatch.addedNodes.length < MAX_BATCH_SIZE) {
            pendingBatch.addedNodes.push(node);
          }
        }
        for (const node of mutation.removedNodes) {
          if (pendingBatch.removedNodes.length < MAX_BATCH_SIZE) {
            pendingBatch.removedNodes.push(node);
          }
        }
      } else if (mutation.type === "characterData") {
        const target = mutation.target;
        if (target.nodeType === Node.TEXT_NODE && pendingBatch.mutatedTextNodes.length < MAX_BATCH_SIZE) {
          pendingBatch.mutatedTextNodes.push(target as Text);
        }
      }
    }

    scheduleFlush();
  });

  observer.observe(root, {
    characterData,
    childList,
    subtree,
    characterDataOldValue: false,
  });

  return {
    disconnect() {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      observer.disconnect();
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    isPaused() {
      return paused;
    },
  };
}

export function shouldInvalidateBatch(batch: MutationBatch): boolean {
  return batch.addedNodes.length > 0 || batch.removedNodes.length > 0 || batch.mutatedTextNodes.length > 0;
}

export function getAffectedNodeIds(batch: MutationBatch, nodeIds: Map<string, Node>): Set<string> {
  const affected = new Set<string>();

  for (const node of batch.removedNodes) {
    for (const [id, n] of nodeIds) {
      if (n === node || node.contains(n)) {
        affected.add(id);
      }
    }
  }

  for (const node of batch.mutatedTextNodes) {
    for (const [id, n] of nodeIds) {
      if (n === node) {
        affected.add(id);
      }
    }
  }

  return affected;
}
