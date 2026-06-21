#!/usr/bin/env tsx
/**
 * Auto-generate docs/HELPER-CATALOG.md by walking exports in src/ and the
 * tier-3 test lib at ../tests/profile/lib.
 *
 * Why: AI agents (and humans) repeatedly reinvent helpers because grep is
 * unreliable and CLAUDE.md only carries policy, not inventory. This catalog
 * is the single source of truth for "what already exists" — read it before
 * writing any new helper.
 *
 * Modes:
 *   gen-helper-catalog.ts          → write the file
 *   gen-helper-catalog.ts --check  → fail if the file is stale (CI / pre-commit gate)
 */
import { Node, Project, SyntaxKind, type SourceFile, type JSDocableNode } from "ts-morph";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const PROJECT_ROOT = resolve(REPO_ROOT, "..");
const OUTPUT = resolve(REPO_ROOT, "docs/HELPER-CATALOG.md");

interface ScopeSpec {
  scope: string;
  globs: string[];
  cwd: string;
}

const SCOPES: ScopeSpec[] = [
  {
    scope: "Core engine (src/core/)",
    globs: ["src/core/**/*.ts"],
    cwd: REPO_ROOT,
  },
  {
    scope: "Server layer (src/server/)",
    globs: ["src/server/**/*.ts"],
    cwd: REPO_ROOT,
  },
  {
    scope: "Tier-3 test toolkit (tests/profile/lib/) — NOT in repo, project-root tests/",
    globs: ["tests/profile/lib/**/*.ts"],
    cwd: PROJECT_ROOT,
  },
];

interface Entry {
  name: string;
  kind: string;
  signature: string;
  description: string;
  file: string;
  line: number;
}

interface ScopedEntries {
  scope: string;
  entries: Entry[];
}

function extractDescription(node: JSDocableNode): string {
  const jsDocs = node.getJsDocs();
  if (jsDocs.length === 0) return "";
  const text = jsDocs[0]!.getDescription().trim();
  // First non-empty line, single-line normalize
  const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return firstLine.trim();
}

function summarizeSignature(node: Node): string {
  const kind = node.getKind();
  if (kind === SyntaxKind.FunctionDeclaration) {
    const fn = node.asKindOrThrow(SyntaxKind.FunctionDeclaration);
    const name = fn.getName() ?? "<anonymous>";
    const params = fn.getParameters().map((p) => p.getText()).join(", ");
    const ret = fn.getReturnTypeNode()?.getText() ?? "unknown";
    return `${name}(${params}) → ${ret}`;
  }
  if (kind === SyntaxKind.ClassDeclaration) {
    const cls = node.asKindOrThrow(SyntaxKind.ClassDeclaration);
    return `class ${cls.getName() ?? "<anonymous>"}`;
  }
  if (kind === SyntaxKind.InterfaceDeclaration) {
    const iface = node.asKindOrThrow(SyntaxKind.InterfaceDeclaration);
    return `interface ${iface.getName()}`;
  }
  if (kind === SyntaxKind.TypeAliasDeclaration) {
    const ta = node.asKindOrThrow(SyntaxKind.TypeAliasDeclaration);
    return `type ${ta.getName()}`;
  }
  if (kind === SyntaxKind.VariableStatement) {
    const vs = node.asKindOrThrow(SyntaxKind.VariableStatement);
    const decls = vs.getDeclarationList().getDeclarations();
    if (decls.length === 0) return "<unknown var>";
    const d = decls[0]!;
    const explicit = d.getTypeNode()?.getText();
    if (explicit) return `const ${d.getName()}: ${explicit}`;
    // No explicit annotation. Try to infer the function signature if it's an arrow.
    const init = d.getInitializer();
    if (init?.getKind() === SyntaxKind.ArrowFunction) {
      const arrow = init.asKindOrThrow(SyntaxKind.ArrowFunction);
      const params = arrow.getParameters().map((p) => p.getText()).join(", ");
      const ret = arrow.getReturnTypeNode()?.getText() ?? "unknown";
      return `${d.getName()}(${params}) → ${ret}`;
    }
    // Fall back to showing just the name — inferred types are usually too verbose.
    return `const ${d.getName()}`;
  }
  return node.getText().split("\n")[0]!.trim();
}

function kindLabel(node: Node): string {
  switch (node.getKind()) {
    case SyntaxKind.FunctionDeclaration: return "fn";
    case SyntaxKind.ClassDeclaration: return "class";
    case SyntaxKind.InterfaceDeclaration: return "interface";
    case SyntaxKind.TypeAliasDeclaration: return "type";
    case SyntaxKind.VariableStatement: return "const";
    default: return "export";
  }
}

function walkSourceFile(sourceFile: SourceFile, cwd: string): Entry[] {
  const out: Entry[] = [];
  const exportedNames = new Set(sourceFile.getExportedDeclarations().keys());

  for (const stmt of sourceFile.getStatements()) {
    if (!Node.isExportable(stmt)) continue;
    if (!stmt.isExported() && !stmt.hasExportKeyword?.()) {
      // re-exports without modifier — handled via getExportedDeclarations
      continue;
    }
    let name: string | undefined;
    const kind = stmt.getKind();
    if (kind === SyntaxKind.FunctionDeclaration) name = stmt.asKindOrThrow(SyntaxKind.FunctionDeclaration).getName();
    else if (kind === SyntaxKind.ClassDeclaration) name = stmt.asKindOrThrow(SyntaxKind.ClassDeclaration).getName();
    else if (kind === SyntaxKind.InterfaceDeclaration) name = stmt.asKindOrThrow(SyntaxKind.InterfaceDeclaration).getName();
    else if (kind === SyntaxKind.TypeAliasDeclaration) name = stmt.asKindOrThrow(SyntaxKind.TypeAliasDeclaration).getName();
    else if (kind === SyntaxKind.VariableStatement) {
      const vs = stmt.asKindOrThrow(SyntaxKind.VariableStatement);
      const decls = vs.getDeclarationList().getDeclarations();
      name = decls[0]?.getName();
    }
    if (!name) continue;
    if (!exportedNames.has(name) && !stmt.hasExportKeyword?.()) continue;

    const jsDocable = stmt as unknown as JSDocableNode;
    const description = typeof jsDocable.getJsDocs === "function" ? extractDescription(jsDocable) : "";

    out.push({
      name,
      kind: kindLabel(stmt),
      signature: summarizeSignature(stmt),
      description,
      file: relative(cwd, sourceFile.getFilePath()),
      line: stmt.getStartLineNumber(),
    });
  }

  return out;
}

function collectScope(spec: ScopeSpec): ScopedEntries {
  const project = new Project({
    skipFileDependencyResolution: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: false, declaration: false, noEmit: true },
  });
  for (const g of spec.globs) {
    project.addSourceFilesAtPaths(resolve(spec.cwd, g));
  }
  const all: Entry[] = [];
  for (const sf of project.getSourceFiles()) {
    if (sf.getFilePath().endsWith(".test.ts")) continue;
    if (sf.getFilePath().endsWith(".bench.ts")) continue;
    if (sf.getFilePath().endsWith(".d.ts")) continue;
    if (sf.getFilePath().endsWith("/index.ts")) continue; // skip barrels
    all.push(...walkSourceFile(sf, spec.cwd));
  }
  all.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
  return { scope: spec.scope, entries: all };
}

function renderCatalog(scoped: ScopedEntries[]): string {
  const now = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push("<!--");
  lines.push("  AUTO-GENERATED by scripts/gen-helper-catalog.ts.");
  lines.push("  Do NOT edit by hand. Re-run: npm run catalog:gen");
  lines.push("-->");
  lines.push("");
  lines.push("# Helper catalog");
  lines.push("");
  lines.push(`Generated: ${now}`);
  lines.push("");
  lines.push("**Read this BEFORE writing any new helper function.** If something similar exists, modify or compose with it. If you truly need a new one, add it to the appropriate file and re-run `npm run catalog:gen`.");
  lines.push("");
  lines.push("Why: AI sessions reset; grep is unreliable; private knowledge of \"what exists\" doesn't survive context windows. This file is the durable inventory.");
  lines.push("");

  for (const { scope, entries } of scoped) {
    lines.push(`## ${scope}`);
    lines.push("");
    if (entries.length === 0) {
      lines.push("_(no exports detected)_");
      lines.push("");
      continue;
    }

    let currentFile = "";
    for (const e of entries) {
      if (e.file !== currentFile) {
        currentFile = e.file;
        lines.push(`### \`${currentFile}\``);
        lines.push("");
      }
      const desc = e.description ? ` — ${e.description}` : "";
      lines.push(`- **${e.kind}** \`${e.signature}\` (line ${e.line})${desc}`);
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function main(): void {
  const scoped = SCOPES.map(collectScope);
  const next = renderCatalog(scoped);

  const checkMode = process.argv.includes("--check");

  if (checkMode) {
    if (!existsSync(OUTPUT)) {
      console.error(`✖ ${OUTPUT} missing — run: npm run catalog:gen`);
      process.exit(1);
    }
    const current = readFileSync(OUTPUT, "utf-8");
    // Strip the generated date so format-only diffs don't trip the gate.
    const stripDate = (s: string): string => s.replace(/^Generated: \d{4}-\d{2}-\d{2}$/m, "Generated: <stripped>");
    if (hash(stripDate(current)) !== hash(stripDate(next))) {
      console.error(`✖ ${OUTPUT} is stale — exports changed but catalog wasn't regenerated.`);
      console.error(`  Run: npm run catalog:gen, then commit the diff.`);
      process.exit(1);
    }
    console.log(`✓ ${OUTPUT} is current.`);
    return;
  }

  writeFileSync(OUTPUT, next);
  console.log(`✓ wrote ${OUTPUT}`);
  console.log(`  scopes: ${scoped.length}, total entries: ${scoped.reduce((s, x) => s + x.entries.length, 0)}`);
}

main();
