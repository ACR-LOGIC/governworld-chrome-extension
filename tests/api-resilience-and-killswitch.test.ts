// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GovernWorldApiClient } from "../src/api/client.js";
import { checkHealth } from "../src/api/health.js";
import { performBootstrap } from "../src/api/bootstrap.js";
import { semverGte } from "../src/api/config.js";

describe("API Resilience, Kill-Switch & Version Compatibility", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("handles emergency cloud kill-switch (DISABLED) safely while preserving local-only operation", async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      new Response(
        JSON.stringify({
          status: "ok",
          api_version: "v1",
          min_extension_version: "0.1.0",
          server_time: new Date().toISOString(),
          kill_switch: "DISABLED",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const client = new GovernWorldApiClient("https://api.governworld.com");
    const health = await checkHealth(client);

    expect(health.reachable).toBe(true);
    expect(health.killSwitch).toBe("DISABLED");

    // Bootstrap must immediately refuse connected activation when kill switch is active
    const bootstrap = await performBootstrap(client, "mock_token");
    expect(bootstrap.success).toBe(false);
    expect(bootstrap.connectionState).toBe("DISABLED");
    expect(bootstrap.error).toContain("disabled by GovernWorld security policy");
  });

  it("detects incompatible extension version and requires update without crashing local features", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "ok",
          api_version: "v2",
          min_extension_version: "2.0.0", // Higher than current 0.1.0
          server_time: new Date().toISOString(),
          kill_switch: "ENABLED",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const client = new GovernWorldApiClient("https://api.governworld.com");
    const health = await checkHealth(client);

    expect(health.reachable).toBe(true);
    expect(health.compatible).toBe(false);
  });

  it("semver comparison functions correctly", () => {
    expect(semverGte("0.1.0", "0.1.0")).toBe(true);
    expect(semverGte("0.2.0", "0.1.0")).toBe(true);
    expect(semverGte("1.0.0", "0.9.9")).toBe(true);
    expect(semverGte("0.1.0", "0.2.0")).toBe(false);
    expect(semverGte("0.1.0", "1.0.0")).toBe(false);
  });
});
