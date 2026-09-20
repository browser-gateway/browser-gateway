import { createServer, type Server, type Socket } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { CdpProtocolClient } from "../../core/cdp/protocol.js";
import { AgentSession } from "../../agent-tools/index.js";
import { NodeCdpTransport } from "../mcp/ws-transport.js";
import { runBrowseCommand } from "./commands.js";
import type { BrowseRequest, BrowseResponse } from "./protocol.js";

export interface DaemonOptions {
  socketPath: string;
  endpoint: string;
  idleMs?: number;
}

/** Holds one browser session for a named CLI session so state survives between
 *  `browse` invocations. Exits on `close`, on the engine's idle clock, or when
 *  the upstream connection drops. */
export async function startBrowseDaemon(opts: DaemonOptions): Promise<{ server: Server; stop: () => Promise<void> }> {
  const transport = new NodeCdpTransport(opts.endpoint);
  await transport.ready();
  const cdp = new CdpProtocolClient(transport);
  const session = new AgentSession(cdp, {
    policy: opts.idleMs ? { idleMs: opts.idleMs } : {},
  });

  mkdirSync(dirname(opts.socketPath), { recursive: true, mode: 0o700 });
  rmSync(opts.socketPath, { force: true });

  const server = createServer((socket: Socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        void handleLine(line, socket);
        newline = buffer.indexOf("\n");
      }
    });
  });

  const stop = async (): Promise<void> => {
    await session.close().catch(() => undefined);
    await cdp.close().catch(() => undefined);
    server.close();
    rmSync(opts.socketPath, { force: true });
  };

  async function handleLine(line: string, socket: Socket): Promise<void> {
    if (!line.trim()) return;
    let req: BrowseRequest;
    try {
      req = JSON.parse(line) as BrowseRequest;
    } catch {
      socket.write(`${JSON.stringify({ id: 0, ok: false, error: "bad request" })}\n`);
      return;
    }

    if (req.verb === "close") {
      socket.write(`${JSON.stringify({ id: req.id, ok: true, text: "session closed" } satisfies BrowseResponse)}\n`);
      await stop();
      return;
    }
    if (req.verb === "status") {
      const state = session.state;
      socket.write(
        `${JSON.stringify({ id: req.id, ok: true, text: `alive, ${state.secondsUntilIdleClose}s until idle close`, data: state } satisfies BrowseResponse)}\n`,
      );
      return;
    }

    try {
      const response = await runBrowseCommand(session, req);
      socket.write(`${JSON.stringify(response)}\n`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      socket.write(`${JSON.stringify({ id: req.id, ok: false, error } satisfies BrowseResponse)}\n`);
    }
  }

  await new Promise<void>((resolve) => server.listen(opts.socketPath, resolve));

  const watchdog = setInterval(() => {
    if (session.expired !== null) {
      clearInterval(watchdog);
      void stop();
    }
  }, 5_000);
  watchdog.unref?.();

  return { server, stop };
}
