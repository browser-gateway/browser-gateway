import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Credentials {
  endpoint: string;
  token?: string;
}

const CONFIG_DIR = join(homedir(), ".browser-gateway");
const CREDENTIALS_PATH = join(CONFIG_DIR, "credentials.json");

export function credentialsPath(): string {
  return CREDENTIALS_PATH;
}

export function saveCredentials(creds: Credentials): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CREDENTIALS_PATH, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  chmodSync(CREDENTIALS_PATH, 0o600);
}

export function readCredentials(): Credentials | null {
  if (!existsSync(CREDENTIALS_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8")) as Credentials;
    return parsed.endpoint ? parsed : null;
  } catch {
    return null;
  }
}

export function clearCredentials(): boolean {
  if (!existsSync(CREDENTIALS_PATH)) return false;
  rmSync(CREDENTIALS_PATH, { force: true });
  return true;
}

/** Flag beats environment beats the saved file, so scripts can override safely. */
export function resolveEndpoint(flags: { endpoint?: string; token?: string }): Credentials {
  const saved = readCredentials();
  const endpoint = flags.endpoint ?? process.env.BG_ENDPOINT ?? saved?.endpoint;
  const token = flags.token ?? process.env.BG_TOKEN ?? saved?.token;
  if (!endpoint) {
    throw new Error("no endpoint. Pass --endpoint, set BG_ENDPOINT, or run: browser-gateway login --endpoint <url>");
  }
  return { endpoint, token };
}

export function maskToken(token?: string): string {
  if (!token) return "(none)";
  return token.length <= 8 ? "***" : `${token.slice(0, 4)}...${token.slice(-2)}`;
}

/** Builds the CDP url a browse session connects to. */
export function connectUrl(creds: Credentials): string {
  const endpoint = creds.endpoint.replace(/\/$/, "");
  const base = /\/v1\/connect$|\/devtools\//.test(endpoint) ? endpoint : `${endpoint}/v1/connect`;
  if (!creds.token) return base;
  return `${base}${base.includes("?") ? "&" : "?"}token=${encodeURIComponent(creds.token)}`;
}
