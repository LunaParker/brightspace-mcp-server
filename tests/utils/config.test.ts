/**
 * Tests for the loadConfig() resolution order with the new ssoProvider
 * field. Environment variables should win over the config file, which
 * should win over built-in defaults.
 *
 * Implementation note: src/utils/config-store.ts caches the config path
 * at module load time (`const CONFIG_FILE = path.join(os.homedir(), ...)`),
 * so we must call vi.resetModules() + dynamic import inside each test to
 * pick up the per-test fake $HOME.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

interface ConfigStoreData {
  baseUrl?: string;
  ssoProvider?: "entra" | "purdue" | "manual";
  username?: string;
  password?: string;
  sessionDir?: string;
  tokenTtl?: number;
  headless?: boolean;
  includeCourses?: number[];
  excludeCourses?: number[];
  activeOnly?: boolean;
  currentOnly?: boolean;
}

describe("loadConfig — ssoProvider resolution", () => {
  let testHome: string;
  let originalHome: string | undefined;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    // Create an isolated fake $HOME so config.json lookups are scoped
    // to this test and don't touch the real ~/.brightspace-mcp/config.json.
    testHome = path.join(
      os.tmpdir(),
      `config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await fs.mkdir(path.join(testHome, ".brightspace-mcp"), {
      recursive: true,
      mode: 0o700,
    });

    originalHome = process.env.HOME;
    process.env.HOME = testHome;

    // Save and clear every env var loadConfig() looks at so each test
    // starts from a known empty state.
    originalEnv = {
      D2L_BASE_URL: process.env.D2L_BASE_URL,
      D2L_SSO_PROVIDER: process.env.D2L_SSO_PROVIDER,
      D2L_HEADLESS: process.env.D2L_HEADLESS,
      D2L_TOKEN_TTL: process.env.D2L_TOKEN_TTL,
      D2L_SESSION_DIR: process.env.D2L_SESSION_DIR,
      D2L_USERNAME: process.env.D2L_USERNAME,
      D2L_PASSWORD: process.env.D2L_PASSWORD,
      D2L_INCLUDE_COURSES: process.env.D2L_INCLUDE_COURSES,
      D2L_EXCLUDE_COURSES: process.env.D2L_EXCLUDE_COURSES,
      D2L_ACTIVE_ONLY: process.env.D2L_ACTIVE_ONLY,
    };
    for (const key of Object.keys(originalEnv)) {
      delete process.env[key];
    }

    // config-store.ts stores `const CONFIG_FILE = path.join(os.homedir(), ...)`
    // at import time. Reset the module registry so that the next import
    // inside each test re-evaluates that line with our fake $HOME.
    vi.resetModules();
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    for (const [key, val] of Object.entries(originalEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    try {
      await fs.rm(testHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  async function writeConfig(data: ConfigStoreData): Promise<void> {
    await fs.writeFile(
      path.join(testHome, ".brightspace-mcp", "config.json"),
      JSON.stringify(data, null, 2) + "\n",
      { mode: 0o600 }
    );
  }

  async function freshLoadConfig() {
    const mod = await import("../../src/utils/config.js");
    return mod.loadConfig();
  }

  it("defaults ssoProvider to 'entra' when no config file and no env", async () => {
    const config = await freshLoadConfig();
    expect(config.ssoProvider).toBe("entra");
  });

  it("defaults tokenTtl to 7 days for the entra provider", async () => {
    const config = await freshLoadConfig();
    expect(config.tokenTtl).toBe(7 * 24 * 60 * 60);
  });

  it("reads ssoProvider='purdue' from the config file", async () => {
    await writeConfig({
      baseUrl: "https://purdue.brightspace.com",
      ssoProvider: "purdue",
      username: "pal001",
      password: "hunter2",
    });

    const config = await freshLoadConfig();
    expect(config.ssoProvider).toBe("purdue");
    expect(config.baseUrl).toBe("https://purdue.brightspace.com");
  });

  it("lets D2L_SSO_PROVIDER env var override the config file", async () => {
    await writeConfig({ ssoProvider: "purdue" });
    process.env.D2L_SSO_PROVIDER = "entra";

    const config = await freshLoadConfig();
    expect(config.ssoProvider).toBe("entra");
  });

  it("ignores a bogus ssoProvider value and falls back to the default", async () => {
    // Use type assertion because ConfigStoreData doesn't permit bogus
    // values, but we want to test the runtime fallback behavior.
    await writeConfig({
      ssoProvider: "bogus" as unknown as "entra",
    });

    const config = await freshLoadConfig();
    expect(config.ssoProvider).toBe("entra");
  });

  it("respects an explicit tokenTtl in the config file for entra", async () => {
    await writeConfig({
      ssoProvider: "entra",
      tokenTtl: 3600,
    });
    const config = await freshLoadConfig();
    expect(config.tokenTtl).toBe(3600);
  });

  it("respects an explicit D2L_TOKEN_TTL env var override", async () => {
    await writeConfig({
      ssoProvider: "entra",
      tokenTtl: 3600,
    });
    process.env.D2L_TOKEN_TTL = "12345";

    const config = await freshLoadConfig();
    expect(config.tokenTtl).toBe(12345);
  });

  it("defaults tokenTtl to 3600 when ssoProvider='purdue' and no override", async () => {
    await writeConfig({ ssoProvider: "purdue" });
    const config = await freshLoadConfig();
    expect(config.tokenTtl).toBe(3600);
  });

  it("loads baseUrl from the config file when ssoProvider is entra", async () => {
    await writeConfig({
      baseUrl: "https://tenant.example.com",
      ssoProvider: "entra",
    });
    const config = await freshLoadConfig();
    expect(config.baseUrl).toBe("https://tenant.example.com");
    expect(config.ssoProvider).toBe("entra");
  });

  it("headless defaults to false for entra even when not specified", async () => {
    await writeConfig({ ssoProvider: "entra" });
    const config = await freshLoadConfig();
    expect(config.headless).toBe(false);
  });

  describe("courseFilter.currentOnly", () => {
    it("defaults to false", async () => {
      const config = await freshLoadConfig();
      expect(config.courseFilter.currentOnly).toBe(false);
    });

    it("reads currentOnly=true from the config file", async () => {
      await writeConfig({ currentOnly: true });
      const config = await freshLoadConfig();
      expect(config.courseFilter.currentOnly).toBe(true);
    });

    it("lets D2L_CURRENT_ONLY env var override the config file", async () => {
      await writeConfig({ currentOnly: false });
      process.env.D2L_CURRENT_ONLY = "true";
      const config = await freshLoadConfig();
      expect(config.courseFilter.currentOnly).toBe(true);
    });

    it("D2L_CURRENT_ONLY=false disables even if config file says true", async () => {
      await writeConfig({ currentOnly: true });
      process.env.D2L_CURRENT_ONLY = "false";
      const config = await freshLoadConfig();
      expect(config.courseFilter.currentOnly).toBe(false);
    });
  });
});
