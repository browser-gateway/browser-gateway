/** Pure webhook delivery with retry. Isomorphic — Node, Cloudflare Workers, Bun, Deno. */

export interface WebhookPayload {
  version: string;
  timestamp: string;
  event: string;
  status: "firing" | "resolved";
  source: string;
  data: Record<string, unknown>;
}

export interface WebhookDeliverOptions {
  /** Millisecond retry delays. Defaults to [1000, 5000, 15000]. */
  retryDelays?: readonly number[];
  /** Per-request timeout in ms. Defaults to 5000. */
  timeoutMs?: number;
  /** Called once when delivery succeeds. Attempt is 0-indexed. */
  onSuccess?: (attempt: number) => void;
  /** Called each time an attempt fails (before retry). */
  onAttemptFailed?: (attempt: number, err: Error) => void;
  /** Called once when all retries are exhausted. */
  onFailure?: (finalErr: Error) => void;
}

export interface WebhookDeliverResult {
  delivered: boolean;
  attempts: number;
}

const DEFAULT_RETRY_DELAYS = [1000, 5000, 15000] as const;
const DEFAULT_TIMEOUT_MS = 5000;

export async function deliverWebhook(
  url: string,
  payload: WebhookPayload,
  opts: WebhookDeliverOptions = {},
): Promise<WebhookDeliverResult> {
  const retryDelays = opts.retryDelays ?? DEFAULT_RETRY_DELAYS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let attempt = 0;
  for (;;) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      opts.onSuccess?.(attempt);
      return { delivered: true, attempts: attempt + 1 };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      opts.onAttemptFailed?.(attempt, error);
      if (attempt >= retryDelays.length) {
        opts.onFailure?.(error);
        return { delivered: false, attempts: attempt + 1 };
      }
      await new Promise((r) => setTimeout(r, retryDelays[attempt]));
      attempt++;
    }
  }
}
