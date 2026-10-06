const PLACEHOLDER = "[earlier screenshot removed to save space]";

/** Returns a copy of a conversation in which only the last `keep` screenshots
 *  remain; older ones become a short text note. Works on Claude messages and
 *  on both Gemini request shapes. The input is not changed. */
export function pruneImages<T>(transcript: T, keep = 3): T {
  const copy = structuredClone(transcript);
  const found: Array<{ holder: Record<string, unknown> | unknown[]; key: string | number; node: Record<string, unknown> }> = [];
  const walk = (value: unknown, holder: Record<string, unknown> | unknown[] | null, key: string | number): void => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, value, i));
      return;
    }
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (holder && (node.type === "image" || "inlineData" in node || "inline_data" in node)) {
      found.push({ holder, key, node });
      return;
    }
    for (const [k, v] of Object.entries(node)) walk(v, node, k);
  };
  walk(copy, null, "");
  for (const { holder, key, node } of found.slice(0, Math.max(0, found.length - Math.max(0, keep)))) {
    const replacement = node.type === "image" ? { type: "text", text: PLACEHOLDER } : { text: PLACEHOLDER };
    (holder as Record<string | number, unknown>)[key] = replacement;
  }
  return copy;
}
