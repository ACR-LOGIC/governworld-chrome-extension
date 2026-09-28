// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Centralized, production-grade HTTP client for the GovernWorld API.
 * Enforces transport security, request correlation (X-Request-ID), idempotency keys,
 * installation tracking, token authorization, and privacy-safe error normalization.
 */

import { getApiUrl, getInstallationId, CURRENT_EXTENSION_VERSION, validateApiUrl } from "./config.js";
import type { ApiErrorDetails } from "./types.js";

export interface RequestOptions {
  headers?: Record<string, string>;
  token?: string;
  timeoutMs?: number;
  idempotencyKey?: string;
}

export class GovernWorldApiClient {
  private customBaseUrl?: string;

  constructor(customBaseUrl?: string) {
    if (customBaseUrl) {
      const check = validateApiUrl(customBaseUrl);
      if (!check.valid) {
        throw new Error(`Invalid API Base URL: ${check.error}`);
      }
      this.customBaseUrl = check.normalizedUrl;
    }
  }

  public async getBaseUrl(): Promise<string> {
    if (this.customBaseUrl) return this.customBaseUrl;
    return await getApiUrl();
  }

  /**
   * Normalizes any HTTP error response or network fault into a privacy-safe error description.
   * Internal database errors, SQL queries, stack traces, and Azure details are strictly stripped.
   */
  private normalizeError(status: number, responseBody: unknown, requestId?: string): ApiErrorDetails {
    let userMessage = "GovernWorld connection encountered an unexpected error.";
    let code = "SERVER_ERROR";

    if (status === 401) {
      code = "UNAUTHORIZED";
      userMessage = "Authentication required or your session has expired. Please reconnect.";
    } else if (status === 403) {
      code = "FORBIDDEN";
      userMessage = "You or your organization are not authorized for this operation.";
    } else if (status === 404) {
      code = "NOT_FOUND";
      userMessage = "The requested GovernWorld resource was not found.";
    } else if (status === 429) {
      code = "RATE_LIMITED";
      userMessage = "Rate limit reached. Please wait a moment before retrying.";
    } else if (status >= 500) {
      code = "SERVER_ERROR";
      userMessage = "GovernWorld server is temporarily unavailable. Local protection remains active.";
    } else if (status === 0) {
      code = "OFFLINE";
      userMessage = "Unable to reach GovernWorld API. Local on-device protection continues normally.";
    }

    // Extract safe message if provided by backend in standard format
    if (
      typeof responseBody === "object" &&
      responseBody !== null &&
      "user_message" in responseBody &&
      typeof (responseBody as Record<string, unknown>).user_message === "string"
    ) {
      userMessage = (responseBody as Record<string, unknown>).user_message as string;
    } else if (
      typeof responseBody === "object" &&
      responseBody !== null &&
      "error" in responseBody &&
      typeof (responseBody as Record<string, unknown>).error === "string"
    ) {
      const rawError = (responseBody as Record<string, unknown>).error as string;
      // Filter out internal leakages
      if (!/sql|postgres|azure|select|from|where|insert|update|delete|table|column|stack/i.test(rawError)) {
        userMessage = rawError;
      }
    }

    return {
      code,
      user_message: userMessage,
      status_code: status,
      request_id: requestId,
    };
  }

  /**
   * Core request dispatcher.
   */
  public async request<T>(
    path: string,
    method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
    body?: unknown,
    options: RequestOptions = {}
  ): Promise<{ ok: true; data: T; status: number; requestId: string } | { ok: false; error: ApiErrorDetails }> {
    const baseUrl = await this.getBaseUrl();
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    const url = `${baseUrl}${cleanPath}`;

    // Re-verify transport security
    const check = validateApiUrl(url);
    if (!check.valid) {
      return {
        ok: false,
        error: {
          code: "INSECURE_TRANSPORT",
          user_message: "Connection blocked: Remote GovernWorld API communication requires HTTPS.",
          status_code: 0,
        },
      };
    }

    const requestId = crypto.randomUUID();
    const installationId = await getInstallationId();
    const timeoutMs = options.timeoutMs ?? 10_000;

    const headers: Record<string, string> = {
      "Accept": "application/json",
      "X-Request-ID": requestId,
      "X-Extension-Version": CURRENT_EXTENSION_VERSION,
      "X-Installation-ID": installationId,
      ...(options.headers ?? {}),
    };

    if (options.token) {
      headers["Authorization"] = `Bearer ${options.token}`;
    }

    // Attach Idempotency-Key to mutation requests
    if (method !== "GET") {
      headers["Idempotency-Key"] = options.idempotencyKey ?? crypto.randomUUID();
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
      }
    }

    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutTimer);

      let responseData: unknown = null;
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        try {
          responseData = await response.json();
        } catch {
          responseData = null;
        }
      } else {
        responseData = await response.text();
      }

      if (!response.ok) {
        return {
          ok: false,
          error: this.normalizeError(response.status, responseData, requestId),
        };
      }

      return {
        ok: true,
        data: responseData as T,
        status: response.status,
        requestId,
      };
    } catch (err: unknown) {
      clearTimeout(timeoutTimer);
      const isAbort = (err as Error)?.name === "AbortError";
      return {
        ok: false,
        error: {
          code: isAbort ? "TIMEOUT" : "OFFLINE",
          user_message: isAbort
            ? "Request to GovernWorld timed out. Local protection remains active."
            : "Cannot reach GovernWorld. On-device local protection continues normally.",
          status_code: 0,
          request_id: requestId,
        },
      };
    }
  }

  public async get<T>(path: string, options?: RequestOptions) {
    return this.request<T>(path, "GET", undefined, options);
  }

  public async post<T>(path: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>(path, "POST", body, options);
  }

  public async put<T>(path: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>(path, "PUT", body, options);
  }

  public async delete<T>(path: string, options?: RequestOptions) {
    return this.request<T>(path, "DELETE", undefined, options);
  }
}
