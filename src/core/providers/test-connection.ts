/** Isomorphic provider-connection probe. Callers supply a pre-connected CDP client;
 *  the helper runs one `Browser.getVersion` call and reports latency + success.
 *  Node callers typically pair this with `WsCDPClient` from the main package;
 *  Workers/Deno/Bun callers pair it with `CdpProtocolClient` and their own transport. */

export interface TestConnectionClient {
  sendOn(
    method: string,
    params: Record<string, unknown> | undefined,
    sessionId: string | undefined,
  ): Promise<unknown>;
  close(): Promise<void>;
}

export interface TestConnectionResult {
  ok: boolean;
  latencyMs: number;
  reason?: string;
}

/** Runs one CDP command (`Browser.getVersion`) against an already-connected client.
 *  Reports latency and success. Never throws — surfaces errors as `ok: false`. */
export async function testConnectionWithClient(
  client: TestConnectionClient,
  timeoutMs = 5_000,
): Promise<TestConnectionResult> {
  const started = Date.now();
  try {
    const result = await Promise.race([
      client.sendOn("Browser.getVersion", {}, undefined),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Browser.getVersion timeout after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);
    return {
      ok: result !== null && result !== undefined,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
