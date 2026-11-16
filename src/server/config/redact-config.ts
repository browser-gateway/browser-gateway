import { parse, stringify } from "yaml";

const MASK = "***";
const SECRET_KEY =
  /^(secret|token|password|passphrase|api[-_]?key|apikey|access[-_]?token|authorization|proxy-authorization|cookie|x-api-key|encryption[-_]?key|credentials?)$/i;
const UNREADABLE = "# This config could not be read safely, so it is hidden here. Sign in to the dashboard to view it.\n";

/** Keeps only the scheme and host of an address; anything after the host could carry a credential. */
function safeAddress(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return MASK;
  }
  if (!url.host) return MASK;
  const rest = url.pathname !== "/" && url.pathname !== "" ? `/${MASK}` : "/";
  const login = url.username || url.password ? `${MASK}@` : "";
  return `${url.protocol}//${login}${url.host}${rest}${url.search || url.hash ? `?${MASK}` : ""}`;
}

function maskString(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("whsec_")) return MASK;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return safeAddress(trimmed);
  if (/:\/\/|%|@/.test(value)) return MASK;
  return value;
}

function maskValue(value: unknown, key: string | null): unknown {
  if (key !== null && SECRET_KEY.test(key) && value !== null && typeof value !== "object") return MASK;
  if (typeof value === "string") return maskString(value);
  if (Array.isArray(value)) return value.map((item) => maskValue(item, key));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = k === "headers" && v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).map((hk) => [hk, MASK])) : maskValue(v, k);
    }
    return out;
  }
  return value;
}

function holdsMask(value: unknown): boolean {
  if (typeof value === "string") return value.includes(MASK);
  if (Array.isArray(value)) return value.some(holdsMask);
  if (value && typeof value === "object") return Object.values(value).some(holdsMask);
  return false;
}

/** True when the YAML still carries a masked value, so saving it would overwrite a real credential. */
export function configHasMaskedValues(yaml: string): boolean {
  if (yaml.includes(UNREADABLE.trim())) return true;
  try {
    return holdsMask(parse(yaml));
  } catch {
    return yaml.includes(MASK);
  }
}

/** Config YAML with every credential masked, for callers not allowed to see raw secrets. */
export function redactConfigYaml(yaml: string): string {
  try {
    return stringify(maskValue(parse(yaml), null), { lineWidth: 0 });
  } catch {
    return UNREADABLE;
  }
}
