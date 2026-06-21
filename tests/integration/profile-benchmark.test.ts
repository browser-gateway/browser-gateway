/**
 * Phase 2 latency benchmark — measures capture and inject overhead at varying
 * state sizes. Per CLAUDE.md rule #11, infra-grade work ships with numbers,
 * not estimates.
 *
 * Plan gates (from planning/research/v0.3.0-PROFILE-AT-ROUTER-PLAN.md §7):
 *   - capture overhead p95 < 500ms on typical session (5-10 origins)
 *   - inject overhead p95 < 800ms on typical session
 *
 * Run with: npx vitest run tests/integration/profile-benchmark.test.ts
 * Skips when no local Chrome is installed (CI without Chrome).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureState } from "../../src/core/profile/capture.js";
import { injectState } from "../../src/core/profile/inject.js";
import { findChromePath, launchChrome, type LaunchedChrome } from "./profile-fixtures/chrome.js";
import { startTestServer, type TestServer } from "./profile-fixtures/test-server.js";

const HAS_CHROME = findChromePath() !== null;
const describeIfChrome = HAS_CHROME ? describe : describe.skip;

interface LatencyStats {
  count: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
}

function stats(samples: number[]): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((s, x) => s + x, 0);
  return {
    count: sorted.length,
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
    meanMs: sum / sorted.length,
    p50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95Ms: sorted[Math.max(0, Math.floor(sorted.length * 0.95) - 1)] ?? 0,
  };
}

function format(label: string, s: LatencyStats): string {
  return `${label.padEnd(48)} n=${s.count}  min=${s.minMs.toFixed(0)}ms  p50=${s.p50Ms.toFixed(0)}ms  p95=${s.p95Ms.toFixed(0)}ms  max=${s.maxMs.toFixed(0)}ms  mean=${s.meanMs.toFixed(0)}ms`;
}

describeIfChrome("benchmark: capture + inject overhead", () => {
  let server: TestServer;
  let source: LaunchedChrome;
  let target: LaunchedChrome;

  beforeAll(async () => {
    server = await startTestServer();
    source = await launchChrome();
    target = await launchChrome();
    await source.page.goto(`${server.url}/login?u=alice`, { waitUntil: "load" });
  }, 60_000);

  afterAll(async () => {
    await source?.close();
    await target?.close();
    await server?.close();
  });

  it("captures 1 origin × 10 runs — reports stats", async () => {
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = Date.now();
      await captureState(source.cdp, { origins: [server.url] });
      samples.push(Date.now() - t0);
    }
    const s = stats(samples);
    console.log(format("capture(1 origin)", s));
    expect(s.p95Ms).toBeLessThan(2000);
  }, 60_000);

  it("captures 5 origins × 10 runs (4 unreachable, 1 real) — reports stats", async () => {
    // Most real-world profiles have multiple origins; here we test the worst
    // case where many of them are unreachable and we must skip them.
    const origins = [
      "https://nonexistent-1.invalid",
      "https://nonexistent-2.invalid",
      "https://nonexistent-3.invalid",
      "https://nonexistent-4.invalid",
      server.url,
    ];
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = Date.now();
      await captureState(source.cdp, { origins, navigationTimeoutMs: 1500 });
      samples.push(Date.now() - t0);
    }
    const s = stats(samples);
    console.log(format("capture(5 origins, 4 unreachable, 1.5s nav timeout)", s));
  }, 120_000);

  it("injects cookies + 1 origin storage × 10 runs — reports stats", async () => {
    const captured = await captureState(source.cdp, { origins: [server.url] });
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      // Each iteration uses a fresh target browser to measure cold inject cost
      const fresh = await launchChrome();
      try {
        const t0 = Date.now();
        await injectState(fresh.cdp, captured);
        samples.push(Date.now() - t0);
      } finally {
        await fresh.close();
      }
    }
    const s = stats(samples);
    console.log(format("inject(1 origin, fresh browser)", s));
  }, 300_000);

  it("inject overhead vs cold session — comparison reference", async () => {
    // For comparison: how long does a 'no profile' Chrome launch + navigate take?
    const cold: number[] = [];
    for (let i = 0; i < 5; i++) {
      const fresh = await launchChrome();
      try {
        const t0 = Date.now();
        await fresh.page.goto(server.url, { waitUntil: "load" });
        cold.push(Date.now() - t0);
      } finally {
        await fresh.close();
      }
    }
    console.log(format("baseline navigate (no profile)", stats(cold)));
  }, 120_000);
});
