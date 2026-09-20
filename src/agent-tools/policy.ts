import type { ActionStep } from "./actions.js";

export interface SessionPolicyOptions {
  idleMs?: number;
  hardCapMs?: number;
  keepaliveMs?: number;
  loopGuardRepeats?: number;
  now?: () => number;
  onKeepalive?: () => void | Promise<void>;
  onExpire?: (reason: "idle" | "hard-cap") => void | Promise<void>;
}

export interface SessionState {
  idleTimeoutS: number;
  expiresAtMs: number;
  hardCapAtMs: number;
  secondsUntilIdleClose: number;
}

export const IDLE_DEFAULT_MS = 300_000;
export const IDLE_MIN_MS = 60_000;
export const IDLE_MAX_MS = 1_800_000;
export const HARD_CAP_DEFAULT_MS = 4 * 60 * 60 * 1_000;
/** Must stay under the ~126 s cutoff measured on the routed path. */
export const KEEPALIVE_DEFAULT_MS = 45_000;
const EXPIRY_WARNING_MS = 60_000;

export class LoopGuardError extends Error {
  constructor(readonly repeats: number) {
    super(
      `the same action failed ${repeats} times in a row. Take a fresh snapshot, read the page, or try a different approach.`,
    );
    this.name = "LoopGuardError";
  }
}

/** Idle clock, keepalive clock, hard cap and loop guard for one agent session.
 *  Keepalive traffic never counts as agent activity, so an abandoned session
 *  still closes on the idle clock. */
export class SessionPolicy {
  readonly idleMs: number;
  readonly hardCapMs: number;
  readonly keepaliveMs: number;
  private readonly loopGuardRepeats: number;
  private readonly now: () => number;
  private readonly startedAtMs: number;
  private lastActivityMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastFailure: { signature: string; count: number } = { signature: "", count: 0 };
  private stopped = false;

  constructor(private readonly opts: SessionPolicyOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.idleMs = clamp(opts.idleMs ?? IDLE_DEFAULT_MS, IDLE_MIN_MS, IDLE_MAX_MS);
    this.hardCapMs = opts.hardCapMs ?? HARD_CAP_DEFAULT_MS;
    this.keepaliveMs = Math.min(opts.keepaliveMs ?? KEEPALIVE_DEFAULT_MS, KEEPALIVE_DEFAULT_MS);
    this.loopGuardRepeats = opts.loopGuardRepeats ?? 3;
    this.startedAtMs = this.now();
    this.lastActivityMs = this.startedAtMs;
  }

  start(intervalMs = 5_000): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    if (typeof this.timer === "object" && "unref" in this.timer) (this.timer as { unref: () => void }).unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Marks real agent activity. Keepalive must never call this. */
  touch(): void {
    this.lastActivityMs = this.now();
  }

  state(): SessionState {
    const expiresAtMs = this.lastActivityMs + this.idleMs;
    return {
      idleTimeoutS: Math.round(this.idleMs / 1000),
      expiresAtMs,
      hardCapAtMs: this.startedAtMs + this.hardCapMs,
      secondsUntilIdleClose: Math.max(0, Math.round((expiresAtMs - this.now()) / 1000)),
    };
  }

  /** One-line nudge when a session is close to its idle close or hard cap. */
  warning(): string | undefined {
    const state = this.state();
    const untilCap = state.hardCapAtMs - this.now();
    if (untilCap <= EXPIRY_WARNING_MS) {
      return `this session hits its ${Math.round(this.hardCapMs / 3_600_000)}h limit in ${Math.max(0, Math.round(untilCap / 1000))}s. Finish up or open a fresh session.`;
    }
    if (state.secondsUntilIdleClose * 1000 <= EXPIRY_WARNING_MS) {
      return `this browser closes in ${state.secondsUntilIdleClose}s without another action. Act now or close it yourself when done.`;
    }
    return undefined;
  }

  /** Throws {@link LoopGuardError} when the same step fails repeatedly. */
  recordFailure(step: ActionStep, error: string): void {
    const signature = `${step.type}:${step.ref ?? ""}:${step.text ?? ""}:${step.key ?? ""}:${error}`;
    this.lastFailure =
      this.lastFailure.signature === signature
        ? { signature, count: this.lastFailure.count + 1 }
        : { signature, count: 1 };
    if (this.lastFailure.count >= this.loopGuardRepeats) {
      this.lastFailure = { signature: "", count: 0 };
      throw new LoopGuardError(this.loopGuardRepeats);
    }
  }

  recordSuccess(): void {
    this.lastFailure = { signature: "", count: 0 };
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    if (now - this.startedAtMs >= this.hardCapMs) {
      this.stop();
      await this.opts.onExpire?.("hard-cap");
      return;
    }
    if (now - this.lastActivityMs >= this.idleMs) {
      this.stop();
      await this.opts.onExpire?.("idle");
      return;
    }
    await this.opts.onKeepalive?.();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
