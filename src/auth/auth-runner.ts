/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2025 Rohan Muppa. All rights reserved.
 * Licensed under AGPL-3.0 — see LICENSE file for details.
 */

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { log } from "../utils/logger.js";

/**
 * Timeout for the interactive auth process. Generous because the user may
 * need to approve MFA on their phone or manually log in via the browser.
 */
const AUTH_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

/**
 * Timeout for the silent (headless) refresh process. Should be quick —
 * it just loads a page and calls GetToken.
 */
const SILENT_REFRESH_TIMEOUT_MS = 60 * 1000; // 1 minute

/**
 * Launches auth CLI processes as child processes to re-authenticate
 * when the current session has expired.
 *
 * Supports two modes:
 *   - Interactive (Purdue): spawns brightspace-auth (headed browser, credentials)
 *   - Silent (Entra): spawns silent-refresh-cli (headless, uses existing cookies
 *     + Entra SSO session to get a fresh 60-min JWT without user interaction)
 */
export class AuthRunner {
  private running = false;
  private readonly authScriptPath: string;
  private readonly silentRefreshPath: string;
  private readonly projectRoot: string;

  constructor() {
    // Resolve paths relative to this file's compiled location (build/auth/auth-runner.js)
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    this.authScriptPath = path.resolve(thisDir, "..", "auth-cli.js");
    this.silentRefreshPath = path.resolve(thisDir, "..", "silent-refresh-cli.js");
    this.projectRoot = path.resolve(thisDir, "..", "..");
  }

  /**
   * Spawn the interactive auth CLI (for Purdue/manual flows).
   */
  async run(): Promise<boolean> {
    return this.spawn(this.authScriptPath, AUTH_TIMEOUT_MS, "brightspace-auth");
  }

  /**
   * Spawn the headless silent refresh (for Entra).
   * Uses the existing browser profile and Entra SSO session to get a fresh
   * JWT without any user interaction. Falls back gracefully if the Entra
   * session has expired (exit code 1) — caller should show re-auth message.
   */
  async runSilentRefresh(): Promise<boolean> {
    return this.spawn(this.silentRefreshPath, SILENT_REFRESH_TIMEOUT_MS, "silent-refresh");
  }

  private async spawn(
    scriptPath: string,
    timeoutMs: number,
    label: string,
  ): Promise<boolean> {
    if (this.running) {
      log("DEBUG", `${label}: already running, skipping duplicate attempt`);
      return false;
    }

    this.running = true;
    try {
      log("INFO", `Auto-launching ${label}...`);

      return await new Promise<boolean>((resolve) => {
        execFile(
          process.execPath, // use the same Node binary
          [scriptPath],
          {
            timeout: timeoutMs,
            cwd: this.projectRoot,
            env: { ...process.env },
          },
          (error, _stdout, stderr) => {
            if (error) {
              log("ERROR", `${label} failed`, error.message);
              if (stderr) log("DEBUG", `${label} stderr: ${stderr.slice(0, 500)}`);
              resolve(false);
            } else {
              log("INFO", `${label} completed successfully`);
              resolve(true);
            }
          },
        );
      });
    } finally {
      this.running = false;
    }
  }
}
