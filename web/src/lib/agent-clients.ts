export const SERVER_NAME = "browser-gateway";
export const SETUP_GUIDE_PATH = "/mcp/setup.md";

export interface McpSecret {
  mcpUrl: string;
  token: string | null;
}

interface SnippetBlock {
  label: string;
  build: (s: McpSecret) => string;
}

export interface AgentClient {
  id: string;
  name: string;
  tile: string | null;
  selfSetup?: string;
  keyHome?: string;
  blocks: SnippetBlock[];
  note?: string;
  docsUrl: string;
}

function headers(s: McpSecret): Record<string, string> | undefined {
  return s.token ? { Authorization: `Bearer ${s.token}` } : undefined;
}

function configJson(wrapper: string, entry: Record<string, unknown>): string {
  return `{ "${wrapper}": {
  "${SERVER_NAME}": ${JSON.stringify(entry, null, 1).replace(/\n\s*/g, " ")}
} }`;
}

function headerFlag(s: McpSecret): string {
  return s.token ? ` --header "Authorization: Bearer ${s.token}"` : "";
}

export function agentPrompt(client: AgentClient, s: McpSecret, origin: string): string {
  const exact = client.blocks.flatMap((b) => [`${b.label}:`, b.build(s), ""]);
  const lines = [
    `Add the browser-gateway MCP server to ${client.name} for me, so you can open and control browsers through my gateway.`,
    "",
    "Server details:",
    `- Name: ${SERVER_NAME}`,
    "- Type: remote HTTP (streamable HTTP)",
    `- URL: ${s.mcpUrl}`,
    s.token ? `- Request header: Authorization: Bearer ${s.token}` : "- No request header: this gateway runs without a token.",
    "",
  ];
  if (client.selfSetup) {
    lines.push(`How: ${client.selfSetup}. Make it available in every project, not only this folder.`, "", ...exact);
  }
  if (s.token && client.keyHome) {
    lines.push(
      `Where the token goes: ${client.keyHome}. That file belongs to my user account and sits outside every project.`,
      "Do not put the token in a project file that can be committed, a shell profile or an environment variable.",
    );
  }
  lines.push(
    `When it is added, check that ${SERVER_NAME} shows as connected. If I need to restart you before the new tools load, tell me.`,
    `Setup guide: ${origin}${SETUP_GUIDE_PATH}`,
  );
  return lines.join("\n");
}

export const AGENT_CLIENTS: AgentClient[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    tile: "/web/logos/claude-code.png",
    keyHome: "your user settings, ~/.claude.json (what --scope user writes to)",
    selfSetup: "use the claude mcp add command with --transport http and --scope user",
    blocks: [
      {
        label: "Run in your terminal",
        build: (s) => `claude mcp add --transport http --scope user ${SERVER_NAME} ${s.mcpUrl}${headerFlag(s)}`,
      },
    ],
    docsUrl: "https://code.claude.com/docs/en/mcp",
  },
  {
    id: "codex",
    name: "Codex",
    tile: "/web/logos/codex.png",
    keyHome: "your user config, ~/.codex/config.toml",
    selfSetup: "add an [mcp_servers.browser-gateway] entry with url to ~/.codex/config.toml",
    blocks: [
      {
        label: "Add to ~/.codex/config.toml",
        build: (s) =>
          `[mcp_servers.${SERVER_NAME}]\nurl = "${s.mcpUrl}"${s.token ? `\nhttp_headers = { Authorization = "Bearer ${s.token}" }` : ""}`,
      },
    ],
    docsUrl: "https://learn.chatgpt.com/docs/extend/mcp?surface=cli",
  },
  {
    id: "cursor",
    name: "Cursor",
    tile: "/web/logos/cursor.png",
    keyHome: "your global config, ~/.cursor/mcp.json",
    selfSetup: "add it under mcpServers in ~/.cursor/mcp.json with its url",
    blocks: [
      {
        label: "Add to ~/.cursor/mcp.json",
        build: (s) => configJson("mcpServers", { url: s.mcpUrl, headers: headers(s) }),
      },
    ],
    docsUrl: "https://cursor.com/docs/mcp/install-links",
  },
  {
    id: "vscode",
    name: "VS Code",
    tile: "/web/logos/vscode.png",
    keyHome: "your user MCP configuration, the user mcp.json that MCP: Open User Configuration opens",
    selfSetup: "add it to your user MCP configuration (the MCP: Open User Configuration command) as an http server",
    blocks: [
      {
        label: "Add to your user mcp.json",
        build: (s) => configJson("servers", { type: "http", url: s.mcpUrl, headers: headers(s) }),
      },
    ],
    docsUrl: "https://code.visualstudio.com/api/extension-guides/ai/mcp",
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    tile: "/web/logos/gemini-cli.png",
    keyHome: "your user settings, ~/.gemini/settings.json (what --scope user writes to)",
    selfSetup: "use the gemini mcp add command with --transport http and --scope user",
    blocks: [
      {
        label: "Run in your terminal",
        build: (s) => `gemini mcp add --transport http --scope user${headerFlag(s)} ${SERVER_NAME} ${s.mcpUrl}`,
      },
    ],
    docsUrl: "https://geminicli.com/docs/tools/mcp-server/",
  },
  {
    id: "windsurf",
    name: "Windsurf",
    tile: "/web/logos/windsurf.png",
    keyHome: "your user MCP config, ~/.codeium/windsurf/mcp_config.json",
    selfSetup: "add it under mcpServers in your user mcp_config.json with serverUrl",
    blocks: [
      {
        label: "Add to ~/.codeium/windsurf/mcp_config.json",
        build: (s) => configJson("mcpServers", { serverUrl: s.mcpUrl, headers: headers(s) }),
      },
    ],
    docsUrl: "https://docs.devin.ai/desktop/cascade/mcp",
  },
  {
    id: "opencode",
    name: "OpenCode",
    tile: "/web/logos/opencode.png",
    keyHome: "your global config, ~/.config/opencode/opencode.json",
    selfSetup: "add a remote entry under mcp in ~/.config/opencode/opencode.json with its url",
    blocks: [
      {
        label: "Add to opencode.json",
        build: (s) => configJson("mcp", { type: "remote", url: s.mcpUrl, enabled: true, headers: headers(s) }),
      },
    ],
    docsUrl: "https://opencode.ai/docs/mcp-servers/",
  },
  {
    id: "other",
    name: "Other agent",
    tile: null,
    blocks: [],
    note: "Any agent that supports remote MCP servers over HTTP works. The prompt points it at this gateway's setup guide.",
    docsUrl: "https://docs.browsergateway.com/mcp",
  },
];
