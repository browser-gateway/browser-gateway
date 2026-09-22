export type CdpSend = (
  method: string,
  params: Record<string, unknown>,
  sessionId: string | undefined,
) => Promise<unknown>;

export interface Point {
  x: number;
  y: number;
}
