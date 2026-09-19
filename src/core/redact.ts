const SECRET_PARAM_PATTERN =
  /^(token|apikey|api_key|api-key|key|secret|password|pass|auth|access_token|jwt|sig|signature)$/i;

const SECRET_HEADER_PATTERN =
  /(authorization|token|api[-_]?key|apikey|secret|password|cookie|auth)/i;

const MASK = "***";

/**
 * Masks credentials in a connection URL: userinfo and any secret-looking query
 * parameter. Returns the input unchanged when it does not parse as a URL.
 */
export function redactConnectionUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.username) parsed.username = MASK;
  if (parsed.password) parsed.password = MASK;
  for (const key of [...parsed.searchParams.keys()]) {
    if (SECRET_PARAM_PATTERN.test(key)) parsed.searchParams.set(key, MASK);
  }
  return parsed.toString();
}

/** Masks every header value whose name carries credentials. */
export function redactHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key] = SECRET_HEADER_PATTERN.test(key) ? MASK : value;
  }
  return out;
}

/** Masks `token=`, `apikey=`, `user:pass@` and friends inside a config blob. */
export function redactConnectionUrlsInText(text: string): string {
  return text
    .replace(
      /([?&](?:token|apikey|api_key|api-key|access_token|key|secret|password|jwt)=)([^&\s"']+)/gi,
      `$1${MASK}`,
    )
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:"']+):([^/\s@"']+)@/gi, `$1${MASK}:${MASK}@`);
}
