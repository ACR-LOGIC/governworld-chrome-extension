// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Server-enforced entitlements client.
 * UI checks are purely for presentation; backend authoritatively enforces authorization on operations.
 */

import { GovernWorldApiClient } from "./client.js";
import type { EntitlementsResponse } from "./types.js";

export async function fetchEntitlements(
  client: GovernWorldApiClient,
  token?: string
): Promise<{ ok: true; entitlements: EntitlementsResponse } | { ok: false; error: string }> {
  const result = await client.get<EntitlementsResponse>("/api/v1/extension/entitlements", { token });

  if (!result.ok) {
    return { ok: false, error: result.error.user_message };
  }

  return { ok: true, entitlements: result.data };
}

export function isEntitledTo(entitlements: EntitlementsResponse | null | undefined, feature: string): boolean {
  if (!entitlements || !Array.isArray(entitlements.features)) return false;
  return entitlements.features.includes(feature);
}
