import { createHash, timingSafeEqual } from "node:crypto";

/** Compares two tokens in time independent of their contents and their lengths.
 *
 *  Both sides are hashed to a fixed width first, so a caller cannot learn the
 *  expected token's length by timing a rejection.
 */
export function safeTokenCompare(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}
