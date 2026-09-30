// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Protection modes + enterprise policy: the resolution rules that decide what
// enforces, independent of any DOM.
import { describe, expect, it } from "vitest";
import {
  ALL_CATEGORIES,
  DEFAULT_SETTINGS,
  normalizeSettings,
} from "../src/shared/settings.js";
import {
  NO_ENTERPRISE_POLICY,
  parseEnterprisePolicy,
  resolveEffectiveProtection,
} from "../src/shared/enterprisePolicy.js";
import {
  describeProtectionState,
  shouldRegisterAlwaysOn,
} from "../src/shared/siteAccess.js";

describe("protectionMode settings", () => {
  it("defaults to this-tab with the guard enabled", () => {
    expect(DEFAULT_SETTINGS.protectionMode).toBe("this-tab");
    expect(DEFAULT_SETTINGS.pasteGuardEnabled).toBe(true);
  });

  it("migrates the legacy boolean to a mode", () => {
    expect(normalizeSettings({ pasteGuardEnabled: false }).protectionMode).toBe("off");
    expect(normalizeSettings({ pasteGuardEnabled: false }).pasteGuardEnabled).toBe(false);
    expect(normalizeSettings({ pasteGuardEnabled: true }).protectionMode).toBe("this-tab");
    expect(normalizeSettings({}).protectionMode).toBe("this-tab");
    expect(normalizeSettings({}).pasteGuardEnabled).toBe(true);
  });

  it("keeps an explicit mode and rejects an invalid one", () => {
    expect(normalizeSettings({ protectionMode: "always-on" }).protectionMode).toBe("always-on");
    expect(normalizeSettings({ protectionMode: "always-on" }).pasteGuardEnabled).toBe(true);
    expect(normalizeSettings({ protectionMode: "everywhere" }).protectionMode).toBe("this-tab");
    expect(normalizeSettings({ protectionMode: "off" }).pasteGuardEnabled).toBe(false);
  });
});

describe("enterprise policy parsing", () => {
  it("treats absent policy as unmanaged consumer control", () => {
    expect(parseEnterprisePolicy(null)).toEqual(NO_ENTERPRISE_POLICY);
    expect(parseEnterprisePolicy(undefined)?.managed).toBe(false);
  });

  it("accepts a valid managed policy", () => {
    const p = parseEnterprisePolicy({
      protectionMode: "always-on",
      userCanDisable: false,
      enforcedCategories: ["ssn", "medical_record_number"],
    });
    expect(p).toMatchObject({
      managed: true,
      valid: true,
      protectionMode: "always-on",
      userCanDisable: false,
      enforcedCategories: ["ssn", "medical_record_number"],
    });
  });

  it("accepts an empty object as a no-opinion policy", () => {
    const p = parseEnterprisePolicy({});
    expect(p.managed).toBe(true);
    expect(p.valid).toBe(true);
    expect(p.enforcedCategories).toEqual([]);
  });

  it("fails closed on a present-but-invalid policy", () => {
    for (const bad of [
      "managed",
      42,
      { protectionMode: "everywhere" },
      { userCanDisable: "yes" },
      { enforcedCategories: ["not-a-category"] },
      { enforcedCategories: "ssn" },
    ]) {
      const p = parseEnterprisePolicy(bad);
      expect(p.managed).toBe(true);
      expect(p.valid).toBe(false);
      expect(p.userCanDisable).toBe(false);
      expect(p.protectionMode).toBe("always-on");
      expect(p.enforcedCategories).toEqual(ALL_CATEGORIES);
    }
  });
});

describe("effective protection resolution", () => {
  const user = (overrides: Record<string, unknown> = {}) =>
    normalizeSettings({ ...overrides });

  it("passes user settings through when unmanaged", () => {
    const eff = resolveEffectiveProtection(user({ protectionMode: "off" }), NO_ENTERPRISE_POLICY);
    expect(eff).toMatchObject({ mode: "off", locked: false, managed: false });
  });

  it("locks the admin mode and merges enforced categories additively", () => {
    const policy = parseEnterprisePolicy({
      protectionMode: "this-tab",
      userCanDisable: false,
      enforcedCategories: ["dea"],
    });
    const settings = user({ enabledCategories: ["email"] });
    const eff = resolveEffectiveProtection(settings, policy);
    expect(eff.locked).toBe(true);
    expect(eff.managed).toBe(true);
    expect(eff.enabledCategories).toEqual(expect.arrayContaining(["email", "dea"]));
    expect(eff.lockedCategories).toEqual(["dea"]);
  });

  it("treats the locked admin mode as a floor, never a ceiling", () => {
    const floor = parseEnterprisePolicy({ protectionMode: "this-tab", userCanDisable: false });
    // User off + admin this-tab -> admin floor wins.
    expect(resolveEffectiveProtection(user({ protectionMode: "off" }), floor).mode).toBe("this-tab");
    // User wider than admin -> user coverage preserved.
    expect(
      resolveEffectiveProtection(user({ protectionMode: "always-on" }), floor).mode
    ).toBe("always-on");
  });

  it("enforces admin always-on over a narrower user mode", () => {
    const policy = parseEnterprisePolicy({ protectionMode: "always-on", userCanDisable: false });
    expect(resolveEffectiveProtection(user({ protectionMode: "this-tab" }), policy).mode).toBe(
      "always-on"
    );
  });

  it("honors an explicit admin off", () => {
    const policy = parseEnterprisePolicy({ protectionMode: "off", userCanDisable: false });
    const eff = resolveEffectiveProtection(user({ protectionMode: "always-on" }), policy);
    expect(eff.mode).toBe("off");
    expect(eff.locked).toBe(true);
  });

  it("lets the user control the mode when userCanDisable, keeping mandated categories", () => {
    const policy = parseEnterprisePolicy({
      protectionMode: "always-on",
      userCanDisable: true,
      enforcedCategories: ["npi"],
    });
    const eff = resolveEffectiveProtection(user({ protectionMode: "off" }), policy);
    expect(eff.mode).toBe("off");
    expect(eff.locked).toBe(false);
    expect(eff.enabledCategories).toContain("npi");
    expect(eff.lockedCategories).toEqual(["npi"]);
  });
});

describe("always-on honesty", () => {
  const full = { canRegisterContentScripts: true, siteAccessGranted: true };

  it("registers only with mode + registration API + granted access", () => {
    expect(shouldRegisterAlwaysOn("always-on", full)).toBe(true);
    expect(shouldRegisterAlwaysOn("always-on", { ...full, siteAccessGranted: false })).toBe(false);
    expect(shouldRegisterAlwaysOn("always-on", { ...full, canRegisterContentScripts: false })).toBe(
      false
    );
    expect(shouldRegisterAlwaysOn("this-tab", full)).toBe(false);
    expect(shouldRegisterAlwaysOn("off", full)).toBe(false);
  });

  it("names the exact state, never claiming active without proof", () => {
    expect(describeProtectionState("off", full)).toBe("off");
    expect(describeProtectionState("this-tab", full)).toBe("this-tab");
    expect(describeProtectionState("always-on", full)).toBe("always-on-active");
    expect(describeProtectionState("always-on", { ...full, siteAccessGranted: false })).toBe(
      "always-on-waiting-access"
    );
    expect(
      describeProtectionState("always-on", { ...full, canRegisterContentScripts: false })
    ).toBe("always-on-waiting-access");
  });
});
