/** `${VAR}` placeholders in gateway.yml: resolved on load, put back on save so secrets never reach the file. */

const PLACEHOLDER = /\$\{([^}]+)\}/g;
const MIN_RESTORABLE_VALUE_LENGTH = 8;

/** What the loaded config held as placeholders, keyed by JSON path, plus each long resolved value. */
export interface EnvTemplates {
  byPath: Map<string, { template: string; resolved: string }>;
  byValue: Map<string, string>;
}

export function emptyEnvTemplates(): EnvTemplates {
  return { byPath: new Map(), byValue: new Map() };
}

const pathKey = (path: readonly string[]) => JSON.stringify(path);

function mapStrings(node: unknown, path: string[], fn: (value: string, path: string[]) => string): unknown {
  if (typeof node === "string") return fn(node, path);
  if (Array.isArray(node)) return node.map((item, i) => mapStrings(item, [...path, String(i)], fn));
  if (node !== null && typeof node === "object") {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, mapStrings(v, [...path, k], fn)]));
  }
  return node;
}

function resolveString(value: string, templates: EnvTemplates): string {
  return value.replace(PLACEHOLDER, (placeholder, inner: string) => {
    const [name, fallback] = inner.split(":-");
    const resolved = process.env[name!.trim()] ?? fallback?.trim() ?? "";
    if (resolved.length >= MIN_RESTORABLE_VALUE_LENGTH && !templates.byValue.has(resolved)) {
      templates.byValue.set(resolved, placeholder);
    }
    return resolved;
  });
}

/** Resolves every placeholder in a parsed config and records where each one was. */
export function interpolateConfig(raw: unknown): { value: unknown; templates: EnvTemplates } {
  const templates = emptyEnvTemplates();
  const value = mapStrings(raw, [], (node, path) => {
    const resolved = resolveString(node, templates);
    if (resolved !== node) templates.byPath.set(pathKey(path), { template: node, resolved });
    return resolved;
  });
  return { value, templates };
}

function hideResolvedValues(value: string, templates: EnvTemplates): string {
  let out = value;
  const longestFirst = [...templates.byValue.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [resolved, placeholder] of longestFirst) {
    if (out.includes(resolved)) out = out.split(resolved).join(placeholder);
  }
  return out;
}

/** Returns a copy of `output` with unchanged values put back as their placeholders and any resolved secret masked by its placeholder. */
export function restoreEnvPlaceholders(output: unknown, templates: EnvTemplates): unknown {
  return mapStrings(output, [], (node, path) => {
    const known = templates.byPath.get(pathKey(path));
    if (known && known.resolved === node) return known.template;
    return hideResolvedValues(node, templates);
  });
}
