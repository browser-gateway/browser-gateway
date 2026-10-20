import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reservePort, runToken, waitForOwnGateway } from "../helpers/harness.js";

const RUN = runToken();
const TMP = mkdtempSync(join(tmpdir(), "bg-settings-"));
const CONFIG = join(TMP, "gateway.yml");
let gateway: ChildProcess;
let base = "";

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

const OFF = { record: false, profile: null, saveProfile: false, proxy: null };

beforeAll(async () => {
  const port = await reservePort();
  base = `http://127.0.0.1:${port}`;
  writeFileSync(CONFIG, `version: 1
gateway:
  port: ${port}
providers:
  remote-${RUN}:
    url: ws://127.0.0.1:1
proxies:
  home:
    url: http://127.0.0.1:3128
  locked:
    url: http://u:p@127.0.0.1:3128
logging:
  level: error
`);
  gateway = spawn("npx", ["tsx", "src/server/index.ts", "serve", "--config", CONFIG], { cwd: process.cwd(), stdio: "ignore", env: { ...process.env, BG_TOKEN: "" } });
  await waitForOwnGateway(port, gateway, RUN);
}, 30_000);

afterAll(() => {
  gateway?.kill("SIGTERM");
  rmSync(TMP, { recursive: true, force: true });
});

describe("gateway settings API", () => {
  it("starts with every session default off and shows routing and advanced values", async () => {
    const { json } = await call("GET", "/v1/config/settings");
    expect(json.sessionDefaults).toEqual(OFF);
    expect(json.strategy).toBe("priority-chain");
    expect(json.advanced).toMatchObject({ connectionTimeout: 10000, queueMaxSize: 50, cooldownMs: 30000 });
    expect(json.appliesAfterRestart).toContain("cooldownMs");
  });

  it("refuses defaults the gateway cannot apply", async () => {
    expect((await call("PUT", "/v1/config/session-defaults", { ...OFF, proxy: "missing" })).status).toBe(400);
    expect((await call("PUT", "/v1/config/session-defaults", { ...OFF, proxy: "locked" })).status).toBe(400);
    const profile = await call("PUT", "/v1/config/session-defaults", { ...OFF, profile: "work" });
    expect(profile.status).toBe(400);
    expect(profile.json.details.join()).toContain("turn on profiles");
    expect((await call("PUT", "/v1/config/session-defaults", { ...OFF, record: "yes" })).status).toBe(400);
    expect((await call("PUT", "/v1/config/session-defaults", { ...OFF, extra: 1 })).status).toBe(400);
  });

  it("saves a default proxy live and refuses deleting it while it is the default", async () => {
    const saved = await call("PUT", "/v1/config/session-defaults", { ...OFF, record: true, proxy: "home" });
    expect(saved.status).toBe(200);
    expect((await call("GET", "/v1/config/settings")).json.sessionDefaults).toEqual({ ...OFF, record: true, proxy: "home" });
    expect(readFileSync(CONFIG, "utf8")).toContain("sessionDefaults");
    expect((await call("DELETE", "/v1/proxies/home")).status).toBe(409);
    await call("PUT", "/v1/config/session-defaults", OFF);
    expect(readFileSync(CONFIG, "utf8")).not.toContain("sessionDefaults");
  });

  it("saves advanced settings within bounds and refuses values outside them", async () => {
    const saved = await call("PUT", "/v1/config/advanced", { connectionTimeout: 20000, queueMaxSize: 5, cooldownFailureThreshold: 0.8 });
    expect(saved.status).toBe(200);
    expect(saved.json.advanced).toMatchObject({ connectionTimeout: 20000, queueMaxSize: 5, cooldownFailureThreshold: 0.8, queueTimeoutMs: 30000 });
    expect(readFileSync(CONFIG, "utf8")).toContain("connectionTimeout: 20000");
    expect(readFileSync(CONFIG, "utf8")).toContain("maxSize: 5");
    expect((await call("PUT", "/v1/config/advanced", { connectionTimeout: 10 })).status).toBe(400);
    const rate = await call("PUT", "/v1/config/advanced", { cooldownFailureThreshold: 2 });
    expect(rate.status).toBe(400);
    expect(rate.json.details).toEqual(["Failure rate must be between 0 and 100 percent"]);
    expect((await call("PUT", "/v1/config/advanced", { port: 1 })).status).toBe(400);
  });
});
