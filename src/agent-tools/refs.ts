import { PageWorld } from "./world.js";

export interface RefEntry {
  role: string;
  name: string;
}

// TODO(isaac): no backend-node-id recovery map — when the world dies every ref is
// rebuilt and nothing is reported as new. Building it costs the round trips this
// design removed, so it waits for a cheap bulk node-id read.

/** Per-tab element reference table plus the isolated world the refs live in.
 *  Refs (`e1`, `e2`, ...) are assigned in the page and reused across snapshots
 *  while an element keeps its role and name; navigation rebuilds them. */
export class RefTable {
  readonly world = new PageWorld();
  /** URL the page reported during the last read, so a caller does not spend a
   *  round trip asking for it again. */
  lastUrl: string | undefined;
  private entries = new Map<string, RefEntry>();

  set(ref: string, entry: RefEntry): void {
    this.entries.set(ref, entry);
  }

  get(ref: string): RefEntry | undefined {
    return this.entries.get(ref);
  }

  replaceAll(next: Iterable<[string, RefEntry]>): void {
    this.entries = new Map(next);
  }

  clear(): void {
    this.entries.clear();
    this.lastUrl = undefined;
    this.world.reset();
  }

  get size(): number {
    return this.entries.size;
  }
}
