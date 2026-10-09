import type { PipelineSocket } from "./pipeline.js";
import { listen } from "./socket-io.js";

/** Upper bound on messages kept before a listener attaches; later ones are dropped. */
const MAX_EARLY_VIEWER_MESSAGES = 256;

/** Wraps a viewer socket so messages that arrive before anyone listens are kept and
 *  replayed, in order, to the first message listener. Close and error listeners pass
 *  straight through. Wrap the socket as soon as it is accepted. */
export function bufferViewerMessages(socket: PipelineSocket): PipelineSocket {
  const early: unknown[] = [];
  let deliver: ((ev: unknown) => void) | null = null;
  listen(socket, "message", (ev) => {
    if (deliver) deliver(ev);
    else if (early.length < MAX_EARLY_VIEWER_MESSAGES) early.push(ev);
  });
  return {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    addEventListener: (type, listener) => {
      if (type !== "message") {
        listen(socket, type, listener);
        return;
      }
      deliver = listener;
      for (const ev of early.splice(0)) listener(ev);
    },
    get bufferedAmount() {
      return socket.bufferedAmount;
    },
  };
}
