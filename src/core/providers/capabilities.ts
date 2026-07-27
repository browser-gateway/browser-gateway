import { WsCDPClient } from "../profile/cdp-client.js";
import { resolveWsUrl } from "./cdp.js";
import { errorMessage, initCapsFromIdentity, runCapabilityProbeSteps } from "./capabilities-shared.js";

export type CapabilityState = "supported" | "unsupported" | "unknown";

export interface ProviderCapabilities {
  browserCookies: CapabilityState;
  targetCreate: CapabilityState;
  targetGetTargets: CapabilityState;
  fetchInterception: CapabilityState;
  pageScreencast: CapabilityState;
  targetCreateLatencyMs: number | null;
  /** Detected vendor: a browserserve instance, or a generic CDP provider. */
  providerKind: "browserserve" | "generic";
  /** The provider's self-reported concurrency ceiling, when it advertises one. */
  advertisedMaxConcurrent: number | null;
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
  providerKind: "generic",
  advertisedMaxConcurrent: null,
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
  const { caps, perStep, deadline, started } = await initCapsFromIdentity(providerUrl, opts);

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
    await client.connect(wsUrl, perStep);
  } catch (err) {
    caps.errors.push(`connect: ${errorMessage(err)}`);
    await client.close().catch(() => undefined);
    caps.probeDurationMs = Date.now() - started;
    return caps;
  }

  try {
    return await runCapabilityProbeSteps(client, caps, {
      perStepTimeoutMs: perStep,
      deadlineMs: deadline,
      startedMs: started,
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}
