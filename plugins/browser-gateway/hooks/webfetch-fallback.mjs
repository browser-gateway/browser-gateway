import { pathToFileURL } from "node:url";

const SKIP_STATUS = new Set([404, 410]);
const BLOCK_TEXT =
  /just a moment|checking your browser|verify (that )?you are (a )?human|are you a robot|captcha|access denied|enable javascript|javascript is (disabled|required)|sign in to continue|log in to continue|only (navigation|a navigation menu)|no (main |readable )?content/i;
const UNREACHABLE = /ENOTFOUND|EAI_AGAIN|getaddrinfo/i;

function isPublicHost(url) {
  try {
    const host = new URL(url).hostname;
    return host.includes(".") && host !== "127.0.0.1" && !host.endsWith(".local") && !host.endsWith(".internal");
  } catch {
    return false;
  }
}

export function fallbackReason(event) {
  const url = event.tool_input?.url;
  if (typeof url !== "string" || !isPublicHost(url)) return undefined;

  if (event.hook_event_name === "PostToolUseFailure") {
    const error = String(event.error ?? "");
    return UNREACHABLE.test(error) ? undefined : error.slice(0, 120) || "the fetch failed";
  }

  const response = event.tool_response;
  const body = typeof response === "string" ? response : String(response?.result ?? "");
  const code = typeof response === "object" && response !== null ? Number(response.code) : NaN;
  const bytes = typeof response === "object" && response !== null ? Number(response.bytes) : NaN;

  if (code >= 400 && !SKIP_STATUS.has(code)) return `HTTP ${code}`;
  if (code >= 200 && code < 300 && bytes === 0) return "an empty page";
  if (BLOCK_TEXT.test(body.slice(0, 4000))) return "a bot check, login wall or JavaScript-only page";
  return undefined;
}

export function hookOutput(event) {
  const reason = fallbackReason(event);
  if (!reason) return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: event.hook_event_name,
      additionalContext: `WebFetch could not read ${event.tool_input.url} (${reason}). Retry the same url with the browser-gateway fetch_page tool, which loads it in a real browser, or screenshot_page to see it, before giving up or answering from another source.`,
    },
  };
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  try {
    const out = hookOutput(JSON.parse(raw));
    if (out) process.stdout.write(JSON.stringify(out));
  } catch {
    return;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
