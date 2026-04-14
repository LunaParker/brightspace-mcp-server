#!/usr/bin/env node
/**
 * Brightspace MCP Server — Silent Session Refresh
 *
 * Headless Playwright script that refreshes the Brightspace session token
 * without user interaction. Uses the existing persistent browser profile
 * (cookies + Entra SSO session) to navigate to Brightspace and extract a
 * fresh 60-minute JWT via D2L's OAuth2 JS API.
 *
 * Designed to be spawned by the MCP server's onAuthExpired callback.
 * Can also be run manually or via a scheduler.
 *
 * Exit codes:
 *   0 — token refreshed successfully
 *   1 — refresh failed (session expired, needs manual re-auth)
 *   2 — no existing session to refresh (never authenticated)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { chromium } from "playwright";
import type { BrowserContext } from "playwright";
import dotenv from "dotenv";
import { loadConfig } from "./utils/config.js";
import { TokenManager } from "./auth/index.js";
import type { TokenData } from "./types/index.js";

dotenv.config({ quiet: true });

/** Total budget for the entire refresh attempt. */
const TOTAL_TIMEOUT_MS = 60_000;
/** JWT lifetime from D2L's OAuth2 endpoint. */
const JWT_TTL_MS = 55 * 60 * 1000; // 55 min (actual is 60; 5 min buffer)

function ts(): string {
  return new Date().toISOString();
}

function log(msg: string): void {
  console.error(`[${ts()}] silent-refresh: ${msg}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const sessionDir = config.sessionDir;
  const browserDataDir = path.join(sessionDir, "browser-data");
  const storageStatePath = path.join(sessionDir, "storage-state.json");

  log("Starting");
  log(`  Brightspace: ${config.baseUrl}`);
  log(`  Session dir: ${sessionDir}`);

  // ── Pre-flight checks ──────────────────────────────────────────────

  // Browser profile must exist (user has run brightspace-entra-auth at least once)
  try {
    await fs.access(browserDataDir);
  } catch {
    log("No browser profile found — run brightspace-entra-auth first.");
    process.exit(2);
  }

  // ── Launch headless browser ────────────────────────────────────────

  let context: BrowserContext | null = null;

  const globalTimer = setTimeout(() => {
    log("Global timeout — aborting.");
    process.exit(1);
  }, TOTAL_TIMEOUT_MS);

  try {
    log("Launching headless Chromium...");

    context = await chromium.launchPersistentContext(browserDataDir, {
      headless: true,
      viewport: { width: 1280, height: 720 },
      args: ["--disable-blink-features=AutomationControlled"],
      timeout: 30_000,
    });

    // Restore cookies from storage-state.json if available
    try {
      const stat = await fs.stat(storageStatePath);
      const ageMs = Date.now() - stat.mtimeMs;
      // Only load if not ancient (within 7-day Entra window)
      if (ageMs < 7 * 24 * 3600 * 1000) {
        const stateJson = await fs.readFile(storageStatePath, "utf-8");
        const state = JSON.parse(stateJson);
        if (state.cookies?.length) {
          await context.addCookies(state.cookies);
          log(`Restored ${state.cookies.length} cookies`);
        }
      }
    } catch {
      // No storage state — continue with persistent context cookies
    }

    const page = context.pages()[0] || (await context.newPage());

    // Navigate to Brightspace
    log(`Navigating to ${config.baseUrl}/d2l/home`);
    await page.goto(`${config.baseUrl}/d2l/home`, {
      waitUntil: "load",
      timeout: 30_000,
    });

    // Wait for redirects to settle (Entra SSO redirect chain)
    try {
      await page.waitForURL(
        (url) => {
          const href = url.toString();
          return (
            /\/d2l\/home/.test(href) ||
            href.includes("login.microsoftonline.com") ||
            href.includes("/d2l/login")
          );
        },
        { timeout: 15_000 },
      );
    } catch {
      // Timeout — check URL below
    }

    await page
      .waitForLoadState("networkidle", { timeout: 10_000 })
      .catch(() => {});

    const currentUrl = page.url();
    log(`Landed on: ${currentUrl}`);

    // Check if we hit a login page (session fully expired)
    if (
      currentUrl.includes("login.microsoftonline.com") ||
      currentUrl.includes("/d2l/login") ||
      currentUrl.includes("/d2l/lp/auth/")
    ) {
      log("Redirected to login — Entra session expired. Manual re-auth required.");
      process.exit(1);
    }

    // We're on Brightspace — extract JWT via OAuth2.GetToken
    log("On Brightspace — requesting OAuth2 token...");

    const jwt = await page.evaluate(async () => {
      try {
        const d2l = (window as any).D2L;
        if (!d2l?.LP?.Web?.Authentication?.OAuth2?.GetToken) {
          return { error: "D2L OAuth2 API not found on page" };
        }
        const token = await d2l.LP.Web.Authentication.OAuth2.GetToken("*:*:*");
        if (typeof token === "string" && token.length > 50) {
          return { token };
        }
        return { error: "GetToken returned invalid result" };
      } catch (e: any) {
        return { error: e?.message || String(e) };
      }
    });

    if ("error" in jwt) {
      log(`GetToken failed: ${jwt.error}`);

      // Fallback: try extracting from localStorage
      const lsToken = await page.evaluate(() => {
        try {
          const json = localStorage.getItem("D2L.Fetch.Tokens");
          if (!json) return null;
          const tokens = JSON.parse(json);
          return tokens["*:*:*"]?.access_token ?? null;
        } catch {
          return null;
        }
      });

      if (lsToken) {
        log("Fell back to localStorage token");
        await saveToken(lsToken, config.sessionDir);
        await saveStorageState(context, storageStatePath);
        clearTimeout(globalTimer);
        process.exit(0);
      }

      log("All token extraction strategies failed.");
      process.exit(1);
    }

    // Validate the JWT
    log(`Got ${jwt.token.length}-char JWT — validating...`);
    const valid = await validateToken(jwt.token, config.baseUrl);
    if (!valid) {
      log("JWT validation failed against /whoami");
      process.exit(1);
    }

    await saveToken(jwt.token, config.sessionDir);
    await saveStorageState(context, storageStatePath);

    log("Token refreshed successfully.");
    clearTimeout(globalTimer);
    process.exit(0);
  } catch (error) {
    log(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  } finally {
    if (context) {
      try {
        await context.close();
      } catch {
        // Already closed
      }
    }
  }
}

async function saveToken(jwt: string, sessionDir: string): Promise<void> {
  const tokenManager = new TokenManager(sessionDir);
  const now = Date.now();
  const tokenData: TokenData = {
    accessToken: jwt,
    capturedAt: now,
    expiresAt: now + JWT_TTL_MS,
    source: "browser",
  };
  await tokenManager.setToken(tokenData);
  log(`Token saved (expires ${new Date(tokenData.expiresAt).toISOString()})`);
}

async function validateToken(token: string, baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/d2l/api/lp/1.45/users/whoami`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent":
          "BrightspaceMCP/1.0 (github.com/rohanmuppa/brightspace-mcp-server)",
      },
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function saveStorageState(
  context: BrowserContext,
  storageStatePath: string,
): Promise<void> {
  try {
    await context.storageState({ path: storageStatePath });
    await fs.chmod(storageStatePath, 0o600);
  } catch {
    // Non-fatal
  }
}

main();
