// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Dynamic capability discovery for GovernWorld connected features.
 */

import { GovernWorldApiClient } from "./client.js";
import type { CapabilitiesResponse, ExtensionCapability } from "./types.js";

export async function fetchCapabilities(
  client: GovernWorldApiClient,
  token?: string
): Promise<{ ok: true; capabilities: ExtensionCapability[] } | { ok: false; error: string }> {
  const result = await client.get<CapabilitiesResponse>("/api/v1/extension/capabilities", { token });

  if (!result.ok) {
    return { ok: false, error: result.error.user_message };
  }

  return { ok: true, capabilities: result.data.capabilities };
}

export function hasCapability(
  availableCapabilities: ExtensionCapability[] | undefined,
  requiredCapability: ExtensionCapability
): boolean {
  if (!availableCapabilities || !Array.isArray(availableCapabilities)) return false;
  return availableCapabilities.includes(requiredCapability);
}
