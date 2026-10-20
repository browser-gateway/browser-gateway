import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reservePort, runToken, waitForOwnGateway } from "../helpers/harness.js";

const RUN = runToken();
const TMP = mkdtempSync(join(tmpdir(), "bg-env-placeholders-"));
const CONFIG = join(TMP, "gateway.yml");
const SECRETS = {
  BG_IT_PROVIDER_TOKEN: `provider-secret-${RUN}`,
  BG_IT_HEADER_TOKEN: `header-secret-${RUN}`,
  BG_IT_PROXY_PASS: `proxy-secret-${RUN}`,
  BG_IT_HOOK_TOKEN: `hook-secret-${RUN}`,
};
let gateway: ChildProcess;
let base = "";

async function call(method: string, path: string, body?: unknown): Promise<number> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  await res.text();
  return res.status;
}

function expectNoSecretsOnDisk(): void {
  for (const file of [CONFIG, `${CONFIG}.backup`]) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
  }
  const text = readFileSync(CONFIG, "utf8");
  for (const name of Object.keys(SECRETS)) expect(text).toContain(`\${${name}}`);
}

beforeAll(async () => {
  const port = await reservePort();
  base = `http://127.0.0.1:${port}`;
  writeFileSync(CONFIG, `version: 1
gateway:
  port: ${port}
providers:
  remote-${RUN}:
    url: ws://127.0.0.1:1/?token=\${BG_IT_PROVIDER_TOKEN}
    headers:
      Authorization: Bearer \${BG_IT_HEADER_TOKEN}
proxies:
  home:
    url: http://user:\${BG_IT_PROXY_PASS}@127.0.0.1:3128
webhooks:
  - url: https://hooks.example.invalid/\${BG_IT_HOOK_TOKEN}
logging:
  level: error
`);
  gateway = spawn("npx", ["tsx", "src/server/index.ts", "serve", "--config", CONFIG], { cwd: process.cwd(), stdio: "ignore", env: { ...process.env, ...SECRETS, BG_TOKEN: "" } });
  await waitForOwnGateway(port, gateway, RUN);
}, 30_000);

afterAll(() => {
  gateway?.kill("SIGTERM");
  rmSync(TMP, { recursive: true, force: true });
});

describe("dashboard saves keep env placeholders in gateway.yml", () => {
  it("keeps every placeholder through provider, routing, defaults, proxy and advanced saves", async () => {
    expect(await call("PUT", `/v1/providers/remote-${RUN}`, { priority: 3 })).toBe(200);
    expectNoSecretsOnDisk();
    expect(await call("PUT", "/v1/config/strategy", { strategy: "round-robin" })).toBe(200);
    expectNoSecretsOnDisk();
    expect(await call("PUT", "/v1/config/session-defaults", { record: true, profile: null, saveProfile: false, proxy: null })).toBe(200);
    expectNoSecretsOnDisk();
    expect(await call("POST", "/v1/proxies", { name: "office", address: "http://127.0.0.1:3129" })).toBe(201);
    expectNoSecretsOnDisk();
    expect(await call("PUT", "/v1/config/advanced", { queueMaxSize: 20 })).toBe(200);
    expectNoSecretsOnDisk();
    const text = readFileSync(CONFIG, "utf8");
    expect(text).toContain("priority: 3");
    expect(text).toContain("round-robin");
    expect(text).toContain("office");
  });
});
