#!/usr/bin/env tsx
/**
 * Parse stryker-incremental.json to produce a compact summary of surviving
 * mutants, grouped by file. Helps prioritize which test gaps to close first.
 *
 * Run after `npm run stryker` to see what survived.
 */
import { readFileSync } from "node:fs";

interface MutantResult {
  id: string;
  mutatorName: string;
  status: "Killed" | "Survived" | "Timeout" | "NoCoverage" | "RuntimeError" | "CompileError";
  location: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  replacement?: string;
}

interface FileResult {
  source: string;
  mutants: MutantResult[];
}

interface MutationReport {
  files: Record<string, FileResult>;
}

function main() {
  const path = process.argv[2] ?? "reports/mutation/mutation.json";
  const data = JSON.parse(readFileSync(path, "utf-8")) as MutationReport;

  let total = 0;
  let killed = 0;
  let survived = 0;
  let timeout = 0;
  let noCov = 0;

  const perFile: Array<{
    file: string;
    total: number;
    killed: number;
    survived: MutantResult[];
    score: number;
  }> = [];

  for (const [path, fileResult] of Object.entries(data.files)) {
    const f = { file: path, total: 0, killed: 0, survived: [] as MutantResult[], score: 0 };
    for (const m of fileResult.mutants) {
      f.total++;
      total++;
      if (m.status === "Killed") { f.killed++; killed++; }
      else if (m.status === "Survived") { f.survived.push(m); survived++; }
      else if (m.status === "Timeout") { timeout++; f.killed++; } // timeout counts as killed
      else if (m.status === "NoCoverage") { noCov++; }
    }
    f.score = f.total > 0 ? (f.killed / (f.total - noCov)) * 100 : 100;
    perFile.push(f);
  }

  console.log("\n=== Mutation Test Summary ===\n");
  console.log(`Total mutants: ${total}`);
  console.log(`  Killed:     ${killed} (${((killed / total) * 100).toFixed(1)}%)`);
  console.log(`  Survived:   ${survived} (${((survived / total) * 100).toFixed(1)}%)`);
  console.log(`  Timeout:    ${timeout}`);
  console.log(`  NoCoverage: ${noCov}`);
  console.log("");

  for (const f of perFile.sort((a, b) => a.score - b.score)) {
    if (f.survived.length === 0) continue;
    console.log(`\n${f.file} — score ${f.score.toFixed(1)}% (${f.killed}/${f.total - perFile.find(x => x.file === f.file)?.survived.length! + f.killed} killed, ${f.survived.length} survived)`);
    for (const m of f.survived) {
      console.log(`  L${m.location.start.line}:${m.location.start.column}  ${m.mutatorName}${m.replacement ? `  →  ${m.replacement.slice(0, 80).replace(/\n/g, "\\n")}` : ""}`);
    }
  }
}

main();
