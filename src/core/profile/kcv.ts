import { createCipheriv } from "node:crypto";

const KCV_INPUT = Buffer.alloc(16, 0);

export function computeKcv(kek: Buffer): Buffer {
  if (kek.length !== 32) {
    throw new Error(`KEK must be 32 bytes for AES-256, got ${kek.length}`);
  }
  const cipher = createCipheriv("aes-256-ecb", kek, null);
  cipher.setAutoPadding(false);
  const out = Buffer.concat([cipher.update(KCV_INPUT), cipher.final()]);
  return out.subarray(0, 3);
}
