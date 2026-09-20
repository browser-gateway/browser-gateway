import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fnv1a } from "../../agent-tools/hash.js";
import type { BrowseRequest, BrowseResponse } from "./protocol.js";

// Unix socket paths are capped near 104 bytes on macOS, so runtime sockets live
// in a short temp path keyed by the home directory rather than under it.
const SESSION_DIR = join(tmpdir(), `browser-gateway-${fnv1a(homedir()).toString(36)}`);
const CONNECT_RETRIES = 150;
const RETRY_DELAY_MS = 200;

export function socketPathFor(name: string): string {
  return join(SESSION_DIR, `${name}.sock`);
}

/** Creates the session directory and refuses to use one another user could have
 *  planted first. The path is under the shared temp directory and derivable from
 *  the home directory, so on a multi-user host it is pre-creatable; `mkdirSync`
 *  leaves an existing directory's owner and mode untouched. */
function ensureSessionDir(): void {
  mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
  const st = lstatSync(SESSION_DIR);
  if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) {
    throw new Error(`${SESSION_DIR} is not a private directory owned by this user. Remove it and retry.`);
  }
}

export function listSessions(): string[] {
  if (!existsSync(SESSION_DIR)) return [];
  return readdirSync(SESSION_DIR)
    .filter((f) => f.endsWith(".sock"))
    .map((f) => f.replace(/\.sock$/, ""));
}

export async function sendToDaemon(socketPath: string, req: BrowseRequest): Promise<BrowseResponse> {
  const socket = await openSocket(socketPath);
  return new Promise<BrowseResponse>((resolve, reject) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      socket.end();
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as BrowseResponse);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    socket.on("error", reject);
    socket.write(`${JSON.stringify(req)}\n`);
  });
}

/** Starts a detached daemon for this session name and waits for its socket. */
export async function ensureDaemon(name: string, endpoint: string, idleMs?: number): Promise<string> {
  const socketPath = socketPathFor(name);
  if (await isAlive(socketPath)) return socketPath;

  ensureSessionDir();
  rmSync(socketPath, { force: true });

  const entry = fileURLToPath(new URL("./daemon-entry.js", import.meta.url));
  const { NODE_OPTIONS: _ignored, ...cleanEnv } = process.env;
  const errLog = openSync(
    `${socketPath}.log`,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
    0o600,
  );
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ["ignore", errLog, errLog],
    env: {
      ...cleanEnv,
      BG_BROWSE_SOCKET: socketPath,
      BG_BROWSE_ENDPOINT: endpoint,
      ...(idleMs ? { BG_BROWSE_IDLE_MS: String(idleMs) } : {}),
    },
  });
  child.unref();
  closeSync(errLog);

  for (let i = 0; i < CONNECT_RETRIES; i++) {
    if (await isAlive(socketPath)) return socketPath;
    await delay(RETRY_DELAY_MS);
  }
  throw new Error(`browse session "${name}" did not start: ${daemonError(socketPath)}`);
}

async function isAlive(socketPath: string): Promise<boolean> {
  if (!existsSync(socketPath)) return false;
  try {
    const socket = await openSocket(socketPath);
    socket.end();
    return true;
  } catch {
    rmSync(socketPath, { force: true });
    return false;
  }
}

function daemonError(socketPath: string): string {
  try {
    const log = readFileSync(`${socketPath}.log`, "utf8").trim().split("\n").at(-1);
    if (log) return log;
  } catch {
    /* no log written */
  }
  return "check that the endpoint is reachable";
}

function openSocket(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
