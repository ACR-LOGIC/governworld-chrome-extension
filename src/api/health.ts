// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Lightweight health, version compatibility, and kill-switch inspection.
 * Requires zero sensitive content or document uploads.
 */

import { GovernWorldApiClient } from "./client.js";
import { CURRENT_EXTENSION_VERSION, semverGte } from "./config.js";
import type { HealthCheckResponse, KillSwitchStatus } from "./types.js";

export interface HealthStatusResult {
  reachable: boolean;
  compatible: boolean;
  killSwitch: KillSwitchStatus;
  clockSkewMs: number;
  serverTime?: string;
  apiVersion?: string;
  minExtensionVersion?: string;
  error?: string;
}

export async function checkHealth(client: GovernWorldApiClient): Promise<HealthStatusResult> {
  const result = await client.get<HealthCheckResponse>("/api/v1/extension/health");

  if (!result.ok) {
    return {
      reachable: false,
      compatible: true,
      killSwitch: "ENABLED",
      clockSkewMs: 0,
      error: result.error.user_message,
    };
  }

  const data = result.data;
  const serverTimeMs = data.server_time ? new Date(data.server_time).getTime() : Date.now();
  const clockSkewMs = serverTimeMs - Date.now();

  const isCompatible = data.min_extension_version
    ? semverGte(CURRENT_EXTENSION_VERSION, data.min_extension_version)
    : true;

  return {
    reachable: true,
    compatible: isCompatible,
    killSwitch: data.kill_switch || "ENABLED",
    clockSkewMs,
    serverTime: data.server_time,
    apiVersion: data.api_version,
    minExtensionVersion: data.min_extension_version,
  };
}
