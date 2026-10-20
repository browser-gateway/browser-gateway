import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { reservePort, runToken, waitForOwnGateway } from "../helpers/harness.js";

const RUN = runToken();
const TMP = mkdtempSync(join(tmpdir(), "bg-proxy-crud-"));
const CONFIG = join(TMP, "gateway.yml");
let gateway: ChildProcess;
let base = "";
let port = 0;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; text: string; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null };
}

function upgrade(query: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/connect${query}`);
    ws.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (d: Buffer) => { body += d.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    ws.on("open", () => { resolve({ status: 101, body: "" }); ws.close(); });
    ws.on("error", () => undefined);
  });
}

beforeAll(async () => {
  port = await reservePort();
  base = `http://127.0.0.1:${port}`;
  writeFileSync(CONFIG, `version: 1
gateway:
  port: ${port}
providers:
  remote-${RUN}:
    url: ws://127.0.0.1:1
proxies:
  vendor:
    url: http://alice:hunter2-secret@proxy.example.com:8080
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

describe("proxy management API", () => {
  it("adds a proxy that connections can use at once, without a restart", async () => {
    expect((await upgrade("?proxy=home")).body).toContain("not configured");
    const created = await call("POST", "/v1/proxies", { name: "home", address: "http://127.0.0.1:3128", bypass: ["*.internal"] });
    expect(created.status).toBe(201);
    expect((await upgrade("?proxy=home")).body).toContain("No provider can apply");
  });

  it("refuses a proxy with a login or an https address, without repeating the password", async () => {
    const withLogin = await call("POST", "/v1/proxies", { name: "login", address: "http://bob:leaky-pass@proxy.example.com:8080" });
    expect(withLogin.status).toBe(400);
    expect(withLogin.text).not.toContain("leaky-pass");
    expect(withLogin.text).toContain("http or socks5 proxies without a login");
    expect((await call("POST", "/v1/proxies", { name: "tls", address: "https://proxy.example.com:443" })).status).toBe(400);
    expect(readFileSync(CONFIG, "utf8")).not.toContain("leaky-pass");
  });

  it("lists a saved proxy with a login as unusable without its password, and removing the login makes it usable", async () => {
    const listed = await call("GET", "/v1/proxies");
    expect(listed.text).not.toContain("hunter2");
    expect(listed.text).not.toContain("alice");
    expect(listed.json.proxies.find((p: { name: string }) => p.name === "vendor")).toMatchObject({ hasCredentials: true, usable: false, server: "http://proxy.example.com:8080" });
    expect((await call("PUT", "/v1/proxies/vendor", { address: "http://proxy2.example.com:8081" })).status).toBe(400);
    const cleared = await call("PUT", "/v1/proxies/vendor", { address: "http://proxy2.example.com:8081", clearCredentials: true });
    expect(cleared.status).toBe(200);
    expect(readFileSync(CONFIG, "utf8")).not.toContain("hunter2");
    expect((await call("GET", "/v1/proxies")).json.proxies.find((p: { name: string }) => p.name === "vendor")).toMatchObject({ hasCredentials: false, usable: true });
  });

  it("refuses the reserved name, bad names, duplicates and invalid addresses", async () => {
    expect((await call("POST", "/v1/proxies", { name: "none", address: "http://h:1" })).status).toBe(400);
    expect((await call("POST", "/v1/proxies", { name: "NONE", address: "http://h:1" })).status).toBe(400);
    expect((await call("POST", "/v1/proxies", { name: "bad name", address: "http://h:1" })).status).toBe(400);
    expect((await call("POST", "/v1/proxies", { name: "home", address: "http://h:1" })).status).toBe(409);
    const bad = await call("POST", "/v1/proxies", { name: "socks-login", address: "socks5://h:1080", username: "u", password: "leaky-pass" });
    expect(bad.status).toBe(400);
    expect(bad.text).not.toContain("leaky-pass");
  });

  it("tests a proxy and reports a clean failure when it cannot be reached", async () => {
    const idle = await reservePort();
    await call("POST", "/v1/proxies", { name: "dead", address: `http://127.0.0.1:${idle}` });
    const tested = await call("POST", "/v1/proxies/dead/test");
    expect(tested.status).toBe(200);
    expect(tested.json).toMatchObject({ ok: false });
    expect(typeof tested.json.error).toBe("string");
    expect((await call("POST", "/v1/proxies/missing/test")).status).toBe(404);
  });

  it("deletes a proxy and connections stop finding it", async () => {
    expect((await call("DELETE", "/v1/proxies/home")).status).toBe(200);
    expect((await call("DELETE", "/v1/proxies/home")).status).toBe(404);
    expect((await upgrade("?proxy=home")).body).toContain("not configured");
    expect(readFileSync(CONFIG, "utf8")).not.toContain("127.0.0.1:3128");
  });
});
