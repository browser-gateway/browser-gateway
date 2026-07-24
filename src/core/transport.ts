/**
 * Environment-agnostic relay contract.
 *
 * Every browser-gateway deployment ultimately does the same thing at the
 * transport layer: accept a client WebSocket upgrade, open an upstream
 * WebSocket to a provider, and pipe bytes between them until either side
 * closes. Node.js does that with raw TCP + Duplex piping; Cloudflare
 * Workers does it with WebSocketPair + `fetch(url, {headers:{Upgrade}})`;
 * a Bun or Deno host would do it differently again.
 *
 * `RelayTransport` is the plug-in point. The routing brain in `core/`
 * remains environment-agnostic; each host implements the transport once
 * and shares everything above it (selection, cooldown, concurrency,
 * session tracking, profile eligibility).
 */

/** Direction of a byte or message flow relative to the client. */
export type RelayDirection = "in" | "out";

/** Terminal state of a relay attempt. */
export type RelayCloseReason =
  | { kind: "client-closed" }
  | { kind: "upstream-closed" }
  | { kind: "client-error"; error: Error }
  | { kind: "upstream-error"; error: Error }
  | { kind: "upstream-rejected"; status: number; body?: string }
  | { kind: "upstream-timeout" };

/** Callbacks the caller can supply to observe the relay's lifetime. */
export interface RelayCallbacks {
  /** Called once the upstream 101 response is received and byte-piping is live. */
  onUpgrade?: (info: { upstreamStatus: number }) => void;
  /** Called for every byte chunk piped in either direction. Optional; may add overhead. */
  onBytes?: (dir: RelayDirection, bytes: number) => void;
  /** Called for every discrete message in either direction. Cheaper than onBytes. */
  onMessage?: (dir: RelayDirection) => void;
  /** Called exactly once when the relay terminates, whether cleanly or with an error. */
  onClose?: (reason: RelayCloseReason) => void;
}

/** Options passed to `RelayTransport.relay()`. */
export interface RelayOptions extends RelayCallbacks {
  /**
   * Host-specific handle to the accepted client connection.
   *   - Node.js: `Duplex` socket (the one delivered to the http upgrade handler).
   *   - Cloudflare Workers: the server-side `WebSocket` from `new WebSocketPair()`.
   * The transport implementation MUST know the shape it expects and cast internally.
   */
  client: unknown;

  /**
   * Host-specific ancillary data needed to complete the client-side upgrade.
   *   - Node.js: `{ req: IncomingMessage, head: Buffer }`.
   *   - Cloudflare Workers: usually unused (the WebSocketPair is already accepted).
   */
  clientMeta?: unknown;

  /** Absolute upstream URL. Must be `ws:` or `wss:`. */
  upstreamUrl: string;

  /** Extra headers to include in the upstream upgrade request (provider auth, subprotocol, etc.). */
  upstreamHeaders?: Record<string, string>;

  /** How long to wait for the upstream 101 response before giving up (milliseconds). */
  connectionTimeoutMs?: number;

  /**
   * Optional session identifier the transport should echo back to the client
   * in the 101 response headers as `X-Session-Id`. Kept in the interface so
   * every host produces the same header contract.
   */
  sessionId?: string;
}

/** Result of a `relay()` invocation. */
export interface RelayResult {
  /** True iff the upstream upgrade succeeded and byte-piping is now active. */
  connected: boolean;
  /**
   * If `connected` is false, the reason. If `connected` is true, this may still
   * be populated when the relay later terminates — inspect after `onClose` fires
   * or await the returned promise's `close` deferred if the implementation exposes it.
   */
  reason?: RelayCloseReason;
}

/**
 * Bidirectional WebSocket relay between an accepted client and an upstream URL.
 *
 * Implementations MUST:
 *   1. Establish the upstream WebSocket using the appropriate host primitive.
 *   2. Complete the client-side 101 handshake (echoing `X-Session-Id` if provided).
 *   3. Pipe payload bytes/frames in both directions until either side closes.
 *   4. Emit `onClose` exactly once when the relay terminates.
 *   5. Be safe to call concurrently on independent options (per-connection state).
 *
 * Implementations MUST NOT:
 *   - Track sessions, credits, or provider health themselves. Those concerns
 *     belong to the caller and are surfaced via `RelayCallbacks`.
 *   - Perform provider selection or cooldown enforcement. That's `core/router/`.
 *   - Persist anything. The transport is stateless per invocation.
 */
export interface RelayTransport {
  readonly name: string;
  relay(opts: RelayOptions): Promise<RelayResult>;
}
