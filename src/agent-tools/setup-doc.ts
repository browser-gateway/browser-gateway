import { AGENT_TOOL_NAMES } from "./tool-defs.js";
import { IDLE_DEFAULT_MS } from "./policy.js";

export interface McpSetupDocOptions {
  /** Full URL of the MCP endpoint, e.g. `https://host/mcp`. */
  mcpUrl: string;
  /** One sentence telling the agent where the user gets their key. */
  keySource: string;
  /** Environment variable the config blocks read the key from. */
  keyEnvVar?: string;
  /** Idle ceiling this server enforces, in minutes. */
  maxIdleMinutes?: number;
  /** One sentence on what a session costs, when it costs anything. */
  costNote?: string;
}

/** Setup instructions an agent fetches to configure itself against this server.
 *  Served unauthenticated at `GET /mcp/setup.md`, so it must never contain a key. */
export function mcpSetupDoc(opts: McpSetupDocOptions): string {
  const { mcpUrl, keySource } = opts;
  const envVar = opts.keyEnvVar ?? "BROWSER_GATEWAY_KEY";
  const idleMinutes = opts.maxIdleMinutes ?? IDLE_DEFAULT_MS / 60_000;
  const costNote = opts.costNote ?? "";

  return `# browser-gateway setup instructions

These are the official setup instructions for browser-gateway. Complete every step
yourself by running the commands directly. Do not hand the commands to the user to
run. The one thing you must ask for is the key in step 1.

## What browser-gateway is

browser-gateway gives you a real web browser you can drive. Not an HTTP fetch: a
full browser that runs JavaScript, holds a login, fills forms and shows you what a
person would see.

Use it when the page needs a browser. Good reasons: the content only appears after
JavaScript runs, the page is behind a login, you need to click or type to get
somewhere, you need to see the rendered page, or a plain fetch returned an empty
shell or was blocked.

Do not use it when a plain HTTP request would do. Fetching a JSON API, reading a
static page or downloading a file does not need a browser and a browser is slower
and costs the user money.

You get a session, and inside it tabs. Navigate, look at the page, act on it, read
what you need, close the session.

## Step 1: get the key

${keySource}

Do not continue without it. Do not invent one. Put it in an environment variable
named \`${envVar}\` rather than writing it into a file that might be committed.

## Step 2: write the config for the agent you are

Work out which agent you are running inside and use only that block. If you cannot
tell, ask the user which tool they are in rather than writing several configs.

Endpoint: \`${mcpUrl}\`
Transport: streamable HTTP
Auth: \`Authorization: Bearer <key>\` request header. The key never goes in the URL.

Use whichever block matches the tool you are running inside.

### Claude Code

\`\`\`bash
claude mcp add --transport http browser-gateway ${mcpUrl} \\
  --header "Authorization: Bearer $${envVar}"
\`\`\`

Or in \`.mcp.json\`:

\`\`\`json
{ "mcpServers": { "browser-gateway": {
  "type": "http", "url": "${mcpUrl}",
  "headers": { "Authorization": "Bearer \${${envVar}}" } } } }
\`\`\`

### Codex

\`\`\`bash
codex mcp add browser-gateway --url ${mcpUrl} --bearer-token-env-var ${envVar}
\`\`\`

Or in \`~/.codex/config.toml\`:

\`\`\`toml
[mcp_servers.browser-gateway]
url = "${mcpUrl}"
bearer_token_env_var = "${envVar}"
\`\`\`

### Cursor

\`~/.cursor/mcp.json\` or \`.cursor/mcp.json\`:

\`\`\`json
{ "mcpServers": { "browser-gateway": {
  "url": "${mcpUrl}",
  "headers": { "Authorization": "Bearer \${env:${envVar}}" } } } }
\`\`\`

### VS Code and Copilot

\`.vscode/mcp.json\`:

\`\`\`json
{
  "inputs": [ { "type": "promptString", "id": "bg-key",
                "description": "browser-gateway router key", "password": true } ],
  "servers": { "browser-gateway": {
    "type": "http", "url": "${mcpUrl}",
    "headers": { "Authorization": "Bearer \${input:bg-key}" } } }
}
\`\`\`

### Windsurf

\`~/.codeium/windsurf/mcp_config.json\`. Note the key is \`serverUrl\`:

\`\`\`json
{ "mcpServers": { "browser-gateway": {
  "serverUrl": "${mcpUrl}",
  "headers": { "Authorization": "Bearer \${env:${envVar}}" } } } }
\`\`\`

### Cline

\`cline_mcp_settings.json\`. The type must be exactly \`streamableHttp\`; any other spelling falls back to a transport this server does not answer:

\`\`\`json
{ "mcpServers": { "browser-gateway": {
  "type": "streamableHttp", "url": "${mcpUrl}",
  "headers": { "Authorization": "Bearer <key>" },
  "disabled": false, "autoApprove": [] } } }
\`\`\`

### Zed

\`\`\`json
{ "context_servers": { "browser-gateway": {
  "url": "${mcpUrl}",
  "headers": { "Authorization": "Bearer <key>" } } } }
\`\`\`

### OpenCode

\`opencode.json\`. The type is \`remote\`:

\`\`\`json
{ "mcp": { "browser-gateway": {
  "type": "remote", "url": "${mcpUrl}", "enabled": true,
  "headers": { "Authorization": "Bearer {env:${envVar}}" } } } }
\`\`\`

### Goose

\`~/.config/goose/config.yaml\`. The key is \`uri\`, not url:

\`\`\`yaml
extensions:
  browser-gateway:
    type: streamable_http
    name: browser-gateway
    enabled: true
    uri: "${mcpUrl}"
    headers:
      Authorization: "Bearer <key>"
    timeout: 300
\`\`\`

### Clients without native remote support

Claude Desktop, JetBrains AI Assistant and Gemini CLI need a local bridge. Keep the colon unspaced, it is required:

\`\`\`json
{ "mcpServers": { "browser-gateway": {
  "command": "npx",
  "args": ["mcp-remote", "${mcpUrl}", "--header", "Authorization:\${AUTH_HEADER}"],
  "env": { "AUTH_HEADER": "Bearer <key>" } } } }
\`\`\`

## Step 3: check it works and tell the user

Restart or reload the client so it picks up the config. Then prove it works: open a
session, navigate to https://en.wikipedia.org/wiki/Web_browser, take a snapshot, and
close the session. If all four succeed, the setup is done.

Then show the user this, filled in:

    browser-gateway connected
    Server:   ${mcpUrl}
    Tools:    ${AGENT_TOOL_NAMES.length} browser tools
    Try it:   "open example.com and tell me what it says"

If you get 401, the header is missing or the key is wrong. If you get 405, the client
connected with the wrong transport; check the type field against the block you used.
If the tools do not appear at all, the client did not reload; tell the user to restart it.

## What you can do

Tools: ${AGENT_TOOL_NAMES.join(", ")}.

Read a page with \`browser_navigate\` then \`browser_snapshot\`. The snapshot lists only the parts you can interact with, each tagged \`e1\`, \`e2\` and so on. Pass those tags to \`browser_act\` to click or type. Use \`browser_extract\` when you want the content rather than the controls, and \`browser_screenshot\` only when the task is visual.

## Rules to respect

One session per task. Reuse it across steps rather than opening a new one per page, and close it when the task ends.

A session closes after ${idleMinutes} minutes with no tool call, and always at 4 hours. Asking for a longer idle window is rejected. If a session has closed, open a new one; the page state is gone.

${costNote}

## Starter prompts for the user

- "Open example.com and tell me what the page says."
- "Log into this site with these credentials and confirm the dashboard loads."
- "Take a screenshot of this page at mobile width."
- "Fill this form and tell me what error it shows."
`;
}
