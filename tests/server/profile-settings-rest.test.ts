import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import pino from "pino";
import { createProfileRoutes } from "../../src/server/rest/profiles.js";
import { FilesystemProfileStore } from "../../src/server/profile/filesystem-store.js";
import type { GatewayConfig } from "../../src/core/types.js";

let dir: string;
let store: FilesystemProfileStore;
let call: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: Record<string, unknown> }>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bg-profile-settings-"));
  store = new FilesystemProfileStore({ storePath: dir });
  const config = { proxies: { home: { url: "http://127.0.0.1:8080" } }, sessionDefaults: { proxy: null, profile: null } } as unknown as GatewayConfig;
  const app = createProfileRoutes({ store, dekByVersion: new Map([[1, randomBytes(32)]]), logger: pino({ level: "silent" }), config });
  call = async (method, path, body) => {
    const res = await app.request(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("profile proxy setting over REST", () => {
  it("creates a profile with a proxy, shows it in the list, and changes or clears it", async () => {
    expect((await call("POST", "/profiles/create", { id: "work", proxy: "home" })).json["proxy"]).toBe("home");
    expect((await call("GET", "/profiles")).json["profiles"]).toEqual([expect.objectContaining({ id: "work", proxy: "home" })]);
    expect(await call("PUT", "/profiles/work/settings", { proxy: null })).toEqual({ status: 200, json: { id: "work", proxy: null } });
    expect((await call("GET", "/profiles/work")).json["proxy"]).toBeNull();
  });

  it("refuses an unknown proxy, a missing field, and an unknown profile", async () => {
    await call("POST", "/profiles/create", { id: "work" });
    expect((await call("POST", "/profiles/create", { id: "other", proxy: "nope" })).status).toBe(400);
    expect((await call("GET", "/profiles")).json["count"]).toBe(1);
    expect((await call("PUT", "/profiles/work/settings", { proxy: "nope" })).status).toBe(400);
    expect((await call("PUT", "/profiles/work/settings", {})).status).toBe(400);
    expect((await call("PUT", "/profiles/ghost/settings", { proxy: null })).status).toBe(404);
  });

  it("will not follow a symlinked settings file", async () => {
    await call("POST", "/profiles/create", { id: "work" });
    await writeFile(join(dir, "elsewhere.json"), JSON.stringify({ proxy: "home" }));
    await symlink(join(dir, "elsewhere.json"), join(dir, "work", "settings.json"));
    await expect(store.getSettings("work")).rejects.toThrow(/not a regular file/);
    await expect(store.putSettings("work", { proxy: null })).rejects.toThrow(/symlinked/);
  });
});
