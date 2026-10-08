---
name: browser-gateway
description: Real browser for web pages, from the terminal. Use when WebFetch fails (403, 402, 429, captcha, empty or JavaScript-only page), when a page needs a login, or when the user wants a screenshot of a website. Opens pages, reads them as markdown, clicks and types, on local Chrome or any cloud browser provider routed through browser-gateway.
---

# Browser control with browser-gateway

Install once, then drive a browser from the terminal. Sessions stay open between commands.

```bash
npm install -g browser-gateway
browser-gateway login --endpoint wss://cdp.browsergateway.io/v1/connect --token <router key>
browser-gateway browse open https://example.com
```

Without a login, point any command at a browser directly:

```bash
browser-gateway browse open https://example.com --endpoint ws://127.0.0.1:9222/devtools/browser/<id>
```

## Commands

| Command | What it does |
|---|---|
| `browse fetch <url>` | Read a page as markdown in one step; says when it looks blocked |
| `browse open <url>` | Go to a page and print its clickable and typeable elements |
| `browse snapshot` | List those elements again (e1, e2, ...) |
| `browse click @e4` | Click an element |
| `browse fill @e2 <text>` | Replace a field's text |
| `browse type @e2 <text>` | Type without clearing |
| `browse press @e2 Enter` | Press a key |
| `browse check @e5` / `uncheck` | Set a checkbox |
| `browse select @e7 <option>` | Pick a dropdown option |
| `browse scroll down` | Scroll the page |
| `browse extract --format text` | Read the page (markdown, text or links) |
| `browse screenshot [@e4]` | Screenshot the page or one element |
| `browse wait <text>` | Wait for text, a selector or a url |
| `browse tabs` | List, open, switch or close tabs |
| `browse eval <expression>` | Run javascript in the page |
| `browse observe` | Console output, failed requests, downloads, dialogs |
| `browse close` | Close the session |

Flags: `--session <name>` for parallel work, `--json` for raw output, `--full` for the whole page,
`--changed` to skip unchanged output, `--idle-minutes <n>` to set the idle close.

## How to work with it

Real browsers for web pages. Use these tools when the user wants a screenshot of a website, when a page needs JavaScript, a login or a real browser, or when a built-in web fetch failed or returned 403, 402, 429, a captcha or an almost empty page.
- One page to read: browse fetch <url>. To see a page: browse open <url>, then browse screenshot.
- Several steps on a site (log in, fill a form, click through): browse open, then the other verbs.

Browser sessions. Each browser is a real session on the provider you routed to.

Session rules:
- One browser per task. Reuse the open session instead of opening more.
- It closes after 5 minutes with no action from you, and always at 4 hours.
- Close the browser yourself as soon as the task is done.
- Ask for a fresh browser only when you need a clean profile or the page state is unrecoverable.
- Results tell you the session id and seconds left. Watch them instead of guessing.

Working efficiently:
- Snapshots list only what you can click or type, labelled e1, e2, and only what is on screen.
- Act on those labels. Labels change after every navigation, so re-snapshot first.
- Send several steps in one act call (fill, fill, click) instead of one call each.
- After an action you get only what changed. Ask for a full snapshot only when you need it.
- Use extract to read a page. It is far cheaper than a screenshot.
- Inside a session, prefer extract over screenshot unless you need to see the layout, and prefer one element over the whole page.
- Use a saved profile to skip logins instead of signing in again.

When something fails:
- A stale label means the page moved on. Take a fresh snapshot.
- An element that is not actionable tells you why (disabled, hidden, moving). Fix the cause.
- Do not repeat the same failing action. Read the page, then try another route.
- Dialogs are answered automatically and reported back to you.

## Worked example

```bash
browser-gateway browse open https://en.wikipedia.org/wiki/Web_browser
browser-gateway browse fill @e5 "headless browser"
browser-gateway browse press @e5 Enter
browser-gateway browse extract --format text --max 2000
browser-gateway browse close
```
