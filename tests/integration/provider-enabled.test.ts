import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { reservePort, waitForOwnGateway } from "../helpers/harness.js";

const TMP_DIR = mkdtempSync(join(tmpdir(), "bg-enabled-test-"));
const CONFIG_PATH = join(TMP_DIR, "gateway.yml");
let base = "";
let wsBase = "";
let gateway: ChildProcess;
const upstreams: Server[] = [];

async function namedUpstream(name: string): Promise<number> {
  const port = await reservePort();
  const server = createServer();
  new WebSocketServer({ server }).on("connection", (ws) => {
    ws.send(name);
    ws.on("message", (data) => ws.send(data.toString()));
  });
  server.listen(port);
  upstreams.push(server);
  return port;
}

function connect(query = ""): Promise<{ status: number; firstMessage?: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/v1/connect${query}`);
    ws.once("message", (data) => {
      resolve({ status: 101, firstMessage: data.toString() });
      ws.close();
    });
    ws.once("unexpected-response", (_req, res) => resolve({ status: res.statusCode ?? 0 }));
    ws.once("error", reject);
  });
}

async function setEnabled(id: string, enabled: boolean): Promise<Response> {
  return fetch(`${base}/v1/providers/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

async function statusIds(): Promise<string[]> {
  const body = (await (await fetch(`${base}/v1/status`)).json()) as { providers: Array<{ id: string }> };
  return body.providers.map((p) => p.id);
}

beforeAll(async () => {
  const port = await reservePort();
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
  const primary = await namedUpstream("primary");
  const backup = await namedUpstream("backup");
  writeFileSync(
    CONFIG_PATH,
    `version: 1
gateway:
  port: ${port}
  defaultStrategy: round-robin
providers:
  enabled-primary:
    url: ws://127.0.0.1:${primary}
  enabled-backup:
    url: ws://127.0.0.1:${backup}
    enabled: false
logging:
  level: error
`,
  );
  gateway = spawn("npx", ["tsx", "src/server/index.ts", "serve", "--config", CONFIG_PATH], {
    cwd: process.cwd(),
    stdio: "pipe",
    env: { ...process.env, BG_TOKEN: "" },
  });
  await waitForOwnGateway(port, gateway, "enabled-primary");
}, 30_000);

afterAll(() => {
  gateway?.kill("SIGTERM");
  for (const s of upstreams) s.close();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("a provider disabled in gateway.yml", () => {
  it("is listed with enabled false so it can be switched back on", async () => {
    const body = (await (await fetch(`${base}/v1/providers`)).json()) as {
      providers: Array<{ id: string; enabled: boolean }>;
    };
    expect(body.providers.find((p) => p.id === "enabled-backup")?.enabled).toBe(false);
    expect(body.providers.find((p) => p.id === "enabled-primary")?.enabled).toBe(true);
  });

  it("is left out of status", async () => {
    expect(await statusIds()).toEqual(["enabled-primary"]);
  });

  it("never receives an unpinned connection", async () => {
    for (let i = 0; i < 6; i++) {
      expect((await connect()).firstMessage).toBe("primary");
    }
  });

  it("answers a pinned connection the same way as an unknown provider", async () => {
    expect((await connect("?provider=enabled-backup")).status).toBe(400);
    expect((await connect("?provider=never-added")).status).toBe(400);
  });

  it("answers a pinned one-shot REST call the same way as an unknown provider", async () => {
    const call = (provider: string) =>
      fetch(`${base}/v1/content`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.org", provider }),
      });
    const disabled = await call("enabled-backup");
    const unknown = await call("never-added");
    expect(disabled.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(((await disabled.json()) as { error: string }).error).toContain("not configured");
  });
});

describe("switching a provider on and off through the API", () => {
  it("routes to it once enabled and persists the change", async () => {
    expect((await setEnabled("enabled-backup", true)).status).toBe(200);
    expect(await statusIds()).toEqual(expect.arrayContaining(["enabled-primary", "enabled-backup"]));
    expect((await connect("?provider=enabled-backup")).firstMessage).toBe("backup");
    const saved = parse(readFileSync(CONFIG_PATH, "utf-8")) as { providers: Record<string, { enabled?: boolean }> };
    expect(saved.providers["enabled-backup"]?.enabled).toBeUndefined();
  });

  it("stops routing to it at once when disabled and writes enabled false", async () => {
    expect((await setEnabled("enabled-primary", false)).status).toBe(200);
    for (let i = 0; i < 4; i++) {
      expect((await connect()).firstMessage).toBe("backup");
    }
    expect((await connect("?provider=enabled-primary")).status).toBe(400);
    const saved = parse(readFileSync(CONFIG_PATH, "utf-8")) as { providers: Record<string, { enabled?: boolean; url: string }> };
    expect(saved.providers["enabled-primary"]?.enabled).toBe(false);
    expect(saved.providers["enabled-primary"]?.url).toContain("ws://127.0.0.1:");
  });

  it("keeps a disabled provider's settings when another field is edited", async () => {
    const res = await fetch(`${base}/v1/providers/enabled-primary`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priority: 5 }),
    });
    expect(res.status).toBe(200);
    expect(await statusIds()).toEqual(["enabled-backup"]);
  });

  it("lets a session that started before disabling finish normally", async () => {
    await setEnabled("enabled-primary", true);
    const ws = new WebSocket(`${wsBase}/v1/connect?provider=enabled-primary`);
    await new Promise((r) => ws.once("message", r));
    await setEnabled("enabled-primary", false);
    ws.send("still here");
    const echoed = await new Promise<string>((r) => ws.once("message", (d) => r(d.toString())));
    expect(echoed).toBe("still here");
    ws.close();
    await setEnabled("enabled-primary", true);
    expect((await connect("?provider=enabled-primary")).firstMessage).toBe("primary");
  });
});
