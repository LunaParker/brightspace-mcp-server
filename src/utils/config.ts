/**
 * Brightspace MCP Server
 * Copyright (c) 2025 Rohan Muppa. All rights reserved.
 * Licensed under AGPL-3.0 — see LICENSE file for details.
 */

import * as path from "node:path";
import * as os from "node:os";
import type { AppConfig, SsoProvider } from "../types/index.js";
import { configStoreExists, loadConfigStore } from "./config-store.js";

/**
 * Default SSO provider. This fork targets headed Microsoft Entra ID SSO,
 * which is the common authentication path for Canadian post-secondary
 * Brightspace tenants. The upstream Purdue Shibboleth automation is still
 * available via ssoProvider="purdue".
 */
const DEFAULT_SSO_PROVIDER: SsoProvider = "entra";

/** Default token TTL per provider (seconds). Entra installations typically
 *  enforce a 7-day manual re-auth window via conditional access. */
const DEFAULT_TOKEN_TTL_BY_PROVIDER: Record<SsoProvider, number> = {
  entra: 7 * 24 * 60 * 60, // 7 days
  purdue: 3600, // 1 hour (upstream default)
  manual: 7 * 24 * 60 * 60, // 7 days
};

function parseSsoProvider(raw: string | undefined): SsoProvider | undefined {
  if (!raw) return undefined;
  const v = raw.toLowerCase();
  if (v === "entra" || v === "purdue" || v === "manual") return v;
  return undefined;
}

export function loadConfig(): AppConfig {
  const store = configStoreExists() ? loadConfigStore() : null;

  if (store) {
    console.error("[config] Loaded base config from ~/.brightspace-mcp/config.json");
  } else {
    console.error("[config] No config.json found, using environment variables");
  }

  // Resolve sessionDir: env > store > default
  const sessionDir = process.env.D2L_SESSION_DIR
    ? expandTilde(process.env.D2L_SESSION_DIR)
    : store?.sessionDir
      ? expandTilde(store.sessionDir)
      : path.join(os.homedir(), ".d2l-session");

  // Resolve ssoProvider: env > store > default
  const ssoProvider: SsoProvider =
    parseSsoProvider(process.env.D2L_SSO_PROVIDER) ??
    parseSsoProvider(store?.ssoProvider) ??
    DEFAULT_SSO_PROVIDER;

  // Resolve headless: env > store > provider default
  // Entra/manual providers must run headed — the user has to type their
  // credentials themselves. Purdue defaults to whatever is configured.
  const providerDefaultHeadless = ssoProvider === "entra" || ssoProvider === "manual" ? false : false;
  let headless = store?.headless ?? providerDefaultHeadless;
  if (process.env.D2L_HEADLESS !== undefined) {
    headless = process.env.D2L_HEADLESS === "true";
  }

  // Resolve tokenTtl: env > store > provider default
  const tokenTtl = process.env.D2L_TOKEN_TTL
    ? parseInt(process.env.D2L_TOKEN_TTL, 10)
    : store?.tokenTtl ?? DEFAULT_TOKEN_TTL_BY_PROVIDER[ssoProvider];

  // Resolve includeCourseIds: env > store > undefined
  const includeCourseIds = process.env.D2L_INCLUDE_COURSES
    ? process.env.D2L_INCLUDE_COURSES.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
    : store?.includeCourses;

  // Resolve excludeCourseIds: env > store > undefined
  const excludeCourseIds = process.env.D2L_EXCLUDE_COURSES
    ? process.env.D2L_EXCLUDE_COURSES.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
    : store?.excludeCourses;

  // Resolve activeOnly: env > store > default (true)
  let activeOnly = store?.activeOnly ?? true;
  if (process.env.D2L_ACTIVE_ONLY !== undefined) {
    activeOnly = process.env.D2L_ACTIVE_ONLY !== 'false';
  }

  // Resolve currentOnly: env > store > default (false). When true, a
  // course only passes the filter if `Access.StartDate ≤ now ≤ Access.EndDate`.
  // Null dates are treated as open-ended, so ongoing resource orgs still
  // appear. This mirrors Brightspace's "Current Courses" widget.
  let currentOnly = store?.currentOnly ?? false;
  if (process.env.D2L_CURRENT_ONLY !== undefined) {
    currentOnly = process.env.D2L_CURRENT_ONLY !== 'false';
  }

  return {
    baseUrl: process.env.D2L_BASE_URL || store?.baseUrl || "https://purdue.brightspace.com",
    sessionDir,
    tokenTtl,
    headless,
    ssoProvider,
    username: process.env.D2L_USERNAME || store?.username,
    password: process.env.D2L_PASSWORD || store?.password,
    courseFilter: {
      includeCourseIds,
      excludeCourseIds,
      activeOnly,
      currentOnly,
    },
  };
}

function expandTilde(filePath: string): string {
  if (filePath.startsWith("~")) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

export type { AppConfig };
