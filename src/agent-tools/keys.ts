export interface KeySpec {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

/** CDP `modifiers` bitmask values. */
export const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;
export type ModifierKey = keyof typeof MODIFIER_BITS;

const NAMED: Array<[string, string, number, string?]> = [
  ["Enter", "Enter", 13, "\r"],
  ["Tab", "Tab", 9],
  ["Escape", "Escape", 27],
  ["Backspace", "Backspace", 8],
  ["Delete", "Delete", 46],
  ["Insert", "Insert", 45],
  ["Space", "Space", 32, " "],
  ["ArrowUp", "ArrowUp", 38],
  ["ArrowDown", "ArrowDown", 40],
  ["ArrowLeft", "ArrowLeft", 37],
  ["ArrowRight", "ArrowRight", 39],
  ["Home", "Home", 36],
  ["End", "End", 35],
  ["PageUp", "PageUp", 33],
  ["PageDown", "PageDown", 34],
  ["Control", "ControlLeft", 17],
  ["Shift", "ShiftLeft", 16],
  ["Alt", "AltLeft", 18],
  ["Meta", "MetaLeft", 91],
  ["CapsLock", "CapsLock", 20],
  ["ContextMenu", "ContextMenu", 93],
];

/** Key names agents may pass to a press action, with their CDP codes. */
export const KEY_SPECS: Record<string, KeySpec> = Object.fromEntries([
  ...NAMED.map(([key, code, keyCode, text]) => [key, { key, code, keyCode, ...(text ? { text } : {}) }]),
  ...Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, { key: `F${i + 1}`, code: `F${i + 1}`, keyCode: 112 + i }]),
]);

const PUNCTUATION: Record<string, [string, number]> = {
  "-": ["Minus", 189],
  "=": ["Equal", 187],
  "[": ["BracketLeft", 219],
  "]": ["BracketRight", 221],
  "\\": ["Backslash", 220],
  ";": ["Semicolon", 186],
  "'": ["Quote", 222],
  ",": ["Comma", 188],
  ".": ["Period", 190],
  "/": ["Slash", 191],
  "`": ["Backquote", 192],
};

const ALIASES: Record<string, string> = {
  return: "Enter",
  enter: "Enter",
  kp_enter: "Enter",
  esc: "Escape",
  escape: "Escape",
  backspace: "Backspace",
  back_space: "Backspace",
  del: "Delete",
  delete: "Delete",
  ins: "Insert",
  insert: "Insert",
  tab: "Tab",
  space: "Space",
  spacebar: "Space",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  page_up: "PageUp",
  prior: "PageUp",
  pagedown: "PageDown",
  page_down: "PageDown",
  next: "PageDown",
  ctrl: "Control",
  control: "Control",
  control_l: "Control",
  control_r: "Control",
  controlormeta: "Control",
  shift: "Shift",
  shift_l: "Shift",
  shift_r: "Shift",
  alt: "Alt",
  alt_l: "Alt",
  alt_r: "Alt",
  option: "Alt",
  meta: "Meta",
  meta_l: "Meta",
  super: "Meta",
  super_l: "Meta",
  cmd: "Meta",
  command: "Meta",
  win: "Meta",
  capslock: "CapsLock",
  caps_lock: "CapsLock",
  menu: "ContextMenu",
  contextmenu: "ContextMenu",
  minus: "-",
  equal: "=",
  plus: "+",
  comma: ",",
  period: ".",
  slash: "/",
  semicolon: ";",
};

/** Resolves a key name in any common spelling (DOM, xdotool, short forms)
 *  to its canonical DOM key name. Single characters pass through. */
export function normalizeKeyName(name: string): string {
  if (name.length === 1) return name;
  if (KEY_SPECS[name]) return name;
  const alias = ALIASES[name.toLowerCase()];
  if (alias) return alias;
  const fn = /^f([1-9]|1[0-2])$/i.exec(name);
  if (fn) return `F${fn[1]}`;
  throw new Error(`unknown key "${name}". Use a key name like Enter, Tab, ArrowDown, F5, or a single character.`);
}

export function keySpecFor(name: string): KeySpec {
  const key = normalizeKeyName(name);
  const named = KEY_SPECS[key];
  if (named) return named;
  const upper = key.toUpperCase();
  if (/^[A-Z]$/.test(upper)) return { key, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: key };
  if (/^[0-9]$/.test(key)) return { key, code: `Digit${key}`, keyCode: key.charCodeAt(0), text: key };
  const punct = PUNCTUATION[key];
  if (punct) return { key, code: punct[0], keyCode: punct[1], text: key };
  return { key, code: "", keyCode: 0, text: key };
}

export interface Chord {
  modifiers: ModifierKey[];
  key: KeySpec | null;
}

/** Parses "ctrl+shift+a", "Control+C", "Return" or ["Control", "C"] into one chord.
 *  A chord made only of modifiers (e.g. "shift") has `key` null. */
export function parseChord(input: string | string[]): Chord {
  const parts = Array.isArray(input) ? input : splitChord(input);
  if (parts.length === 0) throw new Error("empty key combination");
  const specs = parts.map((p) => keySpecFor(p));
  const modifiers: ModifierKey[] = [];
  let key: KeySpec | null = null;
  for (const [i, spec] of specs.entries()) {
    const isModifier = spec.key in MODIFIER_BITS;
    if (isModifier && (i < specs.length - 1 || specs.length > 1)) {
      if (!modifiers.includes(spec.key as ModifierKey)) modifiers.push(spec.key as ModifierKey);
      continue;
    }
    if (key) throw new Error(`"${parts.join("+")}" has more than one non-modifier key`);
    key = spec;
  }
  return { modifiers, key };
}

function splitChord(input: string): string[] {
  const trimmed = input.trim();
  if (trimmed === "+") return ["+"];
  const parts = trimmed.split("+");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "" && parts[i + 1] === "") {
      out.push("+");
      i++;
    } else if (parts[i] !== "") {
      out.push(parts[i]!);
    }
  }
  return out;
}

export function modifierMask(modifiers: Iterable<ModifierKey>): number {
  let mask = 0;
  for (const m of modifiers) mask |= MODIFIER_BITS[m];
  return mask;
}
