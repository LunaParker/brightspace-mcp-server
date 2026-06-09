/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/** JSON schema for ~/.brightspace-mcp/config.json */
export interface ConfigStoreData {
  baseUrl?: string;
  /**
   * SSO provider to use for the auth flow.
   * - "entra": headed Microsoft Entra ID login (manual). Default in this fork.
   * - "purdue": upstream Purdue Shibboleth automation.
   * - "manual": generic manual flow with no IdP-specific hooks.
   */
  ssoProvider?: "entra" | "purdue" | "manual";
  username?: string;
  password?: string;
  sessionDir?: string;
  tokenTtl?: number;
  headless?: boolean;
  includeCourses?: number[];
  excludeCourses?: number[];
  activeOnly?: boolean;
  /**
   * Only include courses whose Access.StartDate ≤ now ≤ Access.EndDate,
   * matching Brightspace's "Current Courses" widget. Courses with null
   * start/end dates (ongoing resource orgs like community spaces) are
   * treated as open-ended and always pass. Overridable via D2L_CURRENT_ONLY.
   */
  currentOnly?: boolean;
}

const CONFIG_DIR = path.join(os.homedir(), ".brightspace-mcp");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export function configStoreExists(): boolean {
  return fs.existsSync(CONFIG_FILE);
}

export function loadConfigStore(): ConfigStoreData {
  const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
  return JSON.parse(raw) as ConfigStoreData;
}

export function saveConfigStore(config: ConfigStoreData): void {
  const isWindows = process.platform === "win32";
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, ...(isWindows ? {} : { mode: 0o700 }) });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", {
    ...(isWindows ? {} : { mode: 0o600 }),
  });
}

export function getConfigStorePath(): string {
  return CONFIG_FILE;
}
