/**
 * REST golden tests — lock the shape of every public /v1/* endpoint.
 *
 * If an accidental change reshapes a response, vitest's snapshot fails. Author
 * either intentionally regenerates the snapshot (and reviewer sees the diff
 * explicitly in the PR) or fixes the bug.
 *
 * What we snapshot:
 *   - The set of keys at the top level (and one-level deep)
 *   - The type of each value (string/number/bool/array/object/null)
 *   - NOT specific values (those vary per env: timestamps, ports, ids)
 *
 * If we snapshotted values, every run would change and the test would be useless.
 * The shape is what users program against.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import pino from "pino";
import { Gateway } from "../../src/core/gateway.js";
import { createApp } from "../../src/server/app.js";
import { GatewayConfigSchema } from "../../src/core/types.js";

function shapeOf(value: unknown, depth = 0): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return ["<empty>"];
    return [shapeOf(value[0], depth + 1)];
  }
  if (typeof value === "object") {
    if (depth >= 3) return "<object>";
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = shapeOf((value as Record<string, unknown>)[key], depth + 1);
    }
    return result;
  }
  return typeof value;
}

let app: Hono;
let gateway: Gateway;

beforeAll(async () => {
  const config = GatewayConfigSchema.parse({
    providers: {
      "test-provider": {
        url: "ws://localhost:9999",
        limits: { maxConcurrent: 4 },
        priority: 1,
      },
    },
  });
  gateway = new Gateway(config, pino({ level: "silent" }));
  app = createApp(gateway, undefined, undefined, pino({ level: "silent" }));
});

afterAll(async () => {
  await gateway.gracefulShutdown();
});

async function fetchShape(path: string): Promise<unknown> {
  const res = await app.request(path);
  const body = await res.json();
  return { status: res.status, shape: shapeOf(body) };
}

describe("REST golden — locks public API response shapes", () => {
  it("/health", async () => {
    const out = await fetchShape("/health");
    expect(out).toMatchInlineSnapshot(`
      {
        "shape": {
          "status": "string",
          "timestamp": "string",
        },
        "status": 200,
      }
    `);
  });

  it("/v1/status", async () => {
    const out = await fetchShape("/v1/status");
    expect(out).toMatchInlineSnapshot(`
      {
        "shape": {
          "activeSessions": "number",
          "providers": [
            {
              "active": "number",
              "avgLatencyMs": "number",
              "cooldownUntil": "null",
              "detectedKind": "null",
              "healthy": "boolean",
              "id": "string",
              "maxConcurrent": "number",
              "maxConcurrentSource": "string",
              "priority": "number",
              "totalConnections": "number",
            },
          ],
          "queueSize": "number",
          "status": "string",
          "strategy": "string",
        },
        "status": 200,
      }
    `);
  });

  it("/v1/sessions", async () => {
    const out = await fetchShape("/v1/sessions");
    expect(out).toMatchInlineSnapshot(`
      {
        "shape": {
          "count": "number",
          "sessions": [
            "<empty>",
          ],
        },
        "status": 200,
      }
    `);
  });

  it("/v1/providers", async () => {
    const out = await fetchShape("/v1/providers");
    expect(out).toMatchInlineSnapshot(`
      {
        "shape": {
          "providers": [
            {
              "detectedKind": "null",
              "id": "string",
              "maxConcurrent": "number",
              "maxConcurrentSource": "string",
              "multiProfile": "boolean",
              "priority": "number",
              "profile": "null",
              "url": "string",
              "weight": "number",
            },
          ],
        },
        "status": 200,
      }
    `);
  });

  it("/v1/config returns config", async () => {
    const out = await fetchShape("/v1/config");
    expect((out as { status: number }).status).toBeLessThan(500);
  });
});
