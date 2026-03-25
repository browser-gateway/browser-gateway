import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { loadConfig } from "../../src/server/config/loader.js";

const TEST_CONFIG_PATH = "/tmp/bg-test-config.yml";

afterEach(() => {
  if (existsSync(TEST_CONFIG_PATH)) {
    unlinkSync(TEST_CONFIG_PATH);
  }
  vi.unstubAllEnvs();
});

describe("Config Loader - YAML file", () => {
  it("should load a valid config file", () => {
    writeFileSync(
      TEST_CONFIG_PATH,
      `
version: 1
backends:
  test:
    url: ws://localhost:4000
    priority: 1
`
    );

    const config = loadConfig(TEST_CONFIG_PATH);
    expect(config.version).toBe(1);
    expect(config.backends.test).toBeDefined();
    expect(config.backends.test.url).toBe("ws://localhost:4000");
  });

  it("should apply defaults for missing optional fields", () => {
    writeFileSync(
      TEST_CONFIG_PATH,
      `
backends:
  test:
    url: ws://localhost:4000
`
    );

    const config = loadConfig(TEST_CONFIG_PATH);
    expect(config.version).toBe(1);
    expect(config.gateway.port).toBe(9500);
    expect(config.gateway.defaultStrategy).toBe("priority-chain");
    expect(config.gateway.connectionTimeout).toBe(10000);
    expect(config.gateway.cooldown.defaultMs).toBe(30000);
    expect(config.gateway.cooldown.failureThreshold).toBe(0.5);
    expect(config.gateway.sessions.idleTimeoutMs).toBe(300000);
    expect(config.dashboard.enabled).toBe(true);
    expect(config.logging.level).toBe("info");
    expect(config.backends.test.priority).toBe(1);
  });

  it("should reject config with no backends", () => {
    writeFileSync(TEST_CONFIG_PATH, `version: 1\n`);
    expect(() => loadConfig(TEST_CONFIG_PATH)).toThrow("Invalid configuration");
  });

  it("should reject config with invalid backend URL", () => {
    writeFileSync(
      TEST_CONFIG_PATH,
      `
backends:
  test:
    url: not-a-url
`
    );
    expect(() => loadConfig(TEST_CONFIG_PATH)).toThrow("Invalid configuration");
  });

  it("should reject config with invalid strategy", () => {
    writeFileSync(
      TEST_CONFIG_PATH,
      `
gateway:
  defaultStrategy: random-garbage
backends:
  test:
    url: ws://localhost:4000
`
    );
    expect(() => loadConfig(TEST_CONFIG_PATH)).toThrow("Invalid configuration");
  });
});

describe("Config Loader - Environment variable interpolation", () => {
  it("should interpolate ${ENV_VAR} in URLs", () => {
    vi.stubEnv("TEST_TOKEN", "my-secret-123");
    writeFileSync(
      TEST_CONFIG_PATH,
      `
backends:
  test:
    url: wss://provider.com?token=\${TEST_TOKEN}
`
    );

    const config = loadConfig(TEST_CONFIG_PATH);
    expect(config.backends.test.url).toBe("wss://provider.com?token=my-secret-123");
  });

  it("should replace missing env vars with empty string", () => {
    delete process.env.NONEXISTENT_VAR;
    writeFileSync(
      TEST_CONFIG_PATH,
      `
backends:
  test:
    url: ws://provider.com?token=\${NONEXISTENT_VAR}
`
    );

    const config = loadConfig(TEST_CONFIG_PATH);
    expect(config.backends.test.url).toBe("ws://provider.com?token=");
  });

  it("should support default values with ${VAR:-default}", () => {
    delete process.env.MISSING_PORT;
    writeFileSync(
      TEST_CONFIG_PATH,
      `
gateway:
  port: 8080
backends:
  test:
    url: ws://localhost:\${MISSING_PORT:-4000}
`
    );

    const config = loadConfig(TEST_CONFIG_PATH);
    expect(config.backends.test.url).toBe("ws://localhost:4000");
  });
});

describe("Config Loader - Environment variable fallback", () => {
  it("should build config from BG_BACKEND_URL when no file exists", () => {
    vi.stubEnv("BG_BACKEND_URL", "ws://localhost:9000");

    const config = loadConfig("/tmp/nonexistent-config.yml");
    expect(config.backends.default).toBeDefined();
    expect(config.backends.default.url).toBe("ws://localhost:9000");
  });

  it("should throw when no config file and no BG_BACKEND_URL", () => {
    delete process.env.BG_BACKEND_URL;
    expect(() => loadConfig("/tmp/nonexistent-config.yml")).toThrow(
      "No configuration found"
    );
  });

  it("should use BG_PORT when building from env", () => {
    vi.stubEnv("BG_BACKEND_URL", "ws://localhost:9000");
    vi.stubEnv("BG_PORT", "8080");

    const config = loadConfig("/tmp/nonexistent-config.yml");
    expect(config.gateway.port).toBe(8080);
  });

  it("should use BG_MAX_CONCURRENT when building from env", () => {
    vi.stubEnv("BG_BACKEND_URL", "ws://localhost:9000");
    vi.stubEnv("BG_MAX_CONCURRENT", "20");

    const config = loadConfig("/tmp/nonexistent-config.yml");
    expect(config.backends.default.limits?.maxConcurrent).toBe(20);
  });
});
