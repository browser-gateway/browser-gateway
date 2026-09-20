import {
  clearCredentials,
  connectUrl,
  credentialsPath,
  maskToken,
  resolveEndpoint,
  saveCredentials,
} from "./credentials.js";
import { ensureDaemon, listSessions, sendToDaemon, socketPathFor } from "./client.js";
import { isBrowseVerb, parseBrowseArgs, flagNumber } from "./protocol.js";
import { NodeCdpTransport } from "../mcp/ws-transport.js";

export async function runBrowseCli(argv: string[]): Promise<number> {
  const { verb, args, flags } = parseBrowseArgs(argv);

  if (!verb || verb === "help") {
    printBrowseHelp();
    return 0;
  }

  if (verb === "sessions") {
    const names = listSessions();
    process.stdout.write(names.length ? `${names.join("\n")}\n` : "no open sessions\n");
    return 0;
  }

  if (!isBrowseVerb(verb)) {
    process.stderr.write(`unknown verb "${verb}". Run: browser-gateway browse help\n`);
    return 1;
  }

  const creds = resolveEndpoint(flags);
  const socketPath = socketPathFor(flags.session);

  if (verb === "close") {
    try {
      const res = await sendToDaemon(socketPath, { id: 1, verb: "close", args: [], flags: flags.rest });
      process.stdout.write(`${res.text ?? "closed"}\n`);
    } catch {
      process.stdout.write("no open session\n");
    }
    return 0;
  }

  const idleMs = flagNumber(flags.rest, "idle-minutes")
    ? flagNumber(flags.rest, "idle-minutes")! * 60_000
    : undefined;
  await ensureDaemon(flags.session, connectUrl(creds), idleMs);

  const res = await sendToDaemon(socketPath, { id: Date.now(), verb, args, flags: flags.rest });
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(res.data ?? { ok: res.ok, text: res.text, error: res.error }, null, 2)}\n`);
  } else if (res.ok) {
    process.stdout.write(`${res.text ?? ""}\n`);
  } else {
    process.stderr.write(`${res.error ?? res.text ?? "failed"}\n`);
  }
  return res.ok ? 0 : 1;
}

export async function runLoginCli(argv: string[]): Promise<number> {
  const { flags } = parseBrowseArgs(argv);
  const endpoint = flags.endpoint ?? process.env.BG_ENDPOINT;
  const token = flags.token ?? process.env.BG_TOKEN;
  if (!endpoint) {
    process.stderr.write("login needs --endpoint <url> (for example wss://cdp.browsergateway.io/v1/connect)\n");
    return 1;
  }

  const transport = new NodeCdpTransport(connectUrl({ endpoint, token }));
  try {
    await transport.ready(15_000);
    await transport.close();
  } catch (err) {
    process.stderr.write(`could not reach ${endpoint}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  saveCredentials({ endpoint, token });
  process.stdout.write(`saved ${endpoint} (token ${maskToken(token)}) to ${credentialsPath()}\n`);
  return 0;
}

export async function runSkillsCli(argv: string[]): Promise<number> {
  const { writeFileSync, mkdirSync, existsSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const { renderSkillMarkdown } = await import("./skill.js");
  const { flags } = parseBrowseArgs(argv);

  const markdown = renderSkillMarkdown();
  const targets =
    typeof flags.rest.dir === "string"
      ? [flags.rest.dir]
      : [join(homedir(), ".claude", "skills"), join(homedir(), ".codex", "skills")].filter((dir) =>
          existsSync(dir.replace(/\/skills$/, "")),
        );

  if (targets.length === 0) {
    process.stdout.write(`${markdown}`);
    return 0;
  }

  for (const base of targets) {
    const dir = join(base, "browser-gateway");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), markdown);
    process.stdout.write(`installed ${join(dir, "SKILL.md")}\n`);
  }
  return 0;
}

export async function runWhoamiCli(): Promise<number> {
  try {
    const creds = resolveEndpoint({});
    process.stdout.write(`endpoint: ${creds.endpoint}\ntoken:    ${maskToken(creds.token)}\n`);
    const transport = new NodeCdpTransport(connectUrl(creds));
    try {
      await transport.ready(10_000);
      await transport.close();
      process.stdout.write("reachable: yes\n");
    } catch (err) {
      process.stdout.write(`reachable: no (${err instanceof Error ? err.message : String(err)})\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

export function runLogoutCli(): number {
  process.stdout.write(clearCredentials() ? "signed out\n" : "nothing to sign out of\n");
  return 0;
}

function printBrowseHelp(): void {
  process.stdout.write(`browser-gateway browse <verb> [args] [flags]

Drives one browser per named session. The session stays open between commands.

Verbs:
  open <url>                  go to a page, print its interactive elements
  snapshot                    list clickable and typeable elements (e1, e2, ...)
  click @e4                   click an element
  fill @e2 <text>             replace a field's text
  type @e2 <text>             type without clearing
  press @e2 Enter             press a key (ref optional)
  check|uncheck @e5           set a checkbox
  select @e7 <option>         pick a dropdown option
  hover @e4                   hover an element
  scroll up|down              scroll the page
  extract                     read the page (--format markdown|text|links)
  screenshot [@e4]            jpeg screenshot (--full, --changed)
  wait <text>                 wait for text (--selector, --url, --timeout)
  tabs [list|new|select|close]
  eval <expression>           run javascript in the page
  observe                     console, failed requests, downloads, dialogs
  close                       close this session
  sessions                    list open sessions

Flags:
  --session <name>            session name (default: default)
  --endpoint <url>            cdp endpoint (default: saved login)
  --token <token>             router token
  --json                      print the raw result
  --full --all --changed      snapshot and screenshot options
  --idle-minutes <n>          close after this long with no command

Examples:
  browser-gateway login --endpoint wss://cdp.browsergateway.io/v1/connect --token bg_xxx
  browser-gateway browse open https://en.wikipedia.org/wiki/Web_browser
  browser-gateway browse fill @e5 "headless browser"
  browser-gateway browse extract --format text
  browser-gateway browse close
`);
}
