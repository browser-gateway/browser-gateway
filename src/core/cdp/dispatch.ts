/** Pure CDP response dispatch — shared between `WsCDPClient` (Node ws) and
 *  `CdpProtocolClient` (isomorphic). Neither owns the transport nor the event
 *  layer; both delegate response matching to this helper. */

export interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

/** Given a decoded CDP message and a pending-call map, dispatch a response and
 *  return true if this message was a response envelope. Callers should skip
 *  event dispatch when this returns true. */
export function dispatchCdpResponse(
  msg: { id?: unknown; error?: { message: string }; result?: unknown },
  pending: Map<number, PendingCall>,
): boolean {
  if (typeof msg.id !== "number") return false;
  const call = pending.get(msg.id);
  if (!call) return true;
  pending.delete(msg.id);
  if (msg.error) {
    call.reject(new Error(`CDP error: ${msg.error.message}`));
  } else {
    call.resolve(msg.result ?? null);
  }
  return true;
}
