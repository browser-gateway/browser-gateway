import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReplayStorage } from "../../pipeline/plugins/screencast-capture.js";
import type { ReplayManifest, ReplayMeta } from "./types.js";

/** Node fs impl of ReplayStorage. Layout matches `ReplayStore` reader: */
/**   <storePath>/<sessionId>/meta.json                     */
/**   <storePath>/<sessionId>/parts/000.bin, 001.bin, ...   */
/**   <storePath>/<sessionId>/manifest.json                 */
/**   <storePath>/<sessionId>/complete.json                 */
export class NodeReplayStorage implements ReplayStorage {
  constructor(private readonly storePath: string) {}

  async init(sessionId: string, meta: ReplayMeta): Promise<void> {
    const sessionDir = join(this.storePath, sessionId);
    const partsDir = join(sessionDir, "parts");
    await mkdir(partsDir, { recursive: true });
    await writeFile(join(sessionDir, "meta.json"), JSON.stringify(meta));
  }

  async writeChunk(sessionId: string, chunkIndex: number, data: Uint8Array): Promise<void> {
    const partPath = join(
      this.storePath,
      sessionId,
      "parts",
      `${String(chunkIndex).padStart(3, "0")}.bin`,
    );
    await writeFile(partPath, data);
  }

  async finalize(
    sessionId: string,
    manifest: ReplayManifest,
    summary: {
      endedAt: number;
      frameCount: number;
      sizeBytes: number;
      droppedFrames: number;
      duplicatesSkipped: number;
    },
  ): Promise<void> {
    const sessionDir = join(this.storePath, sessionId);
    await writeFile(join(sessionDir, "manifest.json"), JSON.stringify(manifest));
    await writeFile(join(sessionDir, "complete.json"), JSON.stringify(summary));
  }
}
