/**
 * Tests for provider selection in BrowserAuth.
 *
 * These tests lock in the contract that BrowserAuth picks the right
 * SSOProviderFlow implementation based on config.ssoProvider. They do
 * NOT launch a browser — they only exercise the constructor.
 *
 * The full authenticate() flow is not tested here because it depends on
 * a real Chromium instance and a live Brightspace tenant. See the
 * end-to-end smoke-test tooling in the top-level README for that.
 */

import { describe, it, expect } from "vitest";
import { BrowserAuth } from "../../src/auth/browser-auth.js";
import { EntraSSOFlow } from "../../src/auth/entra-sso.js";
import { PurdueSSOFlow } from "../../src/auth/purdue-sso.js";
import type { AppConfig, SsoProvider } from "../../src/types/index.js";

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    baseUrl: "https://example.desire2learn.com",
    sessionDir: "/tmp/brightspace-mcp-test-session",
    tokenTtl: 604800,
    headless: false,
    ssoProvider: "entra",
    courseFilter: { activeOnly: true },
    ...overrides,
  };
}

/** Peek at the private ssoFlow field for assertions. */
function getFlow(auth: BrowserAuth): unknown {
  return (auth as unknown as { ssoFlow: unknown }).ssoFlow;
}

describe("BrowserAuth provider selection", () => {
  it("uses EntraSSOFlow when ssoProvider is 'entra'", () => {
    const auth = new BrowserAuth(baseConfig({ ssoProvider: "entra" }));
    expect(getFlow(auth)).toBeInstanceOf(EntraSSOFlow);
  });

  it("uses EntraSSOFlow when ssoProvider is 'manual' (same headless-manual code path)", () => {
    const auth = new BrowserAuth(baseConfig({ ssoProvider: "manual" }));
    expect(getFlow(auth)).toBeInstanceOf(EntraSSOFlow);
  });

  it("uses PurdueSSOFlow when ssoProvider is 'purdue'", () => {
    const auth = new BrowserAuth(
      baseConfig({
        ssoProvider: "purdue",
        username: "fake",
        password: "fake",
      })
    );
    expect(getFlow(auth)).toBeInstanceOf(PurdueSSOFlow);
  });

  it("throws on an unknown ssoProvider value", () => {
    const bad = baseConfig({
      ssoProvider: "bogus" as unknown as SsoProvider,
    });
    expect(() => new BrowserAuth(bad)).toThrow(/ssoProvider/i);
  });

  it("Entra provider reports no credentials regardless of username/password in config", () => {
    // Entra mode should ignore any username/password that leaked into the
    // config file — they are never typed into the browser.
    const auth = new BrowserAuth(
      baseConfig({
        ssoProvider: "entra",
        username: "should-be-ignored",
        password: "should-be-ignored",
      })
    );
    const flow = getFlow(auth) as EntraSSOFlow;
    expect(flow).toBeInstanceOf(EntraSSOFlow);
    expect(flow.hasCredentials()).toBe(false);
  });

  it("Purdue provider reports credentials when username+password are provided", () => {
    const auth = new BrowserAuth(
      baseConfig({
        ssoProvider: "purdue",
        username: "pal001",
        password: "hunter2",
      })
    );
    const flow = getFlow(auth) as PurdueSSOFlow;
    expect(flow).toBeInstanceOf(PurdueSSOFlow);
    expect(flow.hasCredentials()).toBe(true);
  });
});
