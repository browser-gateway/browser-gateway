import type { CdpSend } from "./types.js";

const WORLD_NAME = "bg-agent";

interface EvaluateReply {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

function isContextLost(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /context|execution context|Cannot find context|Inspected target navigated/i.test(text);
}

/** An isolated JavaScript world for one tab. Element properties written here are
 *  per-world in Blink, so refs are invisible to the page and every ref must be
 *  rebuilt when the world is lost. */
export class PageWorld {
  private frameId: string | undefined;
  private contextId: number | undefined;
  private generation = 0;

  /** Bumped whenever the world is rebuilt; every ref minted before it is void. */
  get worldGeneration(): number {
    return this.generation;
  }

  invalidate(): void {
    this.contextId = undefined;
  }

  reset(): void {
    this.contextId = undefined;
    this.frameId = undefined;
  }

  async warm(send: CdpSend, sessionId: string): Promise<void> {
    await this.context(send, sessionId).catch(() => undefined);
  }

  /** Calls `fn` in the isolated world with `arg`, rebuilding the world once if it
   *  was torn down by a navigation. Throws with the page-side message on error. */
  async call<T>(send: CdpSend, sessionId: string, fn: string, arg: unknown): Promise<T> {
    try {
      return await this.run<T>(send, sessionId, fn, arg);
    } catch (err) {
      if (!isContextLost(err)) throw err;
      this.invalidate();
      return this.run<T>(send, sessionId, fn, arg);
    }
  }

  private async run<T>(send: CdpSend, sessionId: string, fn: string, arg: unknown): Promise<T> {
    const contextId = await this.context(send, sessionId);
    const expression = `(${fn})(${JSON.stringify(arg)})`;
    const reply = (await send(
      "Runtime.evaluate",
      { expression, contextId, returnByValue: true, awaitPromise: true },
      sessionId,
    )) as EvaluateReply;
    if (reply.exceptionDetails) {
      throw new Error(
        reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? "page script failed",
      );
    }
    return reply.result?.value as T;
  }

  private async context(send: CdpSend, sessionId: string): Promise<number> {
    if (this.contextId !== undefined) return this.contextId;
    const frameId = await this.mainFrame(send, sessionId);
    const created = (await send(
      "Page.createIsolatedWorld",
      { frameId, worldName: WORLD_NAME, grantUniveralAccess: false },
      sessionId,
    )) as { executionContextId?: number };
    if (created.executionContextId === undefined) throw new Error("could not create an isolated world");
    this.contextId = created.executionContextId;
    this.generation++;
    return this.contextId;
  }

  private async mainFrame(send: CdpSend, sessionId: string): Promise<string> {
    if (this.frameId !== undefined) return this.frameId;
    const tree = (await send("Page.getFrameTree", {}, sessionId)) as {
      frameTree?: { frame?: { id?: string } };
    };
    const id = tree.frameTree?.frame?.id;
    if (!id) throw new Error("could not read the page frame tree");
    this.frameId = id;
    return id;
  }
}
