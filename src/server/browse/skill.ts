import { agentInstructions, IDLE_DEFAULT_MS } from "../../agent-tools/index.js";

const FRONTMATTER_NAME = "browser-gateway";
const DESCRIPTION =
  "Drive a real browser from the terminal: open pages, read them, click and type, across local Chrome or any cloud browser provider routed through browser-gateway. Use when a task needs a live web page rather than an HTTP fetch.";

const VERB_TABLE = `| Command | What it does |
|---|---|
| \`browse open <url>\` | Go to a page and print its clickable and typeable elements |
| \`browse snapshot\` | List those elements again (e1, e2, ...) |
| \`browse click @e4\` | Click an element |
| \`browse fill @e2 <text>\` | Replace a field's text |
| \`browse type @e2 <text>\` | Type without clearing |
| \`browse press @e2 Enter\` | Press a key |
| \`browse check @e5\` / \`uncheck\` | Set a checkbox |
| \`browse select @e7 <option>\` | Pick a dropdown option |
| \`browse scroll down\` | Scroll the page |
| \`browse extract --format text\` | Read the page (markdown, text or links) |
| \`browse screenshot [@e4]\` | Screenshot the page or one element |
| \`browse wait <text>\` | Wait for text, a selector or a url |
| \`browse tabs\` | List, open, switch or close tabs |
| \`browse eval <expression>\` | Run javascript in the page |
| \`browse observe\` | Console output, failed requests, downloads, dialogs |
| \`browse close\` | Close the session |`;

/** SKILL.md content. Body renders {@link agentInstructions} so the CLI, the MCP
 *  handshake and this file can never drift apart. */
export function renderSkillMarkdown(): string {
  return `---
name: ${FRONTMATTER_NAME}
description: ${DESCRIPTION}
---

# Browser control with browser-gateway

Install once, then drive a browser from the terminal. Sessions stay open between commands.

\`\`\`bash
npm install -g browser-gateway
browser-gateway login --endpoint wss://cdp.browsergateway.io/v1/connect --token <router key>
browser-gateway browse open https://example.com
\`\`\`

Without a login, point any command at a browser directly:

\`\`\`bash
browser-gateway browse open https://example.com --endpoint ws://127.0.0.1:9222/devtools/browser/<id>
\`\`\`

## Commands

${VERB_TABLE}

Flags: \`--session <name>\` for parallel work, \`--json\` for raw output, \`--full\` for the whole page,
\`--changed\` to skip unchanged output, \`--idle-minutes <n>\` to set the idle close.

## How to work with it

${agentInstructions({ idleTimeoutS: IDLE_DEFAULT_MS / 1000 })}

## Worked example

\`\`\`bash
browser-gateway browse open https://en.wikipedia.org/wiki/Web_browser
browser-gateway browse fill @e5 "headless browser"
browser-gateway browse press @e5 Enter
browser-gateway browse extract --format text --max 2000
browser-gateway browse close
\`\`\`
`;
}

export const skillFrontmatter = { name: FRONTMATTER_NAME, description: DESCRIPTION };
