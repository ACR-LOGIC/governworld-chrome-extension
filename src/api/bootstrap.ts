// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Extension connected-state bootstrap handshake.
 * Establishes authenticated tenant relationship, discovers capabilities, and resolves entitlements.
 * Strictly adheres to server-side tenant resolution (no client default-tenant fallback).
 */

import { GovernWorldApiClient } from "./client.js";
import type { BootstrapResponse, TenantContext, ExtensionCapability, EntitlementsResponse, ConnectionState } from "./types.js";

const STORAGE_KEY_TENANT = "gw_tenant_context";
const STORAGE_KEY_CAPABILITIES = "gw_capabilities";
const STORAGE_KEY_ENTITLEMENTS = "gw_entitlements";

export interface BootstrapResult {
  success: boolean;
  connectionState: ConnectionState;
  tenant?: TenantContext;
  capabilities?: ExtensionCapability[];
  entitlements?: EntitlementsResponse;
  serverTime?: string;
  error?: string;
}

export async function performBootstrap(client: GovernWorldApiClient, token: string): Promise<BootstrapResult> {
  const result = await client.post<BootstrapResponse>(
    "/api/v1/extension/bootstrap",
    {},
    { token }
  );

  if (!result.ok) {
    if (result.error.code === "UNAUTHORIZED") {
      return { success: false, connectionState: "UNAUTHORIZED", error: result.error.user_message };
    }
    if (result.error.code === "FORBIDDEN") {
      return { success: false, connectionState: "FORBIDDEN", error: result.error.user_message };
    }
    return { success: false, connectionState: "SERVER_ERROR", error: result.error.user_message };
  }

  const data = result.data;
  if (!data) {
    return { success: false, connectionState: "SERVER_ERROR", error: "Empty bootstrap response." };
  }

  // Kill switch check
  if (data.kill_switch === "DISABLED") {
    return {
      success: false,
      connectionState: "DISABLED",
      error: "Cloud connectivity is currently disabled by GovernWorld security policy. Local protection remains active.",
    };
  }

  // Strict server-side tenant validation: No unverified or "default" tenant allowed
  if (!data.tenant || !data.tenant.tenant_id || !data.tenant.verified || data.tenant.tenant_id.toLowerCase() === "default") {
    return {
      success: false,
      connectionState: "TENANT_UNRESOLVED",
      error: "Tenant identity could not be verified by GovernWorld backend. Connection denied.",
    };
  }

  // Cache resolved context locally
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.set({
      [STORAGE_KEY_TENANT]: data.tenant,
      [STORAGE_KEY_CAPABILITIES]: data.capabilities,
      [STORAGE_KEY_ENTITLEMENTS]: data.entitlements,
    });
  }

  return {
    success: true,
    connectionState: "CONNECTED",
    tenant: data.tenant,
    capabilities: data.capabilities,
    entitlements: data.entitlements,
    serverTime: data.server_time,
  };
}

export async function getCachedTenant(): Promise<TenantContext | null> {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    const res = await chrome.storage.local.get(STORAGE_KEY_TENANT);
    return (res[STORAGE_KEY_TENANT] as TenantContext) ?? null;
  }
  return null;
}

export async function getCachedCapabilities(): Promise<ExtensionCapability[]> {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    const res = await chrome.storage.local.get(STORAGE_KEY_CAPABILITIES);
    return (res[STORAGE_KEY_CAPABILITIES] as ExtensionCapability[]) ?? [];
  }
  return [];
}

export async function getCachedEntitlements(): Promise<EntitlementsResponse | null> {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    const res = await chrome.storage.local.get(STORAGE_KEY_ENTITLEMENTS);
    return (res[STORAGE_KEY_ENTITLEMENTS] as EntitlementsResponse) ?? null;
  }
  return null;
}
