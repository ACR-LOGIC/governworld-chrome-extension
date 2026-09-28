// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Unified GovernWorld API Client and Control-Plane integration module.
 *
 * Core invariant:
 * LOCAL-FIRST BY DEFAULT. CLOUD CONNECTIVITY IS OPTIONAL AND CAPABILITY-DRIVEN.
 */

export * from "./types.js";
export * from "./config.js";
export * from "./client.js";
export * from "./auth.js";
export * from "./health.js";
export * from "./bootstrap.js";
export * from "./capabilities.js";
export * from "./entitlements.js";
export * from "./policies.js";
export * from "./submissions.js";
export * from "./events.js";
