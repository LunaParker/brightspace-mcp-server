/**
 * Tests for the parameterized authExpiredMessage on D2LApiClient.
 *
 * The Entra fork needs to tell users exactly which CLI to run when a
 * session expires ("brightspace-entra-auth" vs upstream "brightspace-auth").
 * This is done by passing `authExpiredMessage` through the client options
 * and re-using it in every 401 throw path. These tests lock in that wiring.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { D2LApiClient } from "../../src/api/client.js";
import { ApiError } from "../../src/api/errors.js";
import type { TokenManager } from "../../src/auth/token-manager.js";
import type { TokenData } from "../../src/types/index.js";

const createMockTokenManager = (): TokenManager => {
  let storedToken: TokenData | null = null;
  return {
    async getToken() {
      return storedToken;
    },
    async setToken(token: TokenData) {
      storedToken = token;
    },
    async clearToken() {
      storedToken = null;
    },
    isValid(token: TokenData) {
      return token.expiresAt > Date.now();
    },
    async needsRefresh() {
      return storedToken === null;
    },
  } as TokenManager;
};

const makeToken = (): TokenData => ({
  accessToken: "bearer-abc",
  capturedAt: Date.now(),
  expiresAt: Date.now() + 3_600_000,
  source: "browser",
});

describe("D2LApiClient — authExpiredMessage", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  async function initialized(
    tm: TokenManager,
    options: {
      authExpiredMessage?: string;
      onAuthExpired?: () => Promise<boolean>;
    } = {}
  ): Promise<D2LApiClient> {
    // Mock the versions endpoint for initialize()
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      async json() {
        return [
          { ProductCode: "lp", LatestVersion: "1.56" },
          { ProductCode: "le", LatestVersion: "1.91" },
        ];
      },
      async text() {
        return "";
      },
    } as unknown as Response);

    const client = new D2LApiClient({
      baseUrl: "https://example.desire2learn.com",
      tokenManager: tm,
      ...options,
    });
    await client.initialize();
    return client;
  }

  function respond401(): Response {
    return {
      ok: false,
      status: 401,
      headers: new Headers(),
      async json() {
        return {};
      },
      async text() {
        return "unauthorized";
      },
    } as unknown as Response;
  }

  it("uses the default message when authExpiredMessage is not set", async () => {
    const tm = createMockTokenManager();
    await tm.setToken(makeToken());
    const client = await initialized(tm);

    mockFetch.mockResolvedValueOnce(respond401());

    try {
      await client.get("/d2l/api/lp/1.56/users/whoami");
      expect.unreachable("should have thrown 401");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(401);
      expect((err as ApiError).message).toMatch(/brightspace-auth/);
    }
  });

  it("uses a custom authExpiredMessage in 401 ApiErrors", async () => {
    const tm = createMockTokenManager();
    await tm.setToken(makeToken());
    const client = await initialized(tm, {
      authExpiredMessage:
        "Session expired. Run `brightspace-entra-auth` in a terminal to sign in again.",
    });

    mockFetch.mockResolvedValueOnce(respond401());

    try {
      await client.get("/d2l/api/lp/1.56/users/whoami");
      expect.unreachable("should have thrown 401");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(401);
      expect((err as ApiError).message).toContain("brightspace-entra-auth");
      expect((err as ApiError).message).not.toContain("brightspace-auth.");
    }
  });

  it("uses the custom message when onAuthExpired returns false and there is no cached token", async () => {
    const tm = createMockTokenManager();
    // no token cached — first getToken() returns null, triggering tryAutoReauth
    const onAuthExpired = vi.fn().mockResolvedValue(false);

    const client = await initialized(tm, {
      authExpiredMessage: "please run brightspace-entra-auth",
      onAuthExpired,
    });

    try {
      await client.get("/d2l/api/lp/1.56/users/whoami");
      expect.unreachable("should have thrown 401");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(401);
      expect((err as ApiError).message).toContain("brightspace-entra-auth");
    }
    expect(onAuthExpired).toHaveBeenCalledTimes(1);
  });
});
