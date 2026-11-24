import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("browse session directory ownership", () => {
  let root: string;
  let planted: Server | null = null;
  const savedEnv = { TMPDIR: process.env.TMPDIR, HOME: process.env.HOME };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bg-browse-dir-"));
    process.env.TMPDIR = join(root, "tmp");
    process.env.HOME = join(root, "home");
    mkdirSync(process.env.TMPDIR, { recursive: true });
    mkdirSync(process.env.HOME, { recursive: true });
    vi.resetModules();
  });

  afterEach(async () => {
    if (planted) await new Promise<void>((resolve) => planted!.close(() => resolve()));
    planted = null;
    process.env.TMPDIR = savedEnv.TMPDIR;
    process.env.HOME = savedEnv.HOME;
    rmSync(root, { recursive: true, force: true });
  });

  async function plantSocket(socketPath: string): Promise<{ connections: () => number }> {
    let count = 0;
    planted = createServer((sock) => {
      count++;
      sock.destroy();
    });
    await new Promise<void>((resolve) => planted!.listen(socketPath, resolve));
    return { connections: () => count };
  }

  it.skipIf(process.platform === "win32")("refuses a group/world-accessible directory before talking to a live socket in it", async () => {
    const client = await import("../../src/server/browse/client.js");
    const socketPath = client.socketPathFor("default");
    const dir = socketPath.slice(0, socketPath.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o777);
    const probe = await plantSocket(socketPath);

    await expect(client.ensureDaemon("default", "ws://127.0.0.1:1")).rejects.toThrow(/not a private directory/);
    await expect(
      client.sendToDaemon(socketPath, { id: 1, verb: "close", args: [], flags: {} }),
    ).rejects.toThrow(/not a private directory/);
    expect(() => client.listSessions()).toThrow(/not a private directory/);
    expect(probe.connections()).toBe(0);
  });
});
