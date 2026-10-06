import type { RefEntry } from "./refs.js";

export interface FindMatch {
  ref: string;
  role: string;
  name: string;
  score: number;
}

/** Ranks elements against a plain-language description by shared words, with a
 *  bonus when the description names the element's role. No model is involved. */
export function findElements(query: string, entries: Iterable<[string, RefEntry]>, limit = 20): FindMatch[] {
  const words = tokens(query);
  if (words.length === 0) return [];
  const phrase = query.trim().toLowerCase();
  const matches: FindMatch[] = [];
  for (const [ref, entry] of entries) {
    const name = entry.name.toLowerCase();
    const nameWords = new Set(tokens(entry.name));
    let score = 0;
    for (const w of words) {
      if (nameWords.has(w)) score += 2;
      else if (name.includes(w)) score += 1;
      if (entry.role === w || (w === "input" && /textbox|searchbox|combobox/.test(entry.role))) score += 1;
    }
    if (name && phrase.includes(name)) score += 2;
    if (score > 0) matches.push({ ref, role: entry.role, name: entry.name, score });
  }
  return matches.sort((a, b) => b.score - a.score).slice(0, limit);
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

const STOP_WORDS = new Set(["the", "a", "an", "to", "of", "for", "on", "in", "and", "or", "with", "that", "this", "field", "element"]);
