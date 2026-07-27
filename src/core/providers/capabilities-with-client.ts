/** Isomorphic capability probe — takes a pre-connected client. Used by cloud runtimes
 *  (Cloudflare Workers, Deno, Bun) that supply their own CDP transport. The OSS Node
 *  gateway continues to use `probeProviderCapabilities` from `./capabilities.js` for
 *  its own convenience. Both paths share the CDP step sequence via `./capabilities-shared.js`. */

import { type ProbeOptions, type ProviderCapabilities } from "./capabilities.js";
import {
  type CapabilityProbeClient,
  initCapsFromIdentity,
  runCapabilityProbeSteps,
} from "./capabilities-shared.js";

export { type CapabilityProbeClient } from "./capabilities-shared.js";

/** Runs the capability probes against an already-connected client. Best-effort:
 *  any individual probe failure is captured in `errors` rather than thrown. The
 *  caller is responsible for connecting AND closing the client. */
export async function probeCapabilitiesWithClient(
  client: CapabilityProbeClient,
  providerUrl: string,
  opts: ProbeOptions = {},
): Promise<ProviderCapabilities> {
  const { caps, perStep, deadline, started } = await initCapsFromIdentity(providerUrl, opts);
  return runCapabilityProbeSteps(client, caps, {
    perStepTimeoutMs: perStep,
    deadlineMs: deadline,
    startedMs: started,
  });
}
