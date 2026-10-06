import type { CdpTransport } from "./protocol.js";

/** The handler bookkeeping every socket-backed CDP transport shares. Subclasses
 *  send frames and close their socket; they report incoming data and closes
 *  through {@link emitMessage} and {@link emitClose}. */
export abstract class CallbackTransport implements CdpTransport {
  private messageHandler: ((data: string) => void) | null = null;
  private closeHandler: ((reason?: string) => void) | null = null;

  abstract send(data: string): void;
  protected abstract closeSocket(): void;

  onMessage(cb: (data: string) => void): void {
    this.messageHandler = cb;
  }

  onClose(cb: (reason?: string) => void): void {
    this.closeHandler = cb;
  }

  async close(): Promise<void> {
    try {
      this.closeSocket();
    } catch {
      /* already closed */
    }
  }

  protected emitMessage(data: string): void {
    this.messageHandler?.(data);
  }

  protected emitClose(reason: string): void {
    this.closeHandler?.(reason);
  }
}
