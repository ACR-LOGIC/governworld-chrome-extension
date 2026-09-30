// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { isRecord } from "./types.js";
import {
  ALL_CATEGORIES,
  isCategory,
  isProtectionMode,
  type FindingCategory,
  type ProtectionMode,
  type Settings,
} from "./settings.js";

/**
 * Enterprise (administrator) policy, delivered via `chrome.storage.managed`.
 *
 * Consumer/free users have no managed policy and control everything
 * themselves. When a managed policy exists, the administrator controls the
 * protection mode (unless `userCanDisable` is true) and mandates a minimum
 * set of detection categories the user cannot switch off. A UI toggle can
 * never override a locked administrative policy: the lock is enforced where
 * the decision is made, not just by disabling a checkbox.
 *
 * Fail-closed: a present-but-invalid managed policy locks the UI and applies
 * maximum protection (always-on with every category) rather than silently
 * falling back to user control. A broken admin push must never read as
 * "unmanaged".
 */

export interface EnterprisePolicy {
  /** True when any managed policy object was present. */
  managed: boolean;
  /** False when the managed object failed validation (fail-closed applies). */
  valid: boolean;
  /** Enforced mode when locked. */
  protectionMode: ProtectionMode;
  /** When false, the user cannot change the mode or mandated categories. */
  userCanDisable: boolean;
  /** Categories the user cannot disable. */
  enforcedCategories: FindingCategory[];
}

export const NO_ENTERPRISE_POLICY: EnterprisePolicy = {
  managed: false,
  valid: true,
  protectionMode: "this-tab",
  userCanDisable: true,
  enforcedCategories: [],
};

/** Maximum-protection fallback for a present-but-invalid managed policy. */
export const FAIL_CLOSED_ENTERPRISE_POLICY: EnterprisePolicy = {
  managed: true,
  valid: false,
  protectionMode: "always-on",
  userCanDisable: false,
  enforcedCategories: [...ALL_CATEGORIES],
};

export function parseEnterprisePolicy(raw: unknown): EnterprisePolicy {
  if (raw === null || raw === undefined) return { ...NO_ENTERPRISE_POLICY };
  if (!isRecord(raw)) return { ...FAIL_CLOSED_ENTERPRISE_POLICY };
  // An explicitly empty object is a valid "no opinion" policy, not corruption.
  const mode = raw.protectionMode === undefined
    ? "this-tab"
    : isProtectionMode(raw.protectionMode)
      ? raw.protectionMode
      : null;
  if (mode === null) return { ...FAIL_CLOSED_ENTERPRISE_POLICY };
  if (raw.userCanDisable !== undefined && typeof raw.userCanDisable !== "boolean") {
    return { ...FAIL_CLOSED_ENTERPRISE_POLICY };
  }
  let enforced: FindingCategory[] = [];
  if (raw.enforcedCategories !== undefined) {
    if (!Array.isArray(raw.enforcedCategories)) return { ...FAIL_CLOSED_ENTERPRISE_POLICY };
    const seen = new Set<FindingCategory>();
    for (const entry of raw.enforcedCategories) {
      if (!isCategory(entry)) return { ...FAIL_CLOSED_ENTERPRISE_POLICY };
      seen.add(entry);
    }
    enforced = [...seen];
  }
  return {
    managed: true,
    valid: true,
    protectionMode: mode,
    userCanDisable: raw.userCanDisable ?? false,
    enforcedCategories: enforced,
  };
}

export async function loadEnterprisePolicy(): Promise<EnterprisePolicy> {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.managed) {
      const raw = await chrome.storage.managed.get(null);
      return parseEnterprisePolicy(raw && Object.keys(raw).length > 0 ? raw : null);
    }
  } catch {
    // Managed storage unreadable: treat as unmanaged rather than locking the
    // user out on a storage fault. Enforcement still follows user settings.
  }
  return { ...NO_ENTERPRISE_POLICY };
}

export interface EffectiveProtection {
  /** Resolved coverage mode after enterprise policy. */
  mode: ProtectionMode;
  /** True when the user must not be offered a way to change the mode. */
  locked: boolean;
  managed: boolean;
  /** User categories plus admin-mandated ones (admin set can only add). */
  enabledCategories: FindingCategory[];
  /** Categories the UI must render disabled. */
  lockedCategories: FindingCategory[];
}

/**
 * Resolve what actually enforces. The enterprise policy can only add
 * protection relative to user settings, never remove it: a user who enables
 * more than the admin requires keeps the wider coverage.
 */
export function resolveEffectiveProtection(
  settings: Settings,
  policy: EnterprisePolicy
): EffectiveProtection {
  const enforced = new Set<FindingCategory>(policy.enforcedCategories);
  const enabled = new Set<FindingCategory>([...settings.enabledCategories, ...enforced]);
  if (!policy.managed) {
    return {
      mode: settings.protectionMode,
      locked: false,
      managed: false,
      enabledCategories: [...enabled],
      lockedCategories: [],
    };
  }
  if (!policy.userCanDisable) {
    // Locked: the admin mode is a floor, never a ceiling. An admin "off" is
    // explicit and wins outright; otherwise the wider of the admin and user
    // modes enforces, so a user who enables more keeps the wider coverage.
    const adminMode = policy.protectionMode;
    if (adminMode === "off") {
      return {
        mode: "off",
        locked: true,
        managed: true,
        enabledCategories: [...enforced],
        lockedCategories: [...enforced],
      };
    }
    const rank: Record<ProtectionMode, number> = { off: 0, "this-tab": 1, "always-on": 2 };
    const userMode = settings.protectionMode;
    return {
      mode: rank[userMode] >= rank[adminMode] ? userMode : adminMode,
      locked: true,
      managed: true,
      enabledCategories: [...enabled],
      lockedCategories: [...enforced],
    };
  }
  return {
    mode: settings.protectionMode,
    locked: false,
    managed: true,
    enabledCategories: [...enabled],
    lockedCategories: [...enforced],
  };
}

/** Load settings + managed policy together and resolve the live protection. */
export async function loadEffectiveProtection(
  loadSettings: () => Promise<Settings>
): Promise<{ settings: Settings; policy: EnterprisePolicy; effective: EffectiveProtection }> {
  const [settings, policy] = await Promise.all([loadSettings(), loadEnterprisePolicy()]);
  return { settings, policy, effective: resolveEffectiveProtection(settings, policy) };
}
