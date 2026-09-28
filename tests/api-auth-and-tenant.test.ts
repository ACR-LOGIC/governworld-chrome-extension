// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GovernWorldApiClient } from "../src/api/client.js";
import { performBootstrap } from "../src/api/bootstrap.js";
import { isTokenExpired } from "../src/api/auth.js";
import type { AuthTokens, BootstrapResponse } from "../src/api/types.js";

describe("API Authentication & Server-Side Tenant Resolution", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("successfully bootstraps an authenticated connection with server-verified tenant context", async () => {
    const mockBootstrap: BootstrapResponse = {
      server_time: new Date().toISOString(),
      api_version: "v1",
      min_extension_version: "0.1.0",
      tenant: {
        tenant_id: "org_acme_corp_123",
        tenant_name: "Acme Corp Healthcare",
        roles: ["compliance_officer", "editor"],
        verified: true,
      },
      capabilities: ["policy_sync", "logic_submission", "community_logic_updates"],
      entitlements: {
        tier: "enterprise",
        features: ["custom_rules", "policy_sync", "org_controls"],
      },
      kill_switch: "ENABLED",
    };

    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(mockBootstrap), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const client = new GovernWorldApiClient("https://api.governworld.com");
    const res = await performBootstrap(client, "valid_mock_token");

    expect(res.success).toBe(true);
    expect(res.connectionState).toBe("CONNECTED");
    expect(res.tenant?.tenant_id).toBe("org_acme_corp_123");
    expect(res.tenant?.verified).toBe(true);
    expect(res.capabilities).toContain("policy_sync");
    expect(res.entitlements?.tier).toBe("enterprise");
  });

  it("denies unverified tenants or missing tenant context (TENANT_UNRESOLVED)", async () => {
    const unverifiedBootstrap: BootstrapResponse = {
      server_time: new Date().toISOString(),
      api_version: "v1",
      min_extension_version: "0.1.0",
      tenant: {
        tenant_id: "org_unverified",
        tenant_name: "Unverified Org",
        roles: [],
        verified: false, // Server reports unverified
      },
      capabilities: [],
      entitlements: { tier: "free", features: [] },
      kill_switch: "ENABLED",
    };

    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(unverifiedBootstrap), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const client = new GovernWorldApiClient("https://api.governworld.com");
    const res = await performBootstrap(client, "token_unverified");

    expect(res.success).toBe(false);
    expect(res.connectionState).toBe("TENANT_UNRESOLVED");
    expect(res.error).toContain("Tenant identity could not be verified");
  });

  it("rejects 'default' or anonymous tenant fallbacks", async () => {
    const defaultTenantBootstrap: BootstrapResponse = {
      server_time: new Date().toISOString(),
      api_version: "v1",
      min_extension_version: "0.1.0",
      tenant: {
        tenant_id: "default",
        tenant_name: "Default Fallback",
        roles: [],
        verified: true,
      },
      capabilities: [],
      entitlements: { tier: "free", features: [] },
      kill_switch: "ENABLED",
    };

    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(defaultTenantBootstrap), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const client = new GovernWorldApiClient("https://api.governworld.com");
    const res = await performBootstrap(client, "token_default");

    expect(res.success).toBe(false);
    expect(res.connectionState).toBe("TENANT_UNRESOLVED");
  });

  it("handles token expiration with clock skew compensation", () => {
    const now = Date.now();
    const validTokens: AuthTokens = {
      access_token: "mock_access",
      token_type: "Bearer",
      expires_in: 3600,
      expires_at: now + 600_000, // 10 minutes in future
    };

    expect(isTokenExpired(validTokens)).toBe(false);

    const expiredTokens: AuthTokens = {
      access_token: "mock_access",
      token_type: "Bearer",
      expires_in: 3600,
      expires_at: now - 10_000, // expired 10s ago
    };

    expect(isTokenExpired(expiredTokens)).toBe(true);

    // Buffer expiration: expires within 20 seconds (safety margin is 30s)
    const nearExpiryTokens: AuthTokens = {
      access_token: "mock_access",
      token_type: "Bearer",
      expires_in: 3600,
      expires_at: now + 20_000,
    };
    expect(isTokenExpired(nearExpiryTokens)).toBe(true);
  });
});
