import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertDocsRepo } from "../../scripts/lib/docs-target.js";

describe("assertDocsRepo", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bg-docs-target-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(opts: { contentDocs?: boolean; name?: string | null }): string {
    const root = join(dir, "docs");
    mkdirSync(root, { recursive: true });
    if (opts.contentDocs !== false) mkdirSync(join(root, "content/docs"), { recursive: true });
    if (opts.name !== null) {
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: opts.name ?? "browser-gateway-docs" }));
    }
    return root;
  }

  it("accepts the docs repo working tree", () => {
    expect(() => assertDocsRepo(seed({}))).not.toThrow();
  });

  it("rejects a path that does not exist", () => {
    expect(() => assertDocsRepo(resolve(dir, "nope"))).toThrow(/does not exist/);
  });

  it("rejects a directory with no content/docs", () => {
    expect(() => assertDocsRepo(seed({ contentDocs: false }))).toThrow(/no content\/docs directory/);
  });

  it("rejects a directory with no package.json", () => {
    expect(() => assertDocsRepo(seed({ name: null }))).toThrow(/no package\.json/);
  });

  it("rejects a package.json whose name is not the docs project", () => {
    expect(() => assertDocsRepo(seed({ name: "some-other-thing" }))).toThrow(/does not look like the docs project/);
  });

  it("names the offending path and the worktree cause", () => {
    const missing = resolve(dir, "nope");
    expect(() => assertDocsRepo(missing)).toThrow(new RegExp(`Refusing to write REST docs: ${missing}`));
    expect(() => assertDocsRepo(missing)).toThrow(/git worktree/);
  });
});
