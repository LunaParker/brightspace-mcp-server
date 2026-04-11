/**
 * Unit tests for EntraSSOFlow.
 *
 * EntraSSOFlow is a deliberately thin wrapper around `page.waitForURL`: it
 * never types credentials, never hardcodes an IdP, and never automates MFA.
 * These tests lock in that minimal contract so regressions (e.g. someone
 * accidentally making login() work, or manualLogin() hardcoding a URL)
 * fail loudly.
 */

import { describe, it, expect, vi } from "vitest";
import type { Page } from "playwright";
import { EntraSSOFlow } from "../../src/auth/entra-sso.js";
import { BrowserAuthError } from "../../src/utils/errors.js";

/**
 * Build a minimal Page stub with a scripted waitForURL implementation.
 * Only the methods EntraSSOFlow actually touches are stubbed.
 */
function mockPage(overrides: Partial<Page> = {}): Page {
  return {
    url: () => "https://example.desire2learn.com/d2l/home",
    waitForURL: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Page;
}

describe("EntraSSOFlow", () => {
  describe("hasCredentials", () => {
    it("always returns false — Entra login is interactive-only", () => {
      const flow = new EntraSSOFlow();
      expect(flow.hasCredentials()).toBe(false);
    });
  });

  describe("login", () => {
    it("throws BrowserAuthError — automated login is not supported", async () => {
      const flow = new EntraSSOFlow();
      const page = mockPage();

      await expect(flow.login(page)).rejects.toBeInstanceOf(BrowserAuthError);
    });

    it("error message points users at manualLogin", async () => {
      const flow = new EntraSSOFlow();
      const page = mockPage();

      try {
        await flow.login(page);
        expect.unreachable("login should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(BrowserAuthError);
        expect((err as Error).message).toMatch(/manualLogin/i);
      }
    });

    it("does not call any page methods before throwing", async () => {
      const flow = new EntraSSOFlow();
      const waitForURL = vi.fn();
      const gotoMock = vi.fn();
      const page = mockPage({
        waitForURL,
        goto: gotoMock,
      } as unknown as Partial<Page>);

      await expect(flow.login(page)).rejects.toBeInstanceOf(BrowserAuthError);
      expect(waitForURL).not.toHaveBeenCalled();
      expect(gotoMock).not.toHaveBeenCalled();
    });
  });

  describe("manualLogin", () => {
    it("returns true when waitForURL resolves with a Brightspace home URL", async () => {
      const flow = new EntraSSOFlow();
      const waitForURL = vi.fn().mockResolvedValue(undefined);
      const page = mockPage({ waitForURL } as unknown as Partial<Page>);

      const result = await flow.manualLogin(page);

      expect(result).toBe(true);
      expect(waitForURL).toHaveBeenCalledTimes(1);
    });

    it("calls waitForURL with a regex that matches /d2l/home", async () => {
      const flow = new EntraSSOFlow();
      const waitForURL = vi.fn().mockResolvedValue(undefined);
      const page = mockPage({ waitForURL } as unknown as Partial<Page>);

      await flow.manualLogin(page);

      const arg = waitForURL.mock.calls[0]![0] as RegExp;
      expect(arg).toBeInstanceOf(RegExp);
      expect(arg.test("https://example.desire2learn.com/d2l/home")).toBe(true);
      expect(
        arg.test("https://example.desire2learn.com/d2l/home/12345")
      ).toBe(true);
      // Must NOT match unrelated D2L pages
      expect(arg.test("https://example.desire2learn.com/d2l/login")).toBe(
        false
      );
      expect(arg.test("https://login.microsoftonline.com/common")).toBe(false);
    });

    it("passes a timeout option to waitForURL (≥ 60s)", async () => {
      const flow = new EntraSSOFlow();
      const waitForURL = vi.fn().mockResolvedValue(undefined);
      const page = mockPage({ waitForURL } as unknown as Partial<Page>);

      await flow.manualLogin(page);

      const opts = waitForURL.mock.calls[0]![1] as { timeout: number };
      expect(opts).toBeDefined();
      expect(opts.timeout).toBeGreaterThanOrEqual(60_000);
    });

    it("returns false when waitForURL times out or rejects", async () => {
      const flow = new EntraSSOFlow();
      const waitForURL = vi
        .fn()
        .mockRejectedValue(new Error("Timeout 300000ms exceeded"));
      const page = mockPage({ waitForURL } as unknown as Partial<Page>);

      const result = await flow.manualLogin(page);

      expect(result).toBe(false);
    });

    it("does not hardcode any institution-specific URL", async () => {
      // Regression guard: the original upstream manualLogin() called
      // handleCampusSelector(), which hijacked /d2l/login to Purdue's IdP.
      // The Entra flow must never touch goto() or any other navigation.
      const flow = new EntraSSOFlow();
      const waitForURL = vi.fn().mockResolvedValue(undefined);
      const gotoMock = vi.fn();
      const page = mockPage({
        waitForURL,
        goto: gotoMock,
      } as unknown as Partial<Page>);

      await flow.manualLogin(page);

      expect(gotoMock).not.toHaveBeenCalled();
    });
  });
});
