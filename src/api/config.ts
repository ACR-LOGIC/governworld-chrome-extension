// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Configuration and identity management for GovernWorld API integration.
 * Centralizes endpoints, installation identification, and transport security checks.
 */

export const DEFAULT_PROD_API_URL = "https://api.governworld.com";
export const DEFAULT_DEV_API_URL = "http://127.0.0.1:8000";
export const CURRENT_EXTENSION_VERSION = "0.1.1";

const STORAGE_KEY_API_URL = "gw_api_url";
const STORAGE_KEY_INSTALLATION_ID = "gw_installation_id";

/**
 * Validates that a candidate API URL is syntactically valid and satisfies transport security.
 * Production/remote endpoints MUST use HTTPS. Plaintext HTTP is allowed ONLY for localhost/127.0.0.1.
 */
export function validateApiUrl(rawUrl: string): { valid: boolean; normalizedUrl?: string; error?: string } {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { valid: false, error: "Invalid protocol. Only HTTPS (or HTTP for localhost) is supported." };
    }

    const isLocalhost =
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "::1" ||
      parsed.hostname.endsWith(".localhost");

    if (parsed.protocol === "http:" && !isLocalhost) {
      return {
        valid: false,
        error: "Insecure transport rejected: Production GovernWorld endpoints must use HTTPS/TLS.",
      };
    }

    // Strip trailing slash for consistency
    const normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
    return { valid: true, normalizedUrl: normalized };
  } catch {
    return { valid: false, error: "Malformed API URL." };
  }
}

/**
 * Returns the currently configured API base URL. Defaults to production HTTPS endpoint.
 */
export async function getApiUrl(): Promise<string> {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      const stored = await chrome.storage.local.get(STORAGE_KEY_API_URL);
      const url = stored[STORAGE_KEY_API_URL];
      if (typeof url === "string" && url.trim()) {
        const check = validateApiUrl(url);
        if (check.valid && check.normalizedUrl) return check.normalizedUrl;
      }
    }
  } catch {
    // Fall back to default
  }
  return DEFAULT_PROD_API_URL;
}

/**
 * Saves an API base URL into extension local storage after validation.
 */
export async function setApiUrl(url: string): Promise<{ success: boolean; error?: string }> {
  const check = validateApiUrl(url);
  if (!check.valid || !check.normalizedUrl) {
    return { success: false, error: check.error ?? "Invalid URL" };
  }
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.set({ [STORAGE_KEY_API_URL]: check.normalizedUrl });
  }
  return { success: true };
}

/**
 * Retrieves or generates a non-secret, persistent installation UUID.
 * Used exclusively for compatibility tracking and diagnostics. NEVER functions as an auth token.
 */
export async function getInstallationId(): Promise<string> {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      const stored = await chrome.storage.local.get(STORAGE_KEY_INSTALLATION_ID);
      const existing = stored[STORAGE_KEY_INSTALLATION_ID];
      if (typeof existing === "string" && existing.length === 36) {
        return existing;
      }
      const newId = crypto.randomUUID();
      await chrome.storage.local.set({ [STORAGE_KEY_INSTALLATION_ID]: newId });
      return newId;
    }
  } catch {
    // Fallback if storage unavailable
  }
  return "00000000-0000-0000-0000-000000000000";
}

/**
 * Simple semver comparison helper (current >= required).
 */
export function semverGte(current: string, required: string): boolean {
  const parse = (v: string) => v.split(".").map((n) => parseInt(n.replace(/\D.*$/, ""), 10) || 0);
  const [cMaj, cMin, cPat] = parse(current);
  const [rMaj, rMin, rPat] = parse(required);

  if (cMaj !== rMaj) return cMaj > rMaj;
  if (cMin !== rMin) return cMin > rMin;
  return cPat >= rPat;
}
