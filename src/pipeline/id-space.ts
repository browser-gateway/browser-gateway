/** Internal ID allocator for pipeline-injected CDP commands. Uses the
 *  numeric range starting at 2^30 (1_073_741_824), well within Chrome's
 *  int32-positive tolerance and unreachable by any realistic client
 *  counting from 1. Additionally, all our IDs live in a pending-response
 *  Map so routing is by presence, not by value. */

const INTERNAL_ID_BASE = 1 << 30;

interface PendingResponse {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export class InternalIdSpace {
  private next = INTERNAL_ID_BASE;
  private readonly pending = new Map<number, PendingResponse>();

  /** Allocate a fresh internal ID and register a pending response. */
  allocate(): { id: number; promise: Promise<unknown> } {
    const id = this.next++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    return { id, promise };
  }

  /** True iff `id` belongs to an outstanding internal request. */
  owns(id: number): boolean {
    return this.pending.has(id);
  }

  /** Resolve or reject the pending response for `id`. Returns false if the
   *  ID was not registered (in which case the caller should forward the
   *  message downstream as a normal client response). */
  settle(id: number, msg: { result?: unknown; error?: { code: number; message: string } }): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    if (msg.error) {
      p.reject(new Error(`cdp error ${msg.error.code}: ${msg.error.message}`));
    } else {
      p.resolve(msg.result);
    }
    return true;
  }

  /** Reject every outstanding response — used on pipeline close. */
  rejectAll(reason: string): void {
    for (const [, p] of this.pending) {
      p.reject(new Error(`pipeline closed: ${reason}`));
    }
    this.pending.clear();
  }

  /** Number of outstanding internal responses. Test-only convenience. */
  get pendingCount(): number {
    return this.pending.size;
  }
}
