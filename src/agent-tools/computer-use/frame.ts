import type { Point } from "../types.js";

export type Vendor = "anthropic-browser" | "anthropic-computer" | "gemini";

/** The image size the model sees and how it maps to page pixels: page = model / scale. */
export interface Frame {
  width: number;
  height: number;
  scale: number;
}

// Claude image limits for the browser and computer toolsets:
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool
const CLAUDE_MAX_LONG_EDGE = 2576;
const CLAUDE_MAX_SIDE_MANY_IMAGES = 2000;
const CLAUDE_MAX_VISUAL_TOKENS = 4784;
const CLAUDE_TOKEN_TILE = 28;
const GEMINI_GRID = 1000;

export function visualTokens(width: number, height: number): number {
  return Math.ceil(width / CLAUDE_TOKEN_TILE) * Math.ceil(height / CLAUDE_TOKEN_TILE);
}

/** The largest frame no bigger than the page that the vendor accepts without resizing. */
export function fitFrame(viewport: { width: number; height: number }, vendor: Vendor): Frame {
  if (vendor === "gemini") return { width: viewport.width, height: viewport.height, scale: 1 };
  const long = Math.max(viewport.width, viewport.height);
  let scale = Math.min(1, CLAUDE_MAX_LONG_EDGE / long, CLAUDE_MAX_SIDE_MANY_IMAGES / long);
  let width = Math.floor(viewport.width * scale);
  let height = Math.floor(viewport.height * scale);
  while (visualTokens(width, height) > CLAUDE_MAX_VISUAL_TOKENS) {
    scale *= 0.97;
    width = Math.floor(viewport.width * scale);
    height = Math.floor(viewport.height * scale);
  }
  return { width, height, scale };
}

/** Converts a point the model gave in frame pixels to page pixels, refusing points outside the frame. */
export function frameToPage(point: Point, frame: Frame): Point {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("coordinates must be numbers");
  if (point.x < 0 || point.y < 0 || point.x >= frame.width || point.y >= frame.height) {
    throw new Error(
      `(${point.x}, ${point.y}) is outside the ${frame.width}x${frame.height} screenshot. Use coordinates inside the last screenshot.`,
    );
  }
  return { x: point.x / frame.scale, y: point.y / frame.scale };
}

export function pageToFrame(point: Point, frame: Frame): Point {
  return { x: Math.round(point.x * frame.scale), y: Math.round(point.y * frame.scale) };
}

/** Gemini sends positions on a 0-999 grid; values outside it are clamped. */
export function fromGeminiGrid(point: Point, viewport: { width: number; height: number }): Point {
  const clamp = (v: number) => Math.min(Math.max(Number(v), 0), GEMINI_GRID - 1);
  return {
    x: Math.floor((clamp(point.x) / GEMINI_GRID) * viewport.width),
    y: Math.floor((clamp(point.y) / GEMINI_GRID) * viewport.height),
  };
}

/** A length on Gemini's 0-999 grid, as page pixels along one axis. */
export function geminiLength(value: number, size: number): number {
  return Math.round((Math.min(Math.max(Number(value), 0), GEMINI_GRID) / GEMINI_GRID) * size);
}
