import { createHmac, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebhookSchema, deliverWebhook, generateWebhookSecret, signWebhook } from "../../src/core/webhooks.js";

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

  it.each([
    ["empty", ""],
    ["one byte", "whsec_YQ=="],
    ["no prefix", Buffer.alloc(32, 1).toString("base64")],
    ["bad base64", "whsec_not*base64*at*all*not*base64*at*all*xx"],
    ["too long", `whsec_${Buffer.alloc(65, 1).toString("base64")}`],
  ])("refuses a %s secret once, without sending or retrying, and never echoes it", async (_name, secret) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const failures: Error[] = [];
    const result = await deliverWebhook("https://hooks.example.invalid", payload, { secret, retryDelays: [1, 1, 1], onFailure: (e) => failures.push(e) });
    expect(result).toEqual({ delivered: false, attempts: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(failures).toHaveLength(1);
    if (secret) expect(failures[0]!.message).not.toContain(secret);
    expect(WebhookSchema.safeParse({ url: "https://hooks.example.invalid", secret }).success).toBe(false);
  });

  it("refuses a message id that headers would change or the signed string would misread", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    for (const messageId of [" msg_1 ", "msg.1", ""]) {
      const result = await deliverWebhook("https://hooks.example.invalid", payload, { secret: generateWebhookSecret(), messageId, retryDelays: [] });
      expect(result).toEqual({ delivered: false, attempts: 0 });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts a secret written as a YAML block with a trailing newline, and signs with the trimmed value", async () => {
    const secret = generateWebhookSecret();
    expect(WebhookSchema.safeParse({ url: "https://hooks.example.invalid", secret: `${secret}\n` }).success).toBe(true);
    expect(await signWebhook(`${secret}\n`, "msg_1", 1, "{}")).toBe(await signWebhook(secret, "msg_1", 1, "{}"));
    expect(WebhookSchema.safeParse({ url: "https://hooks.example.invalid", secret: `${secret.slice(0, 20)} ${secret.slice(20)}` }).success).toBe(false);
  });

  it("the config notifier never sends unsigned when it was given an empty secret", async () => {
    const { WebhookNotifier } = await import("../../src/core/notifications/webhooks.js");
    const pino = (await import("pino")).default;
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    await new WebhookNotifier([{ url: "https://hooks.example.invalid", secret: "" }], pino({ level: "silent" })).send("provider.down", "firing", {});
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never puts a login or token from the address into errors, and refuses an address with a login", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const failures: Error[] = [];
    const login = await deliverWebhook("https://alice:URLPASSWORD@hooks.example.invalid/", payload, { secret: generateWebhookSecret(), retryDelays: [], onFailure: (e) => failures.push(e) });
    expect(login).toEqual({ delivered: false, attempts: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();

    const url = "https://hooks.example.invalid/in?token=QUERYTOKEN";
    vi.stubGlobal("fetch", async () => {
      throw new Error(`fetch failed for ${url} via https://bob:OTHERPASS@relay.invalid/x`);
    });
    const attempts: Error[] = [];
    await deliverWebhook(url, payload, { retryDelays: [], onAttemptFailed: (_n, e) => attempts.push(e), onFailure: (e) => failures.push(e) });
    const text = [...failures, ...attempts].map((e) => e.message).join("\n");
    for (const leaked of ["URLPASSWORD", "QUERYTOKEN", "OTHERPASS", "alice", "bob"]) expect(text).not.toContain(leaked);
    expect(text).toContain("https://hooks.example.invalid");
  });

  it("the config notifier logs only the scheme and host of a webhook address", async () => {
    const { WebhookNotifier } = await import("../../src/core/notifications/webhooks.js");
    const pino = (await import("pino")).default;
    const lines: string[] = [];
    const logger = pino({ level: "debug" }, { write: (line: string) => void lines.push(line) });
    vi.stubGlobal("fetch", async () => new Response(null, { status: 200 }));
    await new WebhookNotifier([{ url: "https://hooks.example.invalid/x?token=QTOKEN" }], logger).send("provider.down", "firing", {});
    await new Promise((r) => setTimeout(r, 50));
    const text = lines.join("");
    expect(text).toContain("https://hooks.example.invalid");
    expect(text).not.toContain("QTOKEN");
  });

  it("accepts a generated secret in config", () => {
    expect(WebhookSchema.safeParse({ url: "https://hooks.example.invalid", secret: generateWebhookSecret() }).success).toBe(true);
  });
});
