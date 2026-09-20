import { createServer } from "node:http";
import { type AddressInfo } from "node:net";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

export const CLI_ENTRY = "dist/server/index.js";

/** Throws a named precondition error when the compiled CLI a test spawns is absent.
 *
 *  Without this, an unbuilt checkout fails with a module-not-found stack that
 *  reads like a dependency problem rather than a missing build step.
 */
export function requireBuiltCli(): void {
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(`${CLI_ENTRY} is missing. Run "npm run build" before the integration suite.`);
  }
}

/** Random token that makes one test run's ports, paths and provider ids unique. */
export function runToken(): string {
  return randomBytes(4).toString("hex");
}

/** Reserves a free TCP port by binding and releasing an ephemeral listener. */
export async function reservePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const FOREIGN = "served by a foreign gateway";

async function pollGateway(
  port: number,
  child: ChildProcess,
  attempts: number,
  ready: (port: number) => Promise<boolean>,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`gateway exited during startup (code ${child.exitCode}, signal ${child.signalCode})`);
    }
    try {
      if (await ready(port)) return;
    } catch (err) {
      if (err instanceof Error && err.message.includes(FOREIGN)) throw err;
    }
    await sleep(250);
  }
  throw new Error(`gateway on port ${port} did not become ready`);
}

/**
 * Waits until the gateway spawned as `child` answers `/health` on `port`.
 * Throws as soon as the child exits so a failed bind surfaces here instead of
 * as a confusing assertion failure later.
 */
export async function waitForGatewayHealth(port: number, child: ChildProcess, attempts = 80): Promise<void> {
  await pollGateway(port, child, attempts, async (p) => (await fetch(`http://127.0.0.1:${p}/health`)).ok);
}

/**
 * Waits until the gateway spawned as `child` serves this run's own config,
 * identified by `providerIdMarker` appearing in a `/v1/status` provider id.
 * Throws if the child exits or if another gateway answers the port.
 */
export async function waitForOwnGateway(
  port: number,
  child: ChildProcess,
  providerIdMarker: string,
  attempts = 80,
): Promise<void> {
  await pollGateway(port, child, attempts, async (p) => {
    const res = await fetch(`http://127.0.0.1:${p}/v1/status`);
    if (!res.ok) return false;
    const body = (await res.json()) as { providers?: Array<{ id: string }> };
    const ids = (body.providers ?? []).map((provider) => provider.id);
    if (ids.some((id) => id.includes(providerIdMarker))) return true;
    throw new Error(`port ${p} is ${FOREIGN} (providers: ${ids.join(", ")})`);
  });
}

/** Polls `predicate` until it returns true, or throws after `timeoutMs`. */
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 15_000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
    await sleep(intervalMs);
  }
}
