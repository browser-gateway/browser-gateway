import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";

const PAGE = `<!doctype html><html><head><title>Webhooks</title></head><body><article><h1>Webhooks</h1><p>A <strong>webhook</strong> sends an <a href="/http">HTTP request</a> when an event happens.</p><ul><li>One</li><li>Two</li></ul><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table></article></body></html>`;
const SRC = join(import.meta.dirname, "../../src/rest-schemas");

type Helpers = typeof import("../../src/rest-schemas/helpers.js");

let dir: string;
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

async function workersBundle(name: string, preload: boolean): Promise<Helpers & { windowSeenAfterStartup: boolean }> {
  const entry = join(dir, `${name}.ts`);
  writeFileSync(
    entry,
    [
      preload ? `import ${JSON.stringify(join(SRC, "workers/index.ts"))};` : "",
      `export const windowSeenAfterStartup = typeof (globalThis as { window?: unknown }).window !== "undefined";`,
      `export * from ${JSON.stringify(join(SRC, "helpers.ts"))};`,
    ].join("\n"),
  );
  const out = join(dir, `${name}.mjs`);
  const bundled = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["node:*"],
    mainFields: ["browser", "module", "main"],
    conditions: ["workerd", "worker", "browser"],
    logLevel: "silent",
  });
  writeFileSync(out, bundled.outputFiles[0]!.text);
  return (await import(pathToFileURL(out).href)) as Helpers & { windowSeenAfterStartup: boolean };
}

const toMarkdown = (h: Helpers) => h.extractFormats(PAGE, "https://example.org/page", async () => "", ["markdown"]);
const setNavigator = (value: unknown) => Object.defineProperty(globalThis, "navigator", { value, configurable: true });
const workersOnlyGlobal = globalThis as { WebSocketPair?: unknown };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bg-workers-md-"));
  setNavigator({ userAgent: "Cloudflare-Workers" });
});

afterAll(() => {
  if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
  rmSync(dir, { recursive: true, force: true });
});

describe("markdown in a Workers bundle", () => {
  it("converts pages for concurrent first requests once the Workers entry is imported, and leaves no window behind", async () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe("undefined");
    const helpers = await workersBundle("with-preload", true);
    expect(helpers.windowSeenAfterStartup).toBe(false);
    const runs = await Promise.all([toMarkdown(helpers), toMarkdown(helpers), toMarkdown(helpers)]);
    for (const { content, metadata } of runs) {
      expect(content.markdown).not.toContain("Partial conversion");
      expect(content.markdown).toContain("A **webhook** sends an [HTTP request](https://example.org/http)");
      expect(content.markdown).toContain("| A | B |");
      expect(content.markdown).toContain("- One");
      expect(metadata?.title).toBe("Webhooks");
    }
    expect(typeof (globalThis as { window?: unknown }).window).toBe("undefined");
  });

  it("fails without the Workers entry, which is why Workers must import it", async () => {
    const helpers = await workersBundle("without-preload", false);
    const { content } = await toMarkdown(helpers);
    expect(content.markdown).toContain("Partial conversion");
  });

  it("converts pages in a Worker that turned off the navigator global", async () => {
    setNavigator(undefined);
    workersOnlyGlobal.WebSocketPair = function WebSocketPair() {};
    try {
      const helpers = await workersBundle("no-navigator", true);
      expect(helpers.windowSeenAfterStartup).toBe(false);
      const { content } = await toMarkdown(helpers);
      expect(content.markdown).not.toContain("Partial conversion");
      expect(content.markdown).toContain("A **webhook** sends an [HTTP request](https://example.org/http)");
      expect(typeof (globalThis as { window?: unknown }).window).toBe("undefined");
    } finally {
      delete workersOnlyGlobal.WebSocketPair;
      setNavigator({ userAgent: "Cloudflare-Workers" });
    }
  });

  it("leaves other runtimes untouched when the entry is imported outside Workers", async () => {
    setNavigator({ userAgent: "Node.js/22" });
    try {
      const helpers = await workersBundle("not-workers", true);
      const { content } = await toMarkdown(helpers);
      expect(content.markdown).toContain("Partial conversion");
      expect(typeof (globalThis as { window?: unknown }).window).toBe("undefined");
    } finally {
      setNavigator({ userAgent: "Cloudflare-Workers" });
    }
  });

  it("converts pages when an earlier module already set window to the global object", async () => {
    const global = globalThis as { window?: unknown; DOMParser?: unknown };
    global.window = globalThis;
    try {
      const helpers = await workersBundle("window-polyfill", true);
      const { content } = await toMarkdown(helpers);
      expect(content.markdown).not.toContain("Partial conversion");
      expect(content.markdown).toContain("A **webhook** sends an [HTTP request](https://example.org/http)");
      expect(global.window).toBe(globalThis);
      expect(global.DOMParser).toBeUndefined();
    } finally {
      delete global.window;
    }
  });
});
