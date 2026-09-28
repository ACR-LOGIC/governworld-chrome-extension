// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Logic rule submission client.
 * Submits metadata/specification representations ONLY.
 * Hard invariant: NEVER transmits raw user examples, document contents, OCR text, or PHI/PII.
 */

import { GovernWorldApiClient } from "./client.js";
import type { LogicSubmissionRequest, LogicSubmissionResponse } from "./types.js";

/**
 * Validates that a submission payload does not contain raw sensitive document contents.
 */
export function validateSubmissionPayload(req: LogicSubmissionRequest): { valid: boolean; error?: string } {
  if (!req.rule_name || !req.rule_name.trim()) {
    return { valid: false, error: "Rule name is required." };
  }
  if (!req.pattern || !req.pattern.trim()) {
    return { valid: false, error: "Regex pattern is required." };
  }
  if (!req.category || !req.category.trim()) {
    return { valid: false, error: "Category is required." };
  }

  // Verify pattern is valid regex
  try {
    new RegExp(req.pattern);
  } catch {
    return { valid: false, error: "Invalid regular expression pattern." };
  }

  return { valid: true };
}

/**
 * Submits an authorized logic rule specification to the GovernWorld review pipeline.
 */
export async function submitLogic(
  client: GovernWorldApiClient,
  submission: LogicSubmissionRequest,
  token?: string
): Promise<{ ok: true; response: LogicSubmissionResponse } | { ok: false; error: string }> {
  const check = validateSubmissionPayload(submission);
  if (!check.valid) {
    return { ok: false, error: check.error ?? "Invalid submission" };
  }

  const result = await client.post<LogicSubmissionResponse>(
    "/api/v1/extension/submissions",
    {
      rule_name: submission.rule_name.trim(),
      category: submission.category.trim(),
      pattern: submission.pattern.trim(),
      cues: Array.isArray(submission.cues) ? submission.cues.map((c) => c.trim()).filter(Boolean) : [],
      description: submission.description ? submission.description.trim() : "",
      organization_approved: submission.organization_approved ?? false,
    },
    { token, idempotencyKey: crypto.randomUUID() }
  );

  if (!result.ok) {
    return { ok: false, error: result.error.user_message };
  }

  return { ok: true, response: result.data };
}
