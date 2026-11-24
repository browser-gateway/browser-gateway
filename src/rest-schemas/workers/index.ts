/** Import once at the top of a Cloudflare Worker that serves REST markdown, before any request runs. */
import "./parser-window.js";
import "defuddle/node";
import "./parser-window-clear.js";

export { parserWindowShimmed as markdownParserPreloaded } from "./parser-window.js";
