// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Data contracts and connection state definitions for GovernWorld API integration.
 *
 * Core architectural principle:
 * LOCAL-FIRST BY DEFAULT. CLOUD CONNECTIVITY IS OPTIONAL AND CAPABILITY-DRIVEN.
 *
 * All cloud requests carry zero raw sensitive content (PHI, PII, OCR text, document
 * contents, prompts).
 */

export type ConnectionState =
  | "LOCAL_ONLY"
  | "CONNECTING"
  | "CONNECTED"
  | "AUTHENTICATING"
  | "AUTHENTICATION_REQUIRED"
  | "OFFLINE"
  | "UNAUTHORIZED"
  | "TENANT_UNRESOLVED"
  | "FORBIDDEN"
  | "SERVER_ERROR"
  | "INCOMPATIBLE_VERSION"
  | "DISABLED";

export type KillSwitchStatus = "ENABLED" | "DEGRADED" | "DISABLED";

export interface HealthCheckResponse {
  status: "ok" | "degraded" | "incompatible";
  api_version: string;
  min_extension_version: string;
  server_time: string; // ISO 8601
  kill_switch: KillSwitchStatus;
}

export interface AuthTokens {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number; // seconds
  expires_at: number; // Unix timestamp in ms
}

export interface TenantContext {
  tenant_id: string;
  tenant_name: string;
  roles: string[];
  organization_id?: string;
  verified: boolean;
}

export type ExtensionCapability =
  | "policy_sync"
  | "cloud_monitoring"
  | "usage_metadata"
  | "logic_submission"
  | "community_logic_updates"
  | "organization_controls";

export interface CapabilitiesResponse {
  capabilities: ExtensionCapability[];
}

export interface EntitlementsResponse {
  tier: "free" | "pro" | "enterprise";
  features: string[];
  max_custom_rules?: number;
  expires_at?: string;
}

export interface PolicyRule {
  id: string;
  category: string;
  pattern: string;
  cues?: string[];
  confidence: number;
  description?: string;
}

export interface PolicyPackage {
  policy_id: string;
  policy_version: string;
  effective_at: string;
  expires_at?: string;
  policy_hash: string; // SHA-256 hex string
  rules: PolicyRule[];
}

export interface BootstrapResponse {
  server_time: string;
  api_version: string;
  min_extension_version: string;
  tenant: TenantContext;
  capabilities: ExtensionCapability[];
  entitlements: EntitlementsResponse;
  policy_metadata?: {
    policy_id: string;
    policy_version: string;
    policy_hash: string;
    effective_at: string;
    expires_at?: string;
  };
  kill_switch: KillSwitchStatus;
}

export interface LogicSubmissionRequest {
  rule_name: string;
  category: string;
  pattern: string;
  cues: string[];
  description: string;
  organization_approved?: boolean;
}

export interface LogicSubmissionResponse {
  submission_id: string; // e.g., "GW-SUB-123456"
  status: "pending_review" | "approved" | "rejected";
  submitted_at: string;
  rule_name: string;
}

export interface SafeAuditEventPayload {
  event_id: string;
  timestamp: string;
  installation_id: string;
  tenant_id?: string;
  user_id?: string;
  event_type: string;
  policy_id?: string;
  policy_version?: string;
  operation_result: "success" | "failure" | "denied";
  request_id: string;
  extension_version: string;
}

export interface ApiErrorDetails {
  code: string;
  user_message: string;
  status_code: number;
  request_id?: string;
}
