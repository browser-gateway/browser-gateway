import type { HelperPoolCdpClient } from "./helper-pool-client.js";
import { withTimeout } from "./cdp-utils.js";

export interface OriginSnapshot {
  origin: string;
  localStorage: Record<string, string>;
}

const SNAPSHOT_EXPR = `
  (() => {
    try {
      const ls = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k !== null) ls[k] = localStorage.getItem(k) ?? "";
      }
      return JSON.stringify({ origin: location.origin, localStorage: ls });
    } catch (e) {
      return JSON.stringify({ __error: String((e && e.message) || e) });
    }
  })()
`;

interface EvaluateResponse {
  result?: { value?: unknown };
  exceptionDetails?: unknown;
}

/** Snapshots the live top-frame origin + full localStorage via `Runtime.evaluate`
 *  on `sessionId`. If `contextId` is provided, the eval is pinned to that
 *  specific execution context — critical for capturing the OLD document
 *  during a top-frame navigation, before the new document takes over.
 *  Returns null on eval failure, race (context destroyed before eval ran),
 *  or non-http(s) origin. Never throws. */
export async function captureCurrentOriginSnapshot(
  client: HelperPoolCdpClient,
  sessionId: string | undefined,
  timeoutMs = 5_000,
  contextId?: number,
): Promise<OriginSnapshot | null> {
  let value: unknown;
  try {
    const params: Record<string, unknown> = {
      expression: SNAPSHOT_EXPR,
      returnByValue: true,
      awaitPromise: false,
    };
    if (contextId !== undefined) params.contextId = contextId;
    const resp = await withTimeout(
      client.sendOn<EvaluateResponse>("Runtime.evaluate", params, sessionId),
      timeoutMs,
      "capture-current-origin",
    );
    if (resp?.exceptionDetails) return null;
    value = resp?.result?.value;
  } catch {
    return null;
  }
  if (typeof value !== "string") return null;

  let parsed: { origin?: string; localStorage?: Record<string, string>; __error?: string };
  try {
    parsed = JSON.parse(value) as {
      origin?: string;
      localStorage?: Record<string, string>;
      __error?: string;
    };
  } catch {
    return null;
  }
  if (parsed.__error || typeof parsed.origin !== "string") return null;
  if (!parsed.origin.startsWith("http")) return null;
  return {
    origin: parsed.origin,
    localStorage: parsed.localStorage ?? {},
  };
}
