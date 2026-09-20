export interface BrowseRequest {
  id: number;
  verb: string;
  args: string[];
  flags: Record<string, string | boolean>;
}

export interface BrowseResponse {
  id: number;
  ok: boolean;
  text?: string;
  data?: unknown;
  error?: string;
}

export interface BrowseFlags {
  session: string;
  endpoint?: string;
  token?: string;
  json: boolean;
  rest: Record<string, string | boolean>;
}

export const BROWSE_VERBS = [
  "open",
  "snapshot",
  "click",
  "fill",
  "type",
  "press",
  "check",
  "uncheck",
  "select",
  "hover",
  "scroll",
  "extract",
  "screenshot",
  "wait",
  "tabs",
  "eval",
  "observe",
  "close",
  "sessions",
] as const;

export type BrowseVerb = (typeof BROWSE_VERBS)[number];

export function isBrowseVerb(value: string): value is BrowseVerb {
  return (BROWSE_VERBS as readonly string[]).includes(value);
}

/** Splits `browse` argv into positionals and flags. Values may be `--flag=x` or `--flag x`. */
export function parseBrowseArgs(argv: string[]): { verb: string; args: string[]; flags: BrowseFlags } {
  const positionals: string[] = [];
  const raw: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const [name, inline] = token.slice(2).split(/=(.*)/s);
    if (!name) continue;
    if (inline !== undefined) {
      raw[name] = inline;
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      raw[name] = next;
      i++;
    } else {
      raw[name] = true;
    }
  }

  const { session, endpoint, token, json, ...rest } = raw;
  return {
    verb: positionals[0] ?? "",
    args: positionals.slice(1),
    flags: {
      session: typeof session === "string" && session ? session : "default",
      endpoint: typeof endpoint === "string" ? endpoint : undefined,
      token: typeof token === "string" ? token : undefined,
      json: json === true || json === "true",
      rest,
    },
  };
}

/** Accepts `@e4` or `e4` so agents can paste either form. */
export function normaliseRef(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith("@") ? value.slice(1) : value;
}

export function flagNumber(flags: Record<string, string | boolean>, name: string): number | undefined {
  const value = flags[name];
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
