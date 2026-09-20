import { appendFileSync } from "node:fs";
import { startBrowseDaemon } from "./daemon.js";

const socketPath = process.env.BG_BROWSE_SOCKET;
const endpoint = process.env.BG_BROWSE_ENDPOINT;
if (!socketPath || !endpoint) process.exit(1);

const idleMs = process.env.BG_BROWSE_IDLE_MS ? Number(process.env.BG_BROWSE_IDLE_MS) : undefined;

startBrowseDaemon({ socketPath, endpoint, idleMs }).catch((err: unknown) => {
  try {
    appendFileSync(`${socketPath}.log`, `${new Date().toISOString()} ${String(err)}\n`);
  } catch {
    /* nothing more we can do */
  }
  process.exit(1);
});
