// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Platform capability detection: gaps are detected at runtime and surfaced as
// explicit limitations, never silent dead features.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DOCUMENT_PIPELINE_UNAVAILABLE_MESSAGE,
  canRegisterContentScripts,
  hasManagedStorage,
  isDocumentPipelineSupported,
} from "../src/shared/platform.js";

describe("platform capabilities", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports no capabilities without a browser runtime", () => {
    vi.stubGlobal("chrome", undefined);
    expect(isDocumentPipelineSupported()).toBe(false);
    expect(canRegisterContentScripts()).toBe(false);
    expect(hasManagedStorage()).toBe(false);
  });

  it("detects an offscreen-capable browser", () => {
    vi.stubGlobal("chrome", { offscreen: { createDocument: async () => undefined } });
    expect(isDocumentPipelineSupported()).toBe(true);
    expect(canRegisterContentScripts()).toBe(false);
  });

  it("detects scripting registration and managed storage independently", () => {
    vi.stubGlobal("chrome", {
      scripting: { registerContentScripts: async () => undefined, unregisterContentScripts: async () => undefined },
      storage: { managed: { get: async () => ({}) } },
    });
    expect(canRegisterContentScripts()).toBe(true);
    expect(hasManagedStorage()).toBe(true);
    expect(isDocumentPipelineSupported()).toBe(false);
  });

  it("states the document limitation in plain language", () => {
    expect(DOCUMENT_PIPELINE_UNAVAILABLE_MESSAGE).toMatch(/offscreen-capable/i);
    expect(DOCUMENT_PIPELINE_UNAVAILABLE_MESSAGE).toMatch(/paste protection work fully/i);
  });
});
