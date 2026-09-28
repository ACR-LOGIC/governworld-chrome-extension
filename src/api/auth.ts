// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Authentication management for GovernWorld control-plane connection.
 * Short-lived bearer credentials live exclusively in chrome.storage.session (in-memory).
 * Non-secret connection metadata lives in chrome.storage.local.
 */

import { GovernWorldApiClient } from "./client.js";
import { getApiUrl } from "./config.js";
import type { AuthTokens } from "./types.js";

const SESSION_KEY_AUTH_TOKENS = "gw_auth_tokens";
const LOCAL_KEY_AUTH_METADATA = "gw_auth_metadata";
const OAUTH_STATE_KEY = "gw_oauth_state";

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

let refreshInFlight: Promise<{ ok: true; tokens: AuthTokens } | { ok: false; error: string }> | null = null;

export async function refreshAccessToken(
  client: GovernWorldApiClient,
  refreshToken: string
): Promise<{ ok: true; tokens: AuthTokens } | { ok: false; error: string }> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
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
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

export async function logout(client: GovernWorldApiClient): Promise<void> {
  const tokens = await getStoredTokens();
  if (tokens?.access_token) {
    void client.post("/api/v1/extension/auth/logout", {}, { token: tokens.access_token }).catch(() => undefined);
  }
  await clearAuthSession();
}

export async function generateOAuthState(): Promise<string> {
  const state = crypto.randomUUID();
  if (typeof chrome !== "undefined" && chrome.storage?.session) {
    await chrome.storage.session.set({ [OAUTH_STATE_KEY]: state });
  }
  return state;
}

export async function verifyOAuthState(state: string): Promise<boolean> {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.session) {
      const stored = await chrome.storage.session.get(OAUTH_STATE_KEY);
      const expected = stored[OAUTH_STATE_KEY];
      if (expected === state) {
        await chrome.storage.session.remove(OAUTH_STATE_KEY);
        return true;
      }
    }
  } catch {
    // Session storage not available
  }
  return false;
}

export async function buildAuthorizeUrl(state: string): Promise<string> {
  const baseUrl = await getApiUrl();
  const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;
  const params = new URLSearchParams({
    response_type: "code",
    redirect_uri: redirectUri,
    state,
    client_id: "governworld-extension",
  });
  return `${baseUrl}/api/v1/extension/auth/authorize?${params.toString()}`;
}

export async function exchangeCodeForTokens(
  client: GovernWorldApiClient,
  code: string
): Promise<{ ok: true; tokens: AuthTokens } | { ok: false; error: string }> {
  const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;
  const result = await client.post<AuthTokens>("/api/v1/extension/auth/token", {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: "governworld-extension",
  });
  if (!result.ok) {
    return { ok: false, error: result.error.user_message };
  }
  const tokens = result.data;
  const now = Date.now();
  const normalized: AuthTokens = {
    ...tokens,
    expires_at: tokens.expires_at || now + (tokens.expires_in || 3600) * 1000,
  };
  return { ok: true, tokens: normalized };
}
