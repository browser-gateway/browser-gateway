export interface RefEntry {
  backendNodeId: number;
  role: string;
  name: string;
}

/** Per-tab element reference table. Refs (`e1`, `e2`, ...) stay valid until the
 *  next snapshot of that tab; navigation clears them. */
export class RefTable {
  private entries = new Map<string, RefEntry>();
  private next = 1;

  add(entry: RefEntry): string {
    const id = `e${this.next++}`;
    this.entries.set(id, entry);
    return id;
  }

  get(ref: string): RefEntry | undefined {
    return this.entries.get(ref);
  }

  clear(): void {
    this.entries.clear();
    this.next = 1;
  }

  get size(): number {
    return this.entries.size;
  }
}
