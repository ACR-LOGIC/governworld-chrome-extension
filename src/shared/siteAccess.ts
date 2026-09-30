// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { canRegisterContentScripts } from "./platform.js";
import type { ProtectionMode } from "./settings.js";

/**
 * Always-on site access: what makes automatic coverage technically real.
 *
 * THIS TAB needs nothing beyond activeTab (the user authorizes each tab by
 * invoking the extension there). ALWAYS ON additionally needs BOTH:
 *
 * 1. Optional site access granted at runtime (`chrome.permissions` for
 *    http/https origins). Declared as `optional_host_permissions`, so install
 *    grants nothing and the user can revoke at any time.
 * 2. A registration API (`chrome.scripting.registerContentScripts`,
 *    Chromium 120+). Without it there is nowhere to persist the "every tab"
 *    part across restarts and new tabs.
 *
 * If either is missing, always-on is a *request*, not a state, and every
 * surface must say so. Claiming "Protection Active" with neither is the exact
 * false-confidence failure this module exists to prevent.
 */

export const ALWAYS_ON_ORIGINS = ["http://*/*", "https://*/*"] as const;

/** Registration entry the service worker installs when always-on is armed. */
export const ALWAYS_ON_SCRIPT_ID = "governworld-always-on";

export interface AlwaysOnCapability {
  /** chrome.scripting.registerContentScripts exists and is callable. */
  canRegisterContentScripts: boolean;
  /** The user granted optional site access (still valid, not revoked). */
  siteAccessGranted: boolean;
}

export function shouldRegisterAlwaysOn(mode: ProtectionMode, capability: AlwaysOnCapability): boolean {
  return mode === "always-on" && capability.canRegisterContentScripts && capability.siteAccessGranted;
}

export type ProtectionDisplayState =
  | "off"
  | "this-tab"
  | "always-on-active"
  | "always-on-waiting-access";

/**
 * The single honest status. "always-on-active" requires proof (registration
 * possible AND access granted); every other combination names the gap.
 */
export function describeProtectionState(
  mode: ProtectionMode,
  capability: AlwaysOnCapability
): ProtectionDisplayState {
  if (mode === "off") return "off";
  if (mode !== "always-on") return "this-tab";
  return shouldRegisterAlwaysOn(mode, capability) ? "always-on-active" : "always-on-waiting-access";
}

export async function queryAlwaysOnCapability(): Promise<AlwaysOnCapability> {
  const canRegister = canRegisterContentScripts();
  let granted = false;
  try {
    const permissions = (globalThis as unknown as { chrome?: typeof chrome }).chrome?.permissions;
    if (permissions?.contains) {
      granted = await permissions.contains({ origins: [...ALWAYS_ON_ORIGINS] });
    }
  } catch {
    granted = false;
  }
  return { canRegisterContentScripts: canRegister, siteAccessGranted: granted };
}
