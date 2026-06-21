import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import type { CDPClient } from "./cdp.js";

/**
 * Assert that a WebSocket is open. Used by every CDP send() implementation —
 * extracted so the "CDP not connected" guard message stays consistent.
 */
export function assertCdpConnected(ws: WebSocket | null): asserts ws is WebSocket {
  // We intentionally use the numeric OPEN constant value (1) here so this
  // helper can be a `function` type without binding to a specific ws module
  // instance — both `import WebSocket from "ws"` clients agree on `1 = OPEN`.
  if (!ws || ws.readyState !== 1) {
    throw new Error("CDP not connected");
  }
}

/**
 * Common base class that implements the typed `on(event, listener)` and
 * `off(event, listener)` overloads required by the `CDPClient` interface.
 *
 * Node's `EventEmitter` is too loosely typed for the CDPClient contract — every
 * concrete CDP client (the production WS one, the in-memory mock, the MCP
 * variant) needs the same two-line override. Extracting it here keeps the
 * contract in one place and stops three different copies of the same
 * boilerplate from drifting.
 */
export abstract class TypedCdpEventEmitter
  extends EventEmitter
  implements Pick<CDPClient, "on" | "off">
{
  on(event: string, listener: (params: unknown) => void): this {
    return super.on(event, listener);
  }
  off(event: string, listener: (params: unknown) => void): this {
    return super.off(event, listener);
  }
}
