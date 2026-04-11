/**
 * Brightspace MCP Server — Entra ID SSO fork
 *
 * Headed Microsoft Entra ID (Azure AD) SSO flow for Brightspace D2L
 * installations that delegate authentication to Entra. Unlike the
 * upstream PurdueSSOFlow, this provider does not automate credential
 * entry or hardcode any institution's identity provider. The user logs
 * in interactively in a visible Chromium window; we only watch the
 * final URL to know when we've landed on /d2l/home.
 *
 * This flow is designed for institutions — notably most Canadian
 * post-secondary Brightspace tenants — whose login pages redirect to
 * login.microsoftonline.com and whose conditional-access policies enforce
 * interactive re-authentication with MFA every N days.
 */

import type { Page } from "playwright";
import { BrowserAuthError } from "../utils/errors.js";
import { log } from "../utils/logger.js";

export interface SSOProviderFlow {
  /**
   * Whether the provider has enough information to run fully automated login.
   * The EntraSSOFlow always returns false — Entra login is manual.
   */
  hasCredentials(): boolean;

  /**
   * Automated login. Not supported by EntraSSOFlow — callers should check
   * hasCredentials() first and fall back to manualLogin() if false.
   */
  login(page: Page): Promise<boolean>;

  /**
   * Manual login: open the browser, let the user complete whatever SSO
   * dance their institution requires, wait for /d2l/home to load.
   */
  manualLogin(page: Page): Promise<boolean>;
}

const MANUAL_LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class EntraSSOFlow implements SSOProviderFlow {
  hasCredentials(): boolean {
    // Entra login is always manual in this fork. Even if a username/password
    // were provided, we wouldn't type them — MFA, conditional access, and
    // tenant-specific login pages make automation fragile and insecure.
    return false;
  }

  async login(_page: Page): Promise<boolean> {
    throw new BrowserAuthError(
      "EntraSSOFlow does not support automated login. Use manualLogin().",
      "sso_login"
    );
  }

  /**
   * Open the browser, wait for the user to complete Entra ID login (including
   * MFA / conditional access), and resolve once Brightspace has loaded.
   *
   * The page is expected to already be pointed at the Brightspace home URL
   * (or mid-redirect through the SAML IdP) when this is called.
   */
  async manualLogin(page: Page): Promise<boolean> {
    try {
      log("INFO", "Starting Entra ID manual login flow");
      log("INFO", "A browser window has opened — please sign in with your organization account.");
      log(
        "INFO",
        `Waiting up to ${MANUAL_LOGIN_TIMEOUT_MS / 60000} minutes for you to complete login and MFA...`
      );

      // The Brightspace "home" URL is the only reliable success signal. Every
      // other hop (login.microsoftonline.com, the SAML initiate endpoint, the
      // "stay signed in?" prompt) is institution-specific.
      await page.waitForURL(/\/d2l\/home/, { timeout: MANUAL_LOGIN_TIMEOUT_MS });
      log("INFO", "Manual login successful — reached Brightspace home");

      return true;
    } catch (error) {
      log("ERROR", "Entra manual login flow failed or timed out", error);
      return false;
    }
  }
}
