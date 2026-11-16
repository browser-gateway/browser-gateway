import { createHmac, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverWebhook, generateWebhookSecret, signWebhook } from "../../src/core/webhooks.js";

const payload = { version: "1", timestamp: "2026-11-15T00:00:00.000Z", event: "provider.down", status: "firing" as const, source: "test", data: {} };

afterEach(() => vi.unstubAllGlobals());

describe("webhook signing", () => {
  it("signs id.timestamp.body with HMAC-SHA256 of the decoded secret", async () => {
    const key = randomBytes(32);
    const body = '{"test": 2432232314}';
    const expected = createHmac("sha256", key).update(`msg_1.1614265330.${body}`).digest("base64");
    expect(await signWebhook(`whsec_${key.toString("base64")}`, "msg_1", 1614265330, body)).toBe(`v1,${expected}`);
  });

  it("makes secrets with the whsec_ prefix and 32 random bytes", () => {
    const a = generateWebhookSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(generateWebhookSecret()).not.toBe(a);
  });

  it("signs every attempt of the exact body sent, keeping one message id across retries", async () => {
    const seen: Array<{ headers: Record<string, string>; body: string }> = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      seen.push({ headers: init.headers as Record<string, string>, body: String(init.body) });
      return new Response(null, { status: seen.length < 2 ? 500 : 200 });
    });
    const secret = generateWebhookSecret();
    const result = await deliverWebhook("https://hooks.example.invalid", payload, { secret, retryDelays: [1] });
    expect(result).toEqual({ delivered: true, attempts: 2 });
    expect(seen[0]!.headers["webhook-id"]).toMatch(/^msg_/);
    expect(seen[1]!.headers["webhook-id"]).toBe(seen[0]!.headers["webhook-id"]);
    for (const { headers, body } of seen) {
      expect(body).toBe(JSON.stringify(payload));
      expect(headers["webhook-signature"]).toBe(await signWebhook(secret, headers["webhook-id"]!, Number(headers["webhook-timestamp"]), body));
    }
  });

  it("sends no signature without a secret", async () => {
    let headers: Record<string, string> = {};
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return new Response(null, { status: 200 });
    });
    await deliverWebhook("https://hooks.example.invalid", payload, { retryDelays: [] });
    expect(headers["webhook-signature"]).toBeUndefined();
    expect(headers["webhook-id"]).toMatch(/^msg_/);
  });
});
