import type { CdpMessage, CdpPlugin, SessionState } from "../types.js";

/** Browser-level commands that act on the default browser context unless they name one. */
const CONTEXT_SCOPED_METHODS = new Set([
  "Target.createTarget",
  "Storage.getCookies",
  "Storage.setCookies",
  "Storage.clearCookies",
  "Browser.setDownloadBehavior",
  "Browser.grantPermissions",
  "Browser.resetPermissions",
]);

/** Points a browser-level command that would act on the default browser context at `browserContextId` instead. */
export function scopeToBrowserContext(
  method: string,
  params: Record<string, unknown> | undefined,
  browserContextId: string | null,
): Record<string, unknown> | undefined {
  if (!browserContextId || !CONTEXT_SCOPED_METHODS.has(method) || params?.browserContextId) return params;
  return { ...params, browserContextId };
}

export interface ProxyContextPluginOpts {
  /** `scheme://host:port` the browser uses as its proxy; carries no credentials. */
  proxyServer: string;
  /** Hosts that skip the proxy, in the browser's bypass-list syntax. */
  bypass?: string[];
}

interface TargetInfoLite {
  targetId: string;
  type: string;
  url: string;
  browserContextId?: string;
}

/**
 * Routes every page the client opens through a proxy by opening one proxied
 * browser context at session start and pointing the client's default-context
 * commands at it. Client-created contexts get the same proxy.
 */
export class ProxyContextPlugin implements CdpPlugin {
  readonly name = "proxy-context";
  private contextId: string | null = null;
  private readonly contextListRequests = new Set<number>();

  constructor(private readonly opts: ProxyContextPluginOpts) {}

  get proxiedContextId(): string | null {
    return this.contextId;
  }

  async onSessionStart(state: SessionState): Promise<void> {
    const { browserContextId } = await state.sendInternal<{ browserContextId: string }>(
      "Target.createBrowserContext",
      this.contextParams(),
    );
    this.contextId = browserContextId;
    const { targetInfos } = await state.sendInternal<{ targetInfos: TargetInfoLite[] }>("Target.getTargets");
    await state.sendInternal("Target.createTarget", { url: "about:blank", browserContextId });
    for (const target of targetInfos) {
      if (target.type === "page" && target.url === "about:blank" && target.browserContextId !== browserContextId) {
        await state.sendInternal("Target.closeTarget", { targetId: target.targetId }).catch(() => undefined);
      }
    }
  }

  onCommand(msg: CdpMessage): CdpMessage | undefined {
    if (msg.sessionId || !this.contextId || !msg.method) return undefined;
    const scoped = scopeToBrowserContext(msg.method, msg.params, this.contextId);
    if (scoped !== msg.params) return { ...msg, params: scoped };
    if (msg.method === "Target.createBrowserContext" && !msg.params?.proxyServer) {
      return { ...msg, params: { ...msg.params, ...this.contextParams() } };
    }
    if (msg.method === "Target.getBrowserContexts" && typeof msg.id === "number") {
      this.contextListRequests.add(msg.id);
    }
    return undefined;
  }

  onResponse(msg: CdpMessage): CdpMessage | undefined {
    if (typeof msg.id !== "number" || !this.contextListRequests.delete(msg.id)) return undefined;
    const result = msg.result as { browserContextIds?: string[] } | undefined;
    if (!result?.browserContextIds) return undefined;
    return { ...msg, result: { ...result, browserContextIds: result.browserContextIds.filter((id) => id !== this.contextId) } };
  }

  async onSessionEnd(state: SessionState): Promise<void> {
    if (!this.contextId) return;
    await state.sendInternal("Target.disposeBrowserContext", { browserContextId: this.contextId }).catch(() => undefined);
  }

  private contextParams(): Record<string, unknown> {
    return {
      proxyServer: this.opts.proxyServer,
      ...(this.opts.bypass?.length ? { proxyBypassList: this.opts.bypass.join(";") } : {}),
    };
  }
}
