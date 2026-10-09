import { z } from "zod";

/** CDP accepts click counts up to a triple click; quicker repeats are sent as a triple click. */
const MAX_CLICK_COUNT = 3;

const MouseEventSchema = z.object({
  kind: z.enum(["press", "release", "move", "wheel"]),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  button: z.enum(["left", "right", "middle", "none"]).optional(),
  /** Bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
  modifiers: z.number().int().min(0).max(15).optional(),
  clickCount: z.number().int().min(0).transform((n) => Math.min(n, MAX_CLICK_COUNT)).optional(),
  /** wheel only */
  deltaX: z.number().optional(),
  /** wheel only */
  deltaY: z.number().optional(),
});

const KeyEventSchema = z.object({
  kind: z.enum(["down", "up", "char"]),
  text: z.string().optional(),
  code: z.string().optional(),
  key: z.string().optional(),
  keyCode: z.number().int().optional(),
  /** Bitmask. Same values as mouse `modifiers`. */
  modifiers: z.number().int().min(0).max(15).optional(),
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("mouse"), event: MouseEventSchema }),
  z.object({ type: z.literal("key"), event: KeyEventSchema }),
  z.object({
    type: z.literal("navigate"),
    url: z.string().url().optional(),
    action: z.enum(["back", "forward", "reload"]).optional(),
  }),
  z.object({ type: z.literal("close") }),
  z.object({
    type: z.literal("setViewport"),
    width: z.number().int().min(100).max(3840),
    height: z.number().int().min(100).max(2160),
    deviceScaleFactor: z.number().min(0.5).max(4).optional(),
    mobile: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("paste"),
    text: z.string().max(64_000),
  }),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/** Server→client metadata frame (binary frames carry image bytes only). */
export interface ServerFrameMetaMessage {
  type: "frameMeta";
  deviceWidth: number;
  deviceHeight: number;
  scrollX: number;
  scrollY: number;
}

/** Server→client URL change announcement. */
export interface ServerUrlMessage {
  type: "url";
  url: string;
}

/** Server→client error notification before close. */
export interface ServerErrorMessage {
  type: "error";
  code: string;
  message: string;
}

/** Server→client warning that the keep-alive timer is about to expire. */
export interface ServerExpiringMessage {
  type: "expiring";
  secondsRemaining: number;
}

/** Server→client notification that the keep-alive timer has expired. Session
 *  is closed immediately after this message. */
export interface ServerExpiredMessage {
  type: "expired";
}

/** Server→client notice that the server is reloading the page in the background ("started"), and when it is usable again ("done"). */
export interface ServerRefreshMessage {
  type: "refresh";
  state: "started" | "done";
}

export type ServerControlMessage =
  | ServerRefreshMessage
  | ServerFrameMetaMessage
  | ServerUrlMessage
  | ServerErrorMessage
  | ServerExpiringMessage
  | ServerExpiredMessage;
