// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { loadSettings } from "../shared/settings.js";
import { loadEnterprisePolicy, resolveEffectiveProtection } from "../shared/enterprisePolicy.js";
import {
  ALWAYS_ON_ORIGINS,
  ALWAYS_ON_SCRIPT_ID,
  queryAlwaysOnCapability,
  shouldRegisterAlwaysOn,
} from "../shared/siteAccess.js";

/**
 * Always-on distribution, owned by the service worker.
 *
 * THIS TAB needs no distribution work: the content script (with its paste
 * guard) is injected per user action via activeTab. ALWAYS ON means the
 * script must already be present on every visited page, across new tabs,
 * restarts, and navigations — which is what a persisted content-script
 * registration does.
 *
 * Registration is best-effort and capability-gated, never assumed:
 * - No `chrome.scripting.registerContentScripts` (older Chromium, Firefox,
 *   Safari) → nothing to persist with; always-on stays a request.
 * - No optional site access (never granted, denied, or revoked) → the
 *   registration would match nothing; it is removed rather than left to
 *   imply coverage.
 * - Managed-policy or settings change → re-evaluated, so disabling always-on
 *   actually unregisters (protection stops) instead of lingering.
 */

interface ScriptingWithRegistration {
  registerContentScripts?: (scripts: Array<Record<string, unknown>>) => Promise<void>;
  unregisterContentScripts?: (filter?: Record<string, unknown>) => Promise<void>;
}

function scripting(): ScriptingWithRegistration | null {
  try {
    const s = chrome.scripting as unknown as ScriptingWithRegistration | undefined;
    if (
      s &&
      typeof s.registerContentScripts === "function" &&
      typeof s.unregisterContentScripts === "function"
    ) {
      return s;
    }
  } catch {
    // ignore
  }
  return null;
}

async function isRegistered(): Promise<boolean> {
  const s = scripting();
  if (!s || typeof (s as { getRegisteredContentScripts?: unknown }).getRegisteredContentScripts !== "function") {
    return false;
  }
  try {
    const scripts = await (s as unknown as {
      getRegisteredContentScripts: (f: Record<string, unknown>) => Promise<Array<{ id: string }>>;
    }).getRegisteredContentScripts({ ids: [ALWAYS_ON_SCRIPT_ID] });
    return scripts.some((entry) => entry.id === ALWAYS_ON_SCRIPT_ID);
  } catch {
    return false;
  }
}

/**
 * Reconcile the persisted registration with the resolved protection mode.
 * Safe to call on startup, settings change, managed-policy change, and
 * permission grant/revoke. Never throws.
 */
export async function syncSiteProtection(): Promise<void> {
  try {
    const [settings, policy, capability] = await Promise.all([
      loadSettings(),
      loadEnterprisePolicy(),
      queryAlwaysOnCapability(),
    ]);
    const effective = resolveEffectiveProtection(settings, policy);
    const s = scripting();
    if (!s) return;
    if (shouldRegisterAlwaysOn(effective.mode, capability)) {
      try {
        await s.registerContentScripts?.([{
          id: ALWAYS_ON_SCRIPT_ID,
          matches: [...ALWAYS_ON_ORIGINS],
          js: ["content.js"],
          runAt: "document_start",
          allFrames: true,
          persistAcrossSessions: true,
        }]);
      } catch {
        // Registration rejected (e.g. permission revoked mid-call): the UI
        // re-derives state from capability, so a failed register reads as
        // "waiting for access", never "active".
      }
      return;
    }
    // Not wanted or not viable: remove any stale registration so protection
    // genuinely stops instead of lingering after the user opted out.
    try {
      if (await isRegistered()) {
        await s.unregisterContentScripts?.({ ids: [ALWAYS_ON_SCRIPT_ID] });
      }
    } catch {
      // ignore
    }
  } catch {
    // Housekeeping must never break the worker.
  }
}
