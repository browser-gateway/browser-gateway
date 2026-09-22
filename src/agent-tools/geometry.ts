import type { Point } from "./types.js";

export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Bounding box of a CDP quad (8 numbers, four corner pairs). */
export function boxOfQuad(quad: number[] | undefined): Box | null {
  if (!quad || quad.length < 8) return null;
  const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
  const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

export function centerOfBox(box: Box): Point {
  return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
}
