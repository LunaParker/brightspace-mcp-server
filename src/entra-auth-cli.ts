#!/usr/bin/env node
/**
 * Brightspace MCP Server — Entra ID SSO fork
 *
 * Dedicated authentication command for institutions that use headed
 * Microsoft Entra ID (Azure AD) SSO. This forces ssoProvider="entra"
 * regardless of what's in ~/.brightspace-mcp/config.json and opens a
 * visible Chromium window for the user to complete their organization's
 * sign-in flow manually (username/password/MFA/conditional access/etc.).
 *
 * Usage:
 *   brightspace-entra-auth
 *   or: brightspace-mcp-server entra-auth
 *
 * Run this whenever your Brightspace session expires (typically every
 * 7 days per organization policy).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import dotenv from "dotenv";
import { loadConfig } from "./utils/config.js";
import { BrowserAuth, TokenManager } from "./auth/index.js";
import type { AppConfig } from "./types/index.js";

// Load .env file so optional overrides are available via process.env
dotenv.config({ quiet: true });

function bold(s: string): string {
  return `\x1b[1m${s}\x1b[0m`;
}
function green(s: string): string {
  return `\x1b[32m${s}\x1b[0m`;
}
function yellow(s: string): string {
  return `\x1b[33m${s}\x1b[0m`;
}
function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}

async function main(): Promise<void> {
  try {
    // Load base config but force the Entra provider. This command is only
    // meant for institutions using Microsoft Entra ID SSO — notably most
    // Canadian post-secondary Brightspace tenants.
    const baseConfig = loadConfig();
    const config: AppConfig = {
      ...baseConfig,
      ssoProvider: "entra",
      // Entra login is always manual and headed — user has to type MFA.
      headless: false,
      // Credentials in config.json are ignored on purpose for Entra. We don't
      // trust any saved password to survive conditional-access + MFA anyway,
      // and echoing it into Chromium's form is a leak risk.
      username: undefined,
      password: undefined,
    };

    console.log(
      "\n" + bold("=== Brightspace Entra ID SSO Authentication ===") + "\n"
    );
    console.log(dim(`  Brightspace:   ${config.baseUrl}`));
    console.log(dim(`  Session dir:   ${config.sessionDir}`));
    console.log(
      dim(
        `  Token TTL:     ${config.tokenTtl}s (${Math.round(config.tokenTtl / 86400)} days)`
      )
    );
    console.log("");
    console.log(
      "A Chromium window will open. Sign in with your organization account"
    );
    console.log(
      "(username, password, MFA / conditional access) and wait for Brightspace"
    );
    console.log("to finish loading. This window will close automatically once");
    console.log("the session has been captured.\n");

    const browserAuth = new BrowserAuth(config);
    const token = await browserAuth.authenticate();

    const tokenManager = new TokenManager(config.sessionDir);
    await tokenManager.setToken(token);

    // Verify session.json was actually written to disk
    const sessionFile = path.join(config.sessionDir, "session.json");
    try {
      await fs.access(sessionFile);
    } catch {
      console.error(
        yellow(
          `\nWARNING: session.json was not found at ${sessionFile} after save.`
        )
      );
      console.error("Token was captured but failed to persist. Retrying save...");
      await tokenManager.setToken(token);
      try {
        await fs.access(sessionFile);
        console.log(green("Retry succeeded — session.json saved."));
      } catch {
        console.error(
          "Retry failed. Check directory permissions on",
          config.sessionDir
        );
        process.exit(1);
      }
    }

    const expiresInDays = Math.round(
      (token.expiresAt - Date.now()) / 1000 / 86400
    );
    console.log("\n" + green("=== Authentication successful! ===") + "\n");
    console.log(dim(`  Session file:  ${sessionFile}`));
    console.log(
      dim(
        `  Token expires: ${new Date(token.expiresAt).toISOString()} (~${expiresInDays} days)`
      )
    );
    console.log("");
    console.log("The MCP server will use this token automatically.");
    console.log(
      "Re-run " +
        bold("brightspace-entra-auth") +
        " whenever your organization forces re-authentication."
    );
    console.log("");

    process.exit(0);
  } catch (error) {
    console.error("\n" + yellow("=== Authentication failed ===") + "\n");
    console.error(
      "Error:",
      error instanceof Error ? error.message : String(error)
    );
    console.error("\nTroubleshooting tips:");
    console.error(
      "  1. Confirm baseUrl in ~/.brightspace-mcp/config.json is correct"
    );
    console.error(
      "  2. Complete the login + MFA inside the Chromium window within 5 minutes"
    );
    console.error(
      "  3. If Chromium didn't open, run `npx playwright install chromium`"
    );
    console.error("  4. Check the error message above for specifics\n");
    process.exit(1);
  }
}

main();
