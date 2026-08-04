import type { PipelineSocket } from "./pipeline.js";

/** Attach an event listener to a PipelineSocket, regardless of whether it
 *  came from Node `ws` (`on`) or a browser/Workers WebSocket
 *  (`addEventListener`). Silent no-op if neither shape is available. */
export function listen(sock: PipelineSocket, evt: string, cb: (data: unknown) => void): void {
  if (typeof sock.addEventListener === "function") {
    sock.addEventListener(evt, cb);
  } else if (typeof sock.on === "function") {
    sock.on(evt, cb);
  }
}

/** Decode a base64 string to a Uint8Array using the platform's `atob`. Fast
 *  path — no allocation beyond the output buffer. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
