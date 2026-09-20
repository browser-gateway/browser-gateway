import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { Gateway } from "../../core/index.js";
import { CdpProtocolClient } from "../../core/cdp/protocol.js";
import { AgentSession, type SessionPolicyOptions } from "../../agent-tools/index.js";
import { NodeCdpTransport } from "./ws-transport.js";

export interface McpBrowserSession {
  sessionId: string;
  providerId: string;
  agent: AgentSession;
  cdp: CdpProtocolClient;
  createdAt: number;
}

export interface LazyProviderSetup {
  (): Promise<void>;
}

export interface ConnectEndpoint {
  url: string;
  headers?: Record<string, string>;
}

export interface CreateSessionOptions {
  timeout?: number;
  idleMs?: number;
  pageConsole?: boolean;
}

/** Owns one {@link AgentSession} per MCP browser session, routed through the
 *  gateway so provider selection, failover and slot accounting still apply. */
export class McpSessionManager {
  private sessions = new Map<string, McpBrowserSession>();
  private providerSetupPromise: Promise<void> | undefined;
  private providerSetup: LazyProviderSetup | undefined;
  private connectEndpoint: ConnectEndpoint | undefined;

  constructor(
    private gateway: Gateway,
    private logger: Logger,
  ) {}

  setLazyProviderSetup(setup: LazyProviderSetup): void {
    this.providerSetup = setup;
  }

  /** Route sessions through the gateway's own `/v1/connect` so profiles,
   *  recording and session tracking apply. Without it (stdio, no server
   *  running) sessions use gateway routing in-process and dial the selected
   *  provider directly. */
  setConnectEndpoint(endpoint: ConnectEndpoint): void {
    this.connectEndpoint = endpoint;
  }

  async createSession(options: CreateSessionOptions = {}): Promise<McpBrowserSession | null> {
    await this.ensureProviders();

    const sessionId = randomUUID();
    const timeout = options.timeout ?? this.gateway.config.gateway.queue?.timeoutMs ?? 30_000;

    if (this.connectEndpoint) return this.createViaGateway(sessionId, this.connectEndpoint, options);

    const attempt = async (): Promise<McpBrowserSession | null> => {
      for (const provider of this.gateway.selectProviderWithFallbacks()) {
        if (!this.gateway.acquireSlot(provider.id, sessionId)) continue;
        const startedAt = Date.now();
        const transport = new NodeCdpTransport(provider.config.url, provider.config.headers);
        try {
          await transport.ready(this.gateway.config.gateway.connectionTimeout);
          const cdp = new CdpProtocolClient(transport);
          const policy: SessionPolicyOptions = options.idleMs ? { idleMs: options.idleMs } : {};
          const agent = new AgentSession(cdp, { policy, pageConsole: options.pageConsole === true });
          const session: McpBrowserSession = {
            sessionId,
            providerId: provider.id,
            agent,
            cdp,
            createdAt: startedAt,
          };
          this.sessions.set(sessionId, session);
          this.gateway.recordSuccess(provider.id, Date.now() - startedAt);
          this.logger.info({ sessionId, providerId: provider.id }, "mcp browser session created");
          return session;
        } catch (err) {
          await transport.close();
          this.gateway.releaseSlot(sessionId, provider.id);
          this.gateway.recordFailure(provider.id);
          this.logger.warn(
            { sessionId, providerId: provider.id, error: (err as Error).message },
            "mcp session could not use provider, trying next",
          );
        }
      }
      return null;
    };

    const first = await attempt();
    if (first) return first;
    if (await this.gateway.waitForSlot(timeout)) return attempt();

    this.logger.warn({ sessionId }, "mcp session creation failed - no provider available");
    return null;
  }

  private async createViaGateway(
    sessionId: string,
    endpoint: ConnectEndpoint,
    options: CreateSessionOptions,
  ): Promise<McpBrowserSession | null> {
    const startedAt = Date.now();
    const transport = new NodeCdpTransport(endpoint.url, endpoint.headers);
    try {
      await transport.ready(this.gateway.config.gateway.connectionTimeout);
      const cdp = new CdpProtocolClient(transport);
      const agent = new AgentSession(cdp, {
        policy: options.idleMs ? { idleMs: options.idleMs } : {},
        pageConsole: options.pageConsole === true,
      });
      const session: McpBrowserSession = {
        sessionId,
        providerId: "gateway",
        agent,
        cdp,
        createdAt: startedAt,
      };
      this.sessions.set(sessionId, session);
      this.logger.info({ sessionId }, "mcp browser session created via gateway connect");
      return session;
    } catch (err) {
      await transport.close();
      this.logger.warn({ sessionId, error: (err as Error).message }, "mcp gateway connect failed");
      return null;
    }
  }

  /** Closes this session's tabs and its own CDP connection. Never closes the
   *  upstream browser: other sessions and clients may be using it. */
  async releaseSession(sessionId: string): Promise<{ success: boolean; durationMs?: number }> {
    const session = this.sessions.get(sessionId);
    if (!session) return { success: false };

    const durationMs = Date.now() - session.createdAt;
    this.sessions.delete(sessionId);
    await session.agent.close().catch(() => undefined);
    await session.cdp.close().catch(() => undefined);
    if (session.providerId !== "gateway") this.gateway.releaseSlot(sessionId, session.providerId);
    this.logger.info({ sessionId, providerId: session.providerId, durationMs }, "mcp session released");
    return { success: true, durationMs };
  }

  get(sessionId: string): McpBrowserSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Resolves the session a tool call means. With several open sessions the
   *  caller must name one: guessing would hand one client another's browser. */
  resolve(sessionId?: string): McpBrowserSession {
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) throw new Error(`unknown session ${sessionId}. Call browser_session open first.`);
      return session;
    }
    const open = [...this.sessions.values()].filter((s) => s.agent.expired === null);
    if (open.length === 1) return open[0]!;
    if (open.length === 0) throw new Error("no open browser session. Call browser_session open first.");
    throw new Error(`${open.length} sessions are open. Pass sessionId to say which one.`);
  }

  getAll(): McpBrowserSession[] {
    return [...this.sessions.values()];
  }

  count(): number {
    return this.sessions.size;
  }

  /** Drops sessions the policy already expired so their slots are not held. */
  async reapExpired(): Promise<void> {
    for (const [id, session] of this.sessions) {
      if (session.agent.expired !== null) await this.releaseSession(id);
    }
  }

  async releaseAll(): Promise<void> {
    for (const [id] of this.sessions) await this.releaseSession(id);
  }

  private async ensureProviders(): Promise<void> {
    if (this.gateway.registry.size() > 0) return;
    if (!this.providerSetup) return;
    if (!this.providerSetupPromise) {
      this.providerSetupPromise = this.providerSetup().catch((err) => {
        this.providerSetupPromise = undefined;
        throw err;
      });
    }
    await this.providerSetupPromise;
  }
}
