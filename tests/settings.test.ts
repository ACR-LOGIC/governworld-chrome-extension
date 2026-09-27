// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect } from "vitest";
import {
  normalizeSettings,
  isCloudAllowed,
  isCategoryEnabled,
  isHttpsOrigin,
  isAllowedGatewayOrigin,
  isCategory,
  ALL_CATEGORIES,
  DEFAULT_SETTINGS,
  PRESET_CATEGORIES,
} from "../src/shared/settings.js";

describe("category surface", () => {
  it("exposes the hardened PHI identifiers to users", () => {
    for (const c of ["npi", "dea", "mbi"]) {
      expect(ALL_CATEGORIES).toContain(c);
      expect(DEFAULT_SETTINGS.enabledCategories).toContain(c);
      expect(PRESET_CATEGORIES.hipaa).toContain(c);
    }
  });

  it("exposes the secrets category and the developer preset", () => {
    expect(ALL_CATEGORIES).toContain("secrets");
    expect(DEFAULT_SETTINGS.enabledCategories).toContain("secrets");
    expect(PRESET_CATEGORIES.developer).toContain("secrets");
    expect(PRESET_CATEGORIES.hipaa).not.toContain("secrets");
  });

  it("isCategory accepts every ALL_CATEGORIES value", () => {
    for (const c of ALL_CATEGORIES) {
      expect(isCategory(c)).toBe(true);
    }
  });
});

describe("normalizeSettings", () => {
  it("returns defaults for garbage input", () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings("nope")).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it("coerces mode to local unless explicitly cloud", () => {
    expect(normalizeSettings({ mode: "cloud" }).mode).toBe("cloud");
    expect(normalizeSettings({ mode: "surfing" }).mode).toBe("local");
  });

  it("drops unknown categories from enabledCategories", () => {
    const s = normalizeSettings({ enabledCategories: ["email", "not-a-category"] });
    expect(s.enabledCategories).toEqual(["email"]);
  });

  it("sanitizes numeric limits", () => {
    const s = normalizeSettings({ maxVisibleChars: -5, maxNodeChars: "x", maskPadding: 100 });
    expect(s.maxVisibleChars).toBe(DEFAULT_SETTINGS.maxVisibleChars);
    expect(s.maxNodeChars).toBe(DEFAULT_SETTINGS.maxNodeChars);
    expect(s.maskPadding).toBe(100);
  });

  it("never persists a raw-content field", () => {
    const s = normalizeSettings({ mode: "cloud", rawScanText: "jane@example.com", findings: [{ value: "secret" }] }) as unknown as Record<string, unknown>;
    expect(s.rawScanText).toBeUndefined();
    expect(s.findings).toBeUndefined();
  });
});

describe("isCloudAllowed (consent gate)", () => {
  it("denies cloud in local-only mode", () => {
    expect(isCloudAllowed(normalizeSettings({ mode: "local", gatewayOrigin: "https://gw.example.com" }))).toBe(false);
  });

  it("denies cloud when no gateway origin is configured", () => {
    expect(isCloudAllowed(normalizeSettings({ mode: "cloud", gatewayOrigin: null }))).toBe(false);
  });

  it("allows cloud only when both conditions hold", () => {
    expect(isCloudAllowed(normalizeSettings({ mode: "cloud", gatewayOrigin: "https://api.governworld.acrlogic.com" }))).toBe(true);
  });

  it("is disabled by default", () => {
    expect(isCloudAllowed(DEFAULT_SETTINGS)).toBe(false);
  });
});

describe("isCategoryEnabled", () => {
  it("respects the enabled set", () => {
    const s = normalizeSettings({ enabledCategories: ["email", "ssn"] });
    expect(isCategoryEnabled(s, "email")).toBe(true);
    expect(isCategoryEnabled(s, "payment_card")).toBe(false);
  });
});

describe("isHttpsOrigin (gateway origin validation)", () => {
  it("accepts a plain https origin", () => {
    expect(isHttpsOrigin("https://gw.example.com")).toBe(true);
    expect(isHttpsOrigin("https://gw.example.com/")).toBe(true);
  });

  it("rejects non-https and malformed origins", () => {
    expect(isHttpsOrigin("http://gw.example.com")).toBe(false);
    expect(isHttpsOrigin("javascript:alert(1)")).toBe(false);
    expect(isHttpsOrigin("gw.example.com")).toBe(false);
    expect(isHttpsOrigin("https:///path")).toBe(false);
    expect(isHttpsOrigin("")).toBe(false);
  });

  it("rejects origins carrying a path, query, or fragment", () => {
    expect(isHttpsOrigin("https://gw.example.com/api")).toBe(false);
    expect(isHttpsOrigin("https://gw.example.com?x=1")).toBe(false);
    expect(isHttpsOrigin("https://gw.example.com/#top")).toBe(false);
  });

  it("rejects embedded userinfo credentials", () => {
    expect(isHttpsOrigin("https://user:pass@gw.example.com")).toBe(false);
  });

  it("normalizes maskPlaceholders as an opt-in boolean", () => {
    expect(normalizeSettings({}).maskPlaceholders).toBe(false);
    expect(normalizeSettings({ maskPlaceholders: true }).maskPlaceholders).toBe(true);
    expect(normalizeSettings({ maskPlaceholders: "yes" }).maskPlaceholders).toBe(false);
    expect(DEFAULT_SETTINGS.maskPlaceholders).toBe(false);
  });

  it("normalizes an invalid gatewayOrigin to null (deny by default)", () => {
    expect(normalizeSettings({ mode: "cloud", gatewayOrigin: "http://gw.example.com" }).gatewayOrigin).toBeNull();
    expect(normalizeSettings({ mode: "cloud", gatewayOrigin: "not-a-url" }).gatewayOrigin).toBeNull();
  });
});

describe("isAllowedGatewayOrigin", () => {
  it("accepts only the GovernWorld API origin", () => {
    expect(isAllowedGatewayOrigin("https://api.governworld.acrlogic.com")).toBe(true);
    expect(isAllowedGatewayOrigin("https://community.governworld.acrlogic.com")).toBe(false);
    expect(isAllowedGatewayOrigin("https://governworld.vercel.app")).toBe(false);
  });

  it("rejects arbitrary and lookalike origins", () => {
    expect(isAllowedGatewayOrigin("https://evil.example.com")).toBe(false);
    expect(isAllowedGatewayOrigin("https://governworld.acrlogic.com.evil.example")).toBe(false);
    expect(isAllowedGatewayOrigin("https://evilgovernworld.acrlogic.com")).toBe(false);
  });
});