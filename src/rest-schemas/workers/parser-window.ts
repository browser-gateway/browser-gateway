import { DOMParser } from "linkedom";
type ParserHost = { DOMParser?: unknown };
const runtime = globalThis as { window?: ParserHost; navigator?: { userAgent?: string }; WebSocketPair?: unknown };
const isWorkers = runtime.navigator?.userAgent === "Cloudflare-Workers" || typeof runtime.WebSocketPair === "function";
const createdWindow = isWorkers && runtime.window === undefined;
const addedParser = isWorkers && !createdWindow && runtime.window?.DOMParser === undefined;
/** True when this Workers isolate needed a temporary HTML parser on window while the markdown converter loaded. */
export const parserWindowShimmed = createdWindow || addedParser;
// the markdown converter's browser build picks its HTML parser from window when it loads; Workers have no window or document
if (createdWindow) runtime.window = { DOMParser };
else if (addedParser) runtime.window!.DOMParser = DOMParser;

/** Undo the temporary parser once the markdown converter has loaded. */
export function clearParserWindow(): void {
  if (createdWindow) delete runtime.window;
  else if (addedParser) delete runtime.window!.DOMParser;
}
