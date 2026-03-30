import WebSocket from "ws";

const COMMAND_TIMEOUT_MS = 30000;

interface PendingCommand {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CdpClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCommand>();
  private eventHandlers = new Map<string, Array<(params: unknown) => void>>();

  async connect(url: string, timeoutMs: number = 10000): Promise<void> {
    const targetUrl = await this.resolvePageTarget(url, timeoutMs);

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(targetUrl, { handshakeTimeout: timeoutMs });

      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`CDP connection timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      ws.on("open", () => {
        clearTimeout(timer);
        this.ws = ws;
        this.setupMessageHandler();
        resolve();
      });

      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      ws.on("close", () => {
        clearTimeout(timer);
        reject(new Error("CDP connection closed before establishing"));
      });
    });
  }

  private async resolvePageTarget(url: string, timeoutMs: number): Promise<string> {
    const parsed = new URL(url);
    if (parsed.pathname.includes("/devtools/page/")) {
      return url;
    }

    const httpBase = `http://${parsed.hostname}:${parsed.port}`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const resp = await fetch(`${httpBase}/json`, { signal: controller.signal });
      clearTimeout(timer);

      const targets = (await resp.json()) as Array<{
        type: string;
        webSocketDebuggerUrl?: string;
      }>;

      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) {
        return page.webSocketDebuggerUrl;
      }
    } catch {}

    return url;
  }

  private setupMessageHandler(): void {
    this.ws!.on("message", (data) => {
      let msg: { id?: number; method?: string; result?: unknown; error?: { message: string }; params?: unknown };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (msg.id !== undefined) {
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          clearTimeout(pending.timer);
          if (msg.error) {
            pending.reject(new Error(msg.error.message));
          } else {
            pending.resolve(msg.result);
          }
        }
      } else if (msg.method) {
        const handlers = this.eventHandlers.get(msg.method);
        if (handlers) {
          for (const handler of [...handlers]) {
            handler(msg.params);
          }
        }
      }
    });

    this.ws!.on("close", () => {
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("CDP connection closed"));
      }
      this.pending.clear();
      this.ws = null;
    });
  }

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("CDP not connected");
    }

    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timeout: ${method}`));
      }, COMMAND_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws!.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  on(event: string, handler: (params: unknown) => void): void {
    let handlers = this.eventHandlers.get(event);
    if (!handlers) {
      handlers = [];
      this.eventHandlers.set(event, handlers);
    }
    handlers.push(handler);
  }

  off(event: string, handler: (params: unknown) => void): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx !== -1) handlers.splice(idx, 1);
    }
  }

  once(event: string, timeoutMs: number = 30000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(event, handler);
        reject(new Error(`CDP event timeout: ${event}`));
      }, timeoutMs);

      const handler = (params: unknown) => {
        clearTimeout(timer);
        this.off(event, handler);
        resolve(params);
      };

      this.on(event, handler);
    });
  }

  async enableDomains(): Promise<void> {
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("DOM.enable");
    try { await this.send("Accessibility.enable"); } catch {}
  }

  async navigate(url: string): Promise<{ url: string; title: string }> {
    const loadPromise = this.once("Page.loadEventFired", 15000).catch(() => {});

    const result = await this.send("Page.navigate", { url }) as {
      frameId?: string;
      errorText?: string;
    };

    if (result.errorText) {
      throw new Error(`Navigation failed: ${result.errorText}`);
    }

    await loadPromise;

    const evalUrl = await this.send("Runtime.evaluate", {
      expression: "document.URL",
      returnByValue: true,
    }) as { result: { value: string } };

    const evalTitle = await this.send("Runtime.evaluate", {
      expression: "document.title",
      returnByValue: true,
    }) as { result: { value: string } };

    return { url: evalUrl.result.value, title: evalTitle.result.value };
  }

  async screenshot(fullPage: boolean = false): Promise<string> {
    if (fullPage) {
      const metrics = await this.send("Page.getLayoutMetrics") as {
        contentSize: { width: number; height: number };
      };
      await this.send("Emulation.setDeviceMetricsOverride", {
        width: Math.ceil(metrics.contentSize.width),
        height: Math.ceil(metrics.contentSize.height),
        deviceScaleFactor: 1,
        mobile: false,
      });
    }

    try {
      const result = await this.send("Page.captureScreenshot", {
        format: "png",
      }) as { data: string };
      return result.data;
    } finally {
      if (fullPage) {
        await this.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
      }
    }
  }

  async evaluate(expression: string, awaitPromise: boolean = true): Promise<unknown> {
    const hasAwait = /\bawait\s/.test(expression);
    const wrappedExpression = hasAwait
      ? `(async () => { ${expression} })()`
      : expression;

    const result = await this.send("Runtime.evaluate", {
      expression: wrappedExpression,
      returnByValue: true,
      awaitPromise,
    }) as {
      result: { value: unknown; type: string; description?: string };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    };

    if (result.exceptionDetails) {
      const desc = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`JS Error: ${desc}`);
    }

    return result.result.value ?? result.result.description;
  }

  close(): void {
    this.eventHandlers.clear();
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("CDP connection closing"));
    }
    this.pending.clear();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
