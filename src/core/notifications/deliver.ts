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
  /** Signing secret (`whsec_` + base64). When set, every attempt carries a `webhook-signature` header. */
  secret?: string;
  /** Message id sent as `webhook-id`, the same on every retry. Defaults to a random id. */
  messageId?: string;
}

export interface WebhookDeliverResult {
  delivered: boolean;
  attempts: number;
}

const DEFAULT_RETRY_DELAYS = [1000, 5000, 15000] as const;
const DEFAULT_TIMEOUT_MS = 5000;
const SECRET_PREFIX = "whsec_";
const SECRET_BYTES = 32;
const MIN_SECRET_BYTES = 24;
const MAX_SECRET_BYTES = 64;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_:-]{1,256}$/;
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Decodes a `whsec_` secret to its key bytes, or throws a generic error that never includes the secret. */
export function webhookSecretKey(secret: string): Uint8Array<ArrayBuffer> {
  const trimmed = secret.trim();
  const raw = trimmed.startsWith(SECRET_PREFIX) ? trimmed.slice(SECRET_PREFIX.length) : "";
  const bytes = raw && STRICT_BASE64.test(raw) ? fromBase64(raw) : null;
  if (!bytes || bytes.length < MIN_SECRET_BYTES || bytes.length > MAX_SECRET_BYTES) {
    throw new Error(`invalid webhook secret: expected whsec_ followed by ${MIN_SECRET_BYTES} to ${MAX_SECRET_BYTES} bytes in base64`);
  }
  return bytes;
}

/** A new webhook signing secret: `whsec_` followed by 32 random bytes in base64. */
export function generateWebhookSecret(): string {
  return SECRET_PREFIX + toBase64(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}

/** Signs `id.timestamp.body` with HMAC-SHA256 and returns the `v1,<base64>` signature header value. */
export async function signWebhook(secret: string, messageId: string, timestampSec: number, body: string): Promise<string> {
  if (!MESSAGE_ID_PATTERN.test(messageId)) throw new Error("invalid webhook message id");
  const key = await crypto.subtle.importKey("raw", webhookSecretKey(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${messageId}.${timestampSec}.${body}`));
  return `v1,${toBase64(new Uint8Array(mac))}`;
}

export async function deliverWebhook(
  url: string,
  payload: WebhookPayload,
  opts: WebhookDeliverOptions = {},
): Promise<WebhookDeliverResult> {
  const retryDelays = opts.retryDelays ?? DEFAULT_RETRY_DELAYS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const body = JSON.stringify(payload);
  const messageId = opts.messageId ?? `msg_${crypto.randomUUID()}`;
  try {
    if (opts.secret !== undefined) webhookSecretKey(opts.secret);
    if (!MESSAGE_ID_PATTERN.test(messageId)) throw new Error("invalid webhook message id");
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    opts.onFailure?.(error);
    return { delivered: false, attempts: 0 };
  }

  let attempt = 0;
  for (;;) {
    try {
      const timestampSec = Math.floor(Date.now() / 1000);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "webhook-id": messageId,
        "webhook-timestamp": String(timestampSec),
      };
      if (opts.secret !== undefined) headers["webhook-signature"] = await signWebhook(opts.secret, messageId, timestampSec, body);
      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
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
