import { CdpProtocolClient, type CdpTransport } from "../../core/cdp/protocol.js";
import { AgentSession, type AgentSessionOptions } from "../session.js";
import type { Point } from "../types.js";
import { fitFrame, frameToPage, fromGeminiGrid, type Frame, type Vendor } from "./frame.js";
import { checkUrl, type UrlPolicy } from "./url-policy.js";
import { WebSocketTransport } from "./transport.js";

export interface ComputerUseOptions {
  /** Browser Gateway connect address, e.g. wss://host/v1/connect?token=... */
  endpoint?: string;
  /** Use this connection instead of opening one from `endpoint`. */
  transport?: CdpTransport;
  /** Page size in CSS pixels. Default 1440x900. */
  viewport?: { width: number; height: number };
  startUrl?: string;
  urls?: UrlPolicy;
  /** Default png. */
  screenshotFormat?: "png" | "jpeg";
  /** How long to wait for the page to settle after an action. Default 500 ms. */
  settleMs?: number;
  /** Let downloads proceed, saved to this folder on the browser's machine. */
  downloadPath?: string;
  session?: Pick<AgentSessionOptions, "policy" | "commandTimeoutMs" | "navigationTimeoutMs" | "dialogPolicy">;
}

export interface Observation {
  base64: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  url: string;
}

export const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
const DEFAULT_SETTLE_MS = 500;
const CONNECT_TIMEOUT_MS = 30_000;

/** One browser driven by a model's computer-use actions. Owns the page size,
 *  the screenshot frame the model sees, and the address policy. */
export class ComputerUseSession {
  frame: Frame;

  private constructor(
    readonly agent: AgentSession,
    private readonly cdp: CdpProtocolClient,
    readonly vendor: Vendor,
    private readonly opts: ComputerUseOptions,
  ) {
    this.frame = fitFrame(opts.viewport ?? DEFAULT_VIEWPORT, vendor);
  }

  static async open(vendor: Vendor, opts: ComputerUseOptions): Promise<ComputerUseSession> {
    const transport = opts.transport ?? (await connectTransport(opts.endpoint));
    const cdp = new CdpProtocolClient(transport);
    const agent = new AgentSession(cdp, {
      ...opts.session,
      isolateTabs: false,
      adoptPopups: true,
      keepLastTab: true,
      downloadPath: opts.downloadPath,
    });
    const session = new ComputerUseSession(agent, cdp, vendor, opts);
    try {
      await agent.openTab();
      await agent.setViewport(opts.viewport ?? DEFAULT_VIEWPORT);
      if (opts.startUrl) await session.navigate(opts.startUrl);
    } catch (err) {
      await session.close();
      throw err;
    }
    return session;
  }

  get urlPolicy(): ComputerUseOptions["urls"] {
    return this.opts.urls;
  }

  get settleMs(): number {
    return this.opts.settleMs ?? DEFAULT_SETTLE_MS;
  }

  /** Model frame point to page point. */
  toPage(point: Point): Point {
    return frameToPage(point, this.frame);
  }

  /** Gemini 0-999 grid point to page point. */
  fromGrid(point: Point): Point {
    return fromGeminiGrid(point, { width: this.frame.width / this.frame.scale, height: this.frame.height / this.frame.scale });
  }

  /** Opens an address after checking it, and checks again where redirects landed. */
  async navigate(url: string, tabId?: string): Promise<string> {
    const target = checkUrl(url, this.opts.urls);
    const result = await this.agent.navigate(target, tabId);
    try {
      checkUrl(result.url, this.opts.urls);
    } catch (err) {
      await this.agent.navigate("about:blank", result.tabId).catch(() => undefined);
      throw new Error(`the page redirected somewhere this session may not open: ${(err as Error).message}`, {
        cause: err,
      });
    }
    return result.url;
  }

  async settle(tabId?: string): Promise<void> {
    await this.agent.waitForSettle(this.settleMs, tabId);
  }

  /** A screenshot of the visible page at the model's frame size. */
  async observe(tabId?: string): Promise<Observation> {
    const viewport = await this.agent.viewport(tabId);
    this.frame = fitFrame(viewport, this.vendor);
    const format = this.opts.screenshotFormat ?? "png";
    const shot = await this.agent.screenshot({ format, scale: this.frame.scale }, tabId);
    const tab = tabId ?? this.agent.activeTab?.tabId;
    const url = (await this.agent.tabInventory()).find((t) => t.tabId === tab)?.url ?? "";
    return {
      base64: shot.base64 ?? "",
      mimeType: format === "png" ? "image/png" : "image/jpeg",
      width: shot.width ?? this.frame.width,
      height: shot.height ?? this.frame.height,
      url,
    };
  }

  /** A region of the page, in frame pixels, enlarged to fill the frame. */
  async zoom(region: { x0: number; y0: number; x1: number; y1: number }, tabId?: string): Promise<Observation> {
    const a = this.toPage({ x: Math.min(region.x0, region.x1), y: Math.min(region.y0, region.y1) });
    const b = this.toPage({ x: Math.max(region.x0, region.x1), y: Math.max(region.y0, region.y1) });
    const width = Math.max(b.x - a.x, 1);
    const height = Math.max(b.y - a.y, 1);
    const scale = Math.min(this.frame.width / width, this.frame.height / height);
    const format = this.opts.screenshotFormat ?? "png";
    const shot = await this.agent.screenshot({ format, region: { x: a.x, y: a.y, width, height }, scale }, tabId);
    return {
      base64: shot.base64 ?? "",
      mimeType: format === "png" ? "image/png" : "image/jpeg",
      width: shot.width ?? Math.round(width * scale),
      height: shot.height ?? Math.round(height * scale),
      url: "",
    };
  }

  /** Releases held input, closes this session's tabs and the connection. Never closes the browser. */
  async close(): Promise<void> {
    await this.agent.close().catch(() => undefined);
    await this.cdp.close().catch(() => undefined);
  }
}

async function connectTransport(endpoint: string | undefined): Promise<CdpTransport> {
  if (!endpoint) throw new Error("give an endpoint (your Browser Gateway connect address) or a transport");
  const transport = new WebSocketTransport(endpoint);
  await transport.ready(CONNECT_TIMEOUT_MS);
  return transport;
}
