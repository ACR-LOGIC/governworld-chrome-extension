// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Authentication management for GovernWorld control-plane connection.
 * Short-lived bearer credentials live exclusively in chrome.storage.session (in-memory).
 * Non-secret connection metadata lives in chrome.storage.local.
 */

import { GovernWorldApiClient } from "./client.js";
import type { AuthTokens } from "./types.js";

const SESSION_KEY_AUTH_TOKENS = "gw_auth_tokens";
const LOCAL_KEY_AUTH_METADATA = "gw_auth_metadata";

export interface StoredAuthMetadata {
  connected: boolean;
  user_id?: string;
  user_email?: string;
  tenant_id?: string;
  tenant_name?: string;
  connected_at: string;
}

export async function getStoredTokens(): Promise<AuthTokens | null> {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.session) {
      const stored = await chrome.storage.session.get(SESSION_KEY_AUTH_TOKENS);
      const tokens = stored[SESSION_KEY_AUTH_TOKENS] as AuthTokens | undefined;
      if (tokens && typeof tokens.access_token === "string") {
        return tokens;
      }
    }
  } catch {
    // Session storage not available
  }
  return null;
}

export async function saveAuthSession(tokens: AuthTokens, metadata: StoredAuthMetadata): Promise<void> {
  if (typeof chrome !== "undefined") {
    if (chrome.storage?.session) {
      await chrome.storage.session.set({ [SESSION_KEY_AUTH_TOKENS]: tokens });
    }
    if (chrome.storage?.local) {
      await chrome.storage.local.set({ [LOCAL_KEY_AUTH_METADATA]: metadata });
    }
  }
}

export async function clearAuthSession(): Promise<void> {
  if (typeof chrome !== "undefined") {
    if (chrome.storage?.session) {
      await chrome.storage.session.remove(SESSION_KEY_AUTH_TOKENS);
    }
    if (chrome.storage?.local) {
      await chrome.storage.local.remove(LOCAL_KEY_AUTH_METADATA);
    }
  }
}

export async function getAuthMetadata(): Promise<StoredAuthMetadata | null> {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      const stored = await chrome.storage.local.get(LOCAL_KEY_AUTH_METADATA);
      return (stored[LOCAL_KEY_AUTH_METADATA] as StoredAuthMetadata) ?? null;
    }
  } catch {
    // Local storage not available
  }
  return null;
}

export function isTokenExpired(tokens: AuthTokens, clockSkewMs = 0): boolean {
  const now = Date.now() + clockSkewMs;
  // Expire 30 seconds early as a safety buffer
  return now >= tokens.expires_at - 30_000;
}

export async function refreshAccessToken(
  client: GovernWorldApiClient,
  refreshToken: string
): Promise<{ ok: true; tokens: AuthTokens } | { ok: false; error: string }> {
  const result = await client.post<AuthTokens>("/api/v1/extension/auth/refresh", {
    refresh_token: refreshToken,
  });

  if (!result.ok) {
    await clearAuthSession();
    return { ok: false, error: result.error.user_message };
  }

  const tokens = result.data;
  const now = Date.now();
  const normalizedTokens: AuthTokens = {
    ...tokens,
    expires_at: tokens.expires_at || now + (tokens.expires_in || 3600) * 1000,
  };

  const existingMeta = await getAuthMetadata();
  if (existingMeta) {
    await saveAuthSession(normalizedTokens, existingMeta);
  }

  return { ok: true, tokens: normalizedTokens };
}

export async function logout(client: GovernWorldApiClient): Promise<void> {
  const tokens = await getStoredTokens();
  if (tokens?.access_token) {
    // Notify server of revocation (fire-and-forget)
    void client.post("/api/v1/extension/auth/logout", {}, { token: tokens.access_token }).catch(() => undefined);
  }
  await clearAuthSession();
}
