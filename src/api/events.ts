// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Safe audit event dispatcher.
 * Only transmits non-sensitive diagnostic/compliance metadata.
 * Invariant: Never captures or forwards raw PHI/PII, OCR text, document contents, or sensitive prompts.
 */

import { GovernWorldApiClient } from "./client.js";
import { getInstallationId, CURRENT_EXTENSION_VERSION } from "./config.js";
import type { SafeAuditEventPayload } from "./types.js";

export async function reportAuditEvent(
  client: GovernWorldApiClient,
  event: Omit<SafeAuditEventPayload, "installation_id" | "extension_version" | "event_id">,
  token?: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const installationId = await getInstallationId();

  const payload: SafeAuditEventPayload = {
    event_id: crypto.randomUUID(),
    timestamp: event.timestamp || new Date().toISOString(),
    installation_id: installationId,
    tenant_id: event.tenant_id,
    user_id: event.user_id,
    event_type: event.event_type,
    policy_id: event.policy_id,
    policy_version: event.policy_version,
    operation_result: event.operation_result,
    request_id: event.request_id,
    extension_version: CURRENT_EXTENSION_VERSION,
  };

  const result = await client.post<{ success: boolean }>("/api/v1/extension/events", payload, {
    token,
    idempotencyKey: payload.event_id,
  });

  if (!result.ok) {
    return { ok: false, error: result.error.user_message };
  }

  return { ok: true };
}
