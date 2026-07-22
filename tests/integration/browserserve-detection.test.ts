import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ProviderRegistry } from "../../src/core/providers/registry.js";
import { fetchProviderIdentity } from "../../src/core/providers/cdp.js";

function discoveryServer(body: Record<string, unknown>): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/json/version")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

describe("browserserve provider detection", () => {
  let browserserve: Server;
  let generic: Server;
  let browserserveUrl: string;
  let genericUrl: string;

  beforeAll(async () => {
    browserserve = await discoveryServer({
      Browser: "Chrome/149.0.0.0",
      "Browserserve-Version": "0.1.1",
      "Browserserve-MaxConcurrent": 6,
    });
    generic = await discoveryServer({ Browser: "Chrome/149.0.0.0" });
    browserserveUrl = `ws://127.0.0.1:${(browserserve.address() as AddressInfo).port}`;
    genericUrl = `ws://127.0.0.1:${(generic.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    browserserve.close();
    generic.close();
  });

  it("reads identity from /json/version over the ws-derived http url", async () => {
    const identity = await fetchProviderIdentity(browserserveUrl);
    expect(identity.browserserveVersion).toBe("0.1.1");
    expect(identity.advertisedMaxConcurrent).toBe(6);
  });

  it("returns unknown identity for a generic provider", async () => {
    const identity = await fetchProviderIdentity(genericUrl);
    expect(identity.browserserveVersion).toBeNull();
    expect(identity.advertisedMaxConcurrent).toBeNull();
  });

  it("probe stamps detectedKind and discoveredMaxConcurrent onto the provider", async () => {
    const registry = new ProviderRegistry();
    registry.register("bs", { url: browserserveUrl, priority: 1 }, { autoProbe: false });
    await registry.probe("bs");
    const provider = registry.get("bs")!;
    expect(provider.detectedKind).toBe("browserserve");
    expect(provider.discoveredMaxConcurrent).toBe(6);
  });

  it("probe leaves generic providers unstamped", async () => {
    const registry = new ProviderRegistry();
    registry.register("gen", { url: genericUrl, priority: 1 }, { autoProbe: false });
    await registry.probe("gen");
    const provider = registry.get("gen")!;
    expect(provider.detectedKind).toBeNull();
    expect(provider.discoveredMaxConcurrent).toBeNull();
  });
});
