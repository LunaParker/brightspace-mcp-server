/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

// Token data captured from browser interception
export interface TokenData {
  accessToken: string;
  capturedAt: number; // Unix timestamp ms
  expiresAt: number; // Unix timestamp ms
  source: "browser" | "cache";
}

// Encrypted token stored on disk
export interface EncryptedData {
  iv: string; // hex-encoded initialization vector
  authTag: string; // hex-encoded GCM auth tag
  data: string; // hex-encoded ciphertext
}

// Session file persisted to ~/.d2l-session/
export interface SessionFile {
  version: 1;
  encrypted: EncryptedData;
  createdAt: number; // Unix timestamp ms
  expiresAt: number; // Unix timestamp ms
}

/**
 * SSO provider the auth flow should target.
 * - "entra": headed Microsoft Entra ID login (manual). Default in this fork.
 * - "purdue": upstream Purdue Shibboleth automation (requires username/password).
 * - "manual": generic manual flow with no IdP-specific behavior.
 */
export type SsoProvider = "entra" | "purdue" | "manual";

// Application configuration
export interface AppConfig {
  baseUrl: string;
  sessionDir: string;
  tokenTtl: number; // seconds
  headless: boolean;
  ssoProvider: SsoProvider;
  username?: string;
  password?: string;
  courseFilter: CourseFilterConfig;
}

// Auth result from browser auth flow
export interface AuthResult {
  token: TokenData;
  cookies?: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
  }>;
}

// Log levels
export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

// Course filtering configuration from environment variables
export interface CourseFilterConfig {
  includeCourseIds?: number[];
  excludeCourseIds?: number[];
  /**
   * Only include courses where the enrollment's IsActive flag is true.
   * This is D2L's notion of "accessible" — it doesn't drop past terms,
   * just orgs the user has been removed from.
   */
  activeOnly: boolean;
  /**
   * Only include courses whose Access.StartDate ≤ now ≤ Access.EndDate,
   * matching Brightspace's "Current Courses" widget. Courses with null
   * start/end dates (ongoing resource orgs like community spaces) are
   * treated as open-ended and always pass this filter. Default: false.
   */
  currentOnly: boolean;
}
