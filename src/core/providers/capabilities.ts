import { WsCDPClient } from "../profile/cdp-client.js";
import { resolveWsUrl } from "./cdp.js";

export type CapabilityState = "supported" | "unsupported" | "unknown";

export interface ProviderCapabilities {
  browserCookies: CapabilityState;
  targetCreate: CapabilityState;
  targetGetTargets: CapabilityState;
  fetchInterception: CapabilityState;
  pageScreencast: CapabilityState;
  targetCreateLatencyMs: number | null;
  probedAt: string;
  probeDurationMs: number;
  errors: string[];
}

export const UNKNOWN_CAPABILITIES: Readonly<Omit<ProviderCapabilities, "probedAt">> = Object.freeze({
  browserCookies: "unknown",
  targetCreate: "unknown",
  targetGetTargets: "unknown",
  fetchInterception: "unknown",
  pageScreencast: "unknown",
  targetCreateLatencyMs: null,
  probeDurationMs: 0,
  errors: [],
});

export interface ProbeOptions {
  perStepTimeoutMs?: number;
  totalTimeoutMs?: number;
}

/**
 * Probes a provider's CDP endpoint for features the gateway uses. Best-effort:
 * any individual probe failure is captured in `errors` rather than thrown.
 */
export async function probeProviderCapabilities(
  providerUrl: string,
  opts: ProbeOptions = {},
): Promise<ProviderCapabilities> {
  const started = Date.now();
  const perStep = opts.perStepTimeoutMs ?? 8_000;
  const total = opts.totalTimeoutMs ?? 30_000;
  const caps: ProviderCapabilities = {
    ...UNKNOWN_CAPABILITIES,
    probedAt: new Date().toISOString(),
    errors: [],
  };
  const deadline = started + total;

  let wsUrl: string;
  try {
    wsUrl = await resolveWsUrl(providerUrl);
  } catch (err) {
    caps.errors.push(`resolveWsUrl: ${errorMessage(err)}`);
    caps.probeDurationMs = Date.now() - started;
    return caps;
  }

  const client = new WsCDPClient();
  try {
    await raceStep(client.connect(wsUrl, perStep), perStep, "connect", caps);
    if (caps.errors.length > 0) return finish(caps, started);

    await runStep(caps, "browserCookies", async () => {
      const r = (await raceStep(client.send("Storage.getCookies"), perStep, "Storage.getCookies", caps)) as
        | { cookies?: unknown[] }
        | null;
      return r !== null && Array.isArray(r.cookies);
    });

    if (Date.now() > deadline) return finish(caps, started);

    let targetId: string | null = null;
    const createStart = Date.now();
    await runStep(caps, "targetCreate", async () => {
      const r = (await raceStep(
        client.send("Target.createTarget", { url: "about:blank" }),
        perStep,
        "Target.createTarget",
        caps,
      )) as { targetId?: string } | null;
      targetId = r?.targetId ?? null;
      caps.targetCreateLatencyMs = Date.now() - createStart;
      return targetId !== null;
    });

    if (Date.now() > deadline) {
      await closeTargetIfOpen(client, targetId);
      return finish(caps, started);
    }

    await runStep(caps, "targetGetTargets", async () => {
      const r = (await raceStep(client.send("Target.getTargets"), perStep, "Target.getTargets", caps)) as
        | { targetInfos?: unknown[] }
        | null;
      return r !== null && Array.isArray(r.targetInfos);
    });

    let sessionId: string | null = null;
    if (targetId) {
      await runStep(caps, "_attach", async () => {
        const r = (await raceStep(
          client.send("Target.attachToTarget", { targetId, flatten: true }),
          perStep,
          "Target.attachToTarget",
          caps,
        )) as { sessionId?: string } | null;
        sessionId = r?.sessionId ?? null;
        return sessionId !== null;
      });
    }

    if (sessionId) {
      await runStep(caps, "fetchInterception", async () => {
        await raceStep(
          client.sendOn("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId!),
          perStep,
          "Fetch.enable",
          caps,
        );
        await raceStep(client.sendOn("Fetch.disable", {}, sessionId!), perStep, "Fetch.disable", caps);
        return true;
      });

      await runStep(caps, "pageScreencast", async () => {
        await raceStep(client.sendOn("Page.enable", {}, sessionId!), perStep, "Page.enable", caps);
        await raceStep(
          client.sendOn("Page.startScreencast", { format: "jpeg", quality: 50 }, sessionId!),
          perStep,
          "Page.startScreencast",
          caps,
        );
        await raceStep(client.sendOn("Page.stopScreencast", {}, sessionId!), perStep, "Page.stopScreencast", caps);
        return true;
      });
    }

    await closeTargetIfOpen(client, targetId);
  } finally {
    await client.close().catch(() => undefined);
  }

  return finish(caps, started);
}

async function closeTargetIfOpen(client: WsCDPClient, targetId: string | null): Promise<void> {
  if (!targetId) return;
  try {
    await client.send("Target.closeTarget", { targetId });
  } catch {
    // best-effort
  }
}

async function runStep(
  caps: ProviderCapabilities,
  capKey: keyof ProviderCapabilities | "_attach",
  fn: () => Promise<boolean>,
): Promise<void> {
  const errCountBefore = caps.errors.length;
  let ok = false;
  try {
    ok = await fn();
  } catch (err) {
    caps.errors.push(`${String(capKey)}: ${errorMessage(err)}`);
  }
  if (capKey === "_attach") return;
  const cap = capKey as keyof Pick<
    ProviderCapabilities,
    "browserCookies" | "targetCreate" | "targetGetTargets" | "fetchInterception" | "pageScreencast"
  >;
  caps[cap] = ok && caps.errors.length === errCountBefore ? "supported" : "unsupported";
}

function raceStep<T>(
  op: Promise<T>,
  timeoutMs: number,
  label: string,
  caps: ProviderCapabilities,
): Promise<T | null> {
  return Promise.race<T | null>([
    op,
    new Promise<T | null>((resolve) =>
      setTimeout(() => {
        caps.errors.push(`${label}: timeout after ${timeoutMs}ms`);
        resolve(null);
      }, timeoutMs),
    ),
  ]);
}

function finish(caps: ProviderCapabilities, started: number): ProviderCapabilities {
  caps.probeDurationMs = Date.now() - started;
  return caps;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
