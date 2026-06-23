/**
 * `WS /v1/live` upgrade handler. Bridges a dashboard WebSocket to a CDP
 * screencast session against a chosen provider.
 *
 * Behaviour:
 *   1. Validate path, auth (BG_TOKEN), gateway-not-shutting-down
 *   2. Validate `?provider=<id>` exists in the registry, is healthy
 *   3. Resolve the provider's CDP WebSocket URL
 *   4. Upgrade the incoming socket to a real WS using the `ws` library
 *   5. Construct ScreencastBridge, call setup() + attachDashboard()
 *
 * Auth + provider rules match the spec decisions:
 *   - Q2: required `?provider=<id>`, no automatic routing
 *   - Q3: spawn-new (no `?sessionId=` support in v0.3.0)
 *   - Q6: any CDP-compatible provider; raw Chrome + Pi Steel are the
 *         primary targets for v0.3.0 tier-3 testing
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import type { Logger } from "pino";
import type { Gateway } from "../../core/index.js";
import { resolveWsUrl } from "../../core/providers/cdp.js";
import { LifecycleError, type ProfileLifecycle, type AcquiredProfile } from "../profile/lifecycle.js";
import { runBackgroundInject } from "../../core/profile/index.js";
import { ScreencastBridge } from "./screencast-bridge.js";
import { installLazyHydration } from "./lazy-hydration.js";

function safeTokenCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function extractBearer(header: string | undefined): string | undefined {
  if (!header || !header.startsWith("Bearer ")) return undefined;
  return header.slice(7);
}

function writeHttpError(socket: Duplex, status: number, body: Record<string, unknown>): void {
  const text = JSON.stringify(body);
  socket.write(
    `HTTP/1.1 ${status} ${status === 400 ? "Bad Request" : status === 401 ? "Unauthorized" : status === 503 ? "Service Unavailable" : "Error"}\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(text)}\r\n\r\n` +
      text,
  );
  socket.destroy();
}

export interface CreateLiveHandlerDeps {
  gateway: Gateway;
  logger: Logger;
  /** Required gateway BG_TOKEN. If unset, auth is disabled. */
  token?: string;
  /** Optional. When set, `?profile=<id>` is supported. */
  profileLifecycle?: ProfileLifecycle;
}

export function createLiveUpgradeHandler(deps: CreateLiveHandlerDeps) {
  const { gateway, logger, token, profileLifecycle } = deps;
  // Single WSS used in noServer mode to handle the upgrade handshake. The ws
  // library handles all the HTTP/1.1 details for us; we then take the resulting
  // ws object and hand it to the bridge.
  const wss = new WebSocketServer({ noServer: true });

  async function handle(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Auth.
    if (token) {
      const reqToken =
        url.searchParams.get("token") ?? extractBearer(req.headers.authorization);
      if (!reqToken || !safeTokenCompare(reqToken, token)) {
        writeHttpError(socket, 401, { error: "Unauthorized" });
        return;
      }
    }

    if (gateway.shuttingDown) {
      writeHttpError(socket, 503, { error: "Gateway is shutting down" });
      return;
    }

    // Provider selection — explicit ?provider=<id> required per spec Q2.
    const providerId = url.searchParams.get("provider");
    if (!providerId) {
      writeHttpError(socket, 400, {
        error: "live view requires ?provider=<id> (no auto-routing in v0.3.0)",
      });
      return;
    }

    const provider = gateway.registry.get(providerId);
    if (!provider) {
      writeHttpError(socket, 400, { error: `unknown provider: ${providerId}` });
      return;
    }
    if (!provider.healthy) {
      writeHttpError(socket, 503, { error: `provider not healthy: ${providerId}` });
      return;
    }

    // Resolve to a WS URL.
    let providerWsUrl: string;
    try {
      providerWsUrl = await resolveWsUrl(provider.config.url);
    } catch (err) {
      logger.warn(
        { providerId, error: err instanceof Error ? err.message : String(err) },
        "live: failed to resolve provider WS URL",
      );
      writeHttpError(socket, 503, { error: "could not reach provider" });
      return;
    }

    // Optional profile. Acquire lock + decrypt cookies up-front; inject after
    // the bridge has connected; commit on close. Matches the /v1/connect path.
    const profileId = url.searchParams.get("profile");
    let acquired: AcquiredProfile | null = null;
    if (profileId !== null) {
      if (!profileLifecycle) {
        writeHttpError(socket, 400, { error: "profiles are not enabled on this gateway" });
        return;
      }
      try {
        acquired = await profileLifecycle.acquire(profileId);
        logger.info(
          { profileId, isExisting: acquired.isExisting, cookies: acquired.cookies.length },
          "live: profile acquired",
        );
      } catch (err) {
        if (err instanceof LifecycleError) {
          if (err.reason === "INVALID_ID") {
            writeHttpError(socket, 400, { error: err.message });
            return;
          }
          if (err.reason === "LOCK_HELD") {
            writeHttpError(socket, 409, { error: err.message });
            return;
          }
        }
        logger.error(
          { profileId, error: err instanceof Error ? err.message : String(err) },
          "live: profile acquire failed",
        );
        writeHttpError(socket, 500, { error: "profile acquire failed" });
        return;
      }
    }

    // Parse optional screencast tuning params (clamped + defaulted).
    const format = url.searchParams.get("format") === "png" ? "png" : "jpeg";
    const quality = clampInt(url.searchParams.get("quality"), 1, 100, 60);
    const maxWidth = clampInt(url.searchParams.get("maxWidth"), 320, 3840, 1280);
    const maxHeight = clampInt(url.searchParams.get("maxHeight"), 240, 2160, 720);
    const everyNthFrame = clampInt(url.searchParams.get("everyNthFrame"), 1, 10, 2);

    // Upgrade.
    wss.handleUpgrade(req, socket, head, async (ws) => {
      logger.info(
        { providerId, profileId, format, quality, maxWidth, maxHeight, everyNthFrame },
        "live: dashboard connected",
      );

      const bridge = new ScreencastBridge({
        providerWsUrl,
        format,
        quality,
        maxWidth,
        maxHeight,
        everyNthFrame,
        logger,
      });

      // When the bridge closes (dashboard disconnects, provider dies, etc.),
      // commit the profile state (best-effort) so the user's next session
      // sees the latest cookies.
      let cleanupRan = false;
      const cleanup = async () => {
        if (cleanupRan) return;
        cleanupRan = true;
        if (acquired && profileLifecycle) {
          try {
            await profileLifecycle.commit(acquired, providerWsUrl);
          } catch (err) {
            logger.warn(
              { profileId, error: err instanceof Error ? err.message : String(err) },
              "live: profile commit failed (state preserved)",
            );
          }
        }
      };
      ws.on("close", () => { void cleanup(); });

      // Track origins injected by any path (eager / lazy / background).
      const alreadyInjected = new Set<string>();
      let teardownLazy: (() => void) | null = null;
      const backgroundAbort = new AbortController();

      try {
        await bridge.setup();
        // Inject AFTER setup but BEFORE the dashboard sees frames — cookies
        // and top-K storage need to be in the browser before the user navigates.
        if (acquired && profileLifecycle) {
          const result = await profileLifecycle.inject(acquired, providerWsUrl);
          for (const o of result.originsInjected) alreadyInjected.add(o);

          // Install lazy hydration on the bridge's attached target. The
          // remaining (deferred) origins get injected the first time the user
          // navigates to them.
          const session = bridge.getCdpAndSession();
          if (session && result.originsDeferred.length > 0) {
            teardownLazy = installLazyHydration({
              cdp: session.cdp,
              mainSessionId: session.sessionId,
              storage: acquired.storage,
              alreadyInjected,
              logger,
            });

            // Phase B: kick off background loader for ALL deferred origins on
            // its own transient CDP connection. Doesn't block the user —
            // session is already attached. Errors logged, not thrown.
            void runBackgroundInject({
              origins: result.originsDeferred,
              storage: acquired.storage,
              providerWsUrl,
              alreadyInjected,
              signal: backgroundAbort.signal,
            })
              .then((bg) => {
                logger.info(
                  {
                    profileId,
                    injected: bg.injected.length,
                    skipped: bg.skipped.length,
                    durationMs: bg.durationMs,
                  },
                  "live: background origin hydration finished",
                );
              })
              .catch((err) => {
                logger.warn(
                  { profileId, error: err instanceof Error ? err.message : String(err) },
                  "live: background hydration failed",
                );
              });
          }
        }
        bridge.attachDashboard(ws);
        ws.on("close", () => {
          if (teardownLazy) teardownLazy();
          backgroundAbort.abort();
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ providerId, error: message }, "live: setup failed");
        try {
          ws.send(JSON.stringify({ type: "error", code: "SETUP_FAILED", message }));
        } catch {
          // best-effort
        }
        try {
          ws.close(1011, "setup failed");
        } catch {
          // best-effort
        }
        bridge.close();
        // If setup failed before we could inject, release the lock without
        // committing — there's nothing to save.
        if (acquired && profileLifecycle) {
          await profileLifecycle.release(acquired).catch(() => {});
          acquired = null;
        }
      }
    });
  }

  return { handle };
}

function clampInt(raw: string | null, lo: number, hi: number, fallback: number): number {
  if (raw === null) return fallback;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}
