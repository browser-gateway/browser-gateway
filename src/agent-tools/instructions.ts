export interface InstructionsOptions {
  idleTimeoutS?: number;
  hardCapHours?: number;
  hosted?: boolean;
}

/** Usage rules handed to the agent: MCP `instructions`, CLI help and SKILL.md all
 *  render this same text so the guidance can never drift between front doors. */
export function agentInstructions(opts: InstructionsOptions = {}): string {
  const idle = opts.idleTimeoutS ?? 300;
  const cap = opts.hardCapHours ?? 4;
  const cost = opts.hosted
    ? "Each browser is a paid cloud session billed while it runs."
    : "Each browser is a real session on the provider you routed to.";

  return [
    `Browser sessions. ${cost}`,
    "",
    "Session rules:",
    `- One browser per task. Reuse the open session instead of opening more.`,
    `- It closes after ${Math.round(idle / 60)} minutes with no action from you, and always at ${cap} hours.`,
    "- Close the browser yourself as soon as the task is done.",
    "- Ask for a fresh browser only when you need a clean profile or the page state is unrecoverable.",
    "- Results tell you the session id and seconds left. Watch them instead of guessing.",
    "",
    "Working efficiently:",
    "- Snapshots list only what you can click or type, labelled e1, e2, and only what is on screen.",
    "- Act on those labels. Labels change after every navigation, so re-snapshot first.",
    "- Send several steps in one act call (fill, fill, click) instead of one call each.",
    "- After an action you get only what changed. Ask for a full snapshot only when you need it.",
    "- Use extract to read a page. It is far cheaper than a screenshot.",
    "- Take screenshots only when you must see layout, and prefer one element over the whole page.",
    "- Use a saved profile to skip logins instead of signing in again.",
    "",
    "When something fails:",
    "- A stale label means the page moved on. Take a fresh snapshot.",
    "- An element that is not actionable tells you why (disabled, hidden, moving). Fix the cause.",
    "- Do not repeat the same failing action. Read the page, then try another route.",
    "- Dialogs are answered automatically and reported back to you.",
  ].join("\n");
}
