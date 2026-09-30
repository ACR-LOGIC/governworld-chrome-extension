// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Always-on distribution: the worker reconciles the persisted registration
// with the resolved mode and never throws, on any platform shape.
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncSiteProtection } from "../src/service-worker/siteProtection.js";

describe("syncSiteProtection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does nothing without a scripting registration API", async () => {
    const register = vi.fn();
    vi.stubGlobal("chrome", {
      scripting: {},
      storage: {
        local: { get: async () => ({}) },
        managed: { get: async () => ({}) },
      },
      permissions: { contains: async () => true },
    });
    await expect(syncSiteProtection()).resolves.toBeUndefined();
    expect(register).not.toHaveBeenCalled();
  });

  it("does not register when the mode is not always-on", async () => {
    const register = vi.fn();
    const unregister = vi.fn();
    vi.stubGlobal("chrome", {
      scripting: {
        registerContentScripts: register,
        unregisterContentScripts: unregister,
      },
      storage: {
        local: { get: async () => ({ settings: { protectionMode: "this-tab" } }) },
        managed: { get: async () => ({}) },
      },
      permissions: { contains: async () => true },
    });
    await syncSiteProtection();
    expect(register).not.toHaveBeenCalled();
  });

  it("registers when always-on is selected and the grant is held", async () => {
    const register = vi.fn();
    vi.stubGlobal("chrome", {
      scripting: {
        registerContentScripts: register,
        unregisterContentScripts: vi.fn(),
        getRegisteredContentScripts: async () => [],
      },
      storage: {
        local: { get: async () => ({ settings: { protectionMode: "always-on" } }) },
        managed: { get: async () => ({}) },
      },
      permissions: { contains: async () => true },
    });
    await syncSiteProtection();
    expect(register).toHaveBeenCalledTimes(1);
    const scripts = register.mock.calls[0][0] as Array<{ id: string; js: string[] }>;
    expect(scripts[0].id).toBe("governworld-always-on");
    expect(scripts[0].js).toContain("content.js");
  });

  it("removes a stale registration after opt-out", async () => {
    const unregister = vi.fn();
    vi.stubGlobal("chrome", {
      scripting: {
        registerContentScripts: vi.fn(),
        unregisterContentScripts: unregister,
        getRegisteredContentScripts: async () => [{ id: "governworld-always-on" }],
      },
      storage: {
        local: { get: async () => ({ settings: { protectionMode: "this-tab" } }) },
        managed: { get: async () => ({}) },
      },
      permissions: { contains: async () => false },
    });
    await syncSiteProtection();
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it("survives a missing chrome runtime entirely", async () => {
    vi.stubGlobal("chrome", undefined);
    await expect(syncSiteProtection()).resolves.toBeUndefined();
  });
});
