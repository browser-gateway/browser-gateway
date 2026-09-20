import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Confirms a path is the docs repo working tree before the generator writes into
 * it. Throws with a remediation message when it is not, so a run from a git
 * worktree creates no stray sibling tree.
 */
export function assertDocsRepo(docsRepoRoot: string): void {
  const problems: string[] = [];
  if (!existsSync(docsRepoRoot)) {
    problems.push("the directory does not exist");
  } else {
    if (!existsSync(resolve(docsRepoRoot, "content/docs"))) {
      problems.push("it has no content/docs directory");
    }
    const manifest = resolve(docsRepoRoot, "package.json");
    if (!existsSync(manifest)) {
      problems.push("it has no package.json");
    } else {
      let name: unknown;
      try {
        name = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name;
      } catch {
        problems.push("its package.json is not valid JSON");
      }
      if (problems.length === 0 && (typeof name !== "string" || !name.includes("docs"))) {
        problems.push(`its package.json name is ${JSON.stringify(name)}, which does not look like the docs project`);
      }
    }
  }
  if (problems.length === 0) return;

  throw new Error(
    [
      `Refusing to write REST docs: ${docsRepoRoot} does not look like the docs repo.`,
      ...problems.map((p) => `  - ${p}`),
      "",
      "The target is resolved as ../docs relative to this repo, so this script must run",
      "from the checkout that sits next to the docs repo. Running it from a git worktree",
      "resolves somewhere else and would create a stray directory.",
    ].join("\n"),
  );
}
