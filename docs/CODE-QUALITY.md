# Code quality gates

Seven layers of defense before code ships. Designed to catch the classes of bugs that unit/integration/E2E tests don't catch — duplication, dead code, accidental API breaks, missing test coverage, stale documentation.

All gates run **locally** before commit (or pre-push for Stryker). We do not rely on CI to catch these — by the time CI runs, the commit already exists and the muscle memory of "fix it later" has kicked in.

## At a glance

| # | Layer | Tool | When | Catches |
|---|-------|------|------|---------|
| 1 | Token-level duplication | jscpd | pre-commit | Copy-paste blocks ≥50 tokens |
| 2 | Dead code | knip | pre-commit | Unused deps, unused exports, unresolved imports |
| 3 | Helper inventory | gen-helper-catalog.ts | pre-commit | Stale `docs/HELPER-CATALOG.md` (AI context drift) |
| 1.5 | Function-level duplication | eslint + sonarjs | pre-commit | Identical function bodies, duplicate branches |
| 4 | Public API surface | @microsoft/api-extractor | pre-commit | Unintentional changes to exported TS API |
| 6 | Hook orchestration | husky | always | Wires gates to git lifecycle |
| 7 | REST response shapes | vitest inline snapshots | pre-commit | Shape drift in `/v1/*` endpoints |
| 5 | Mutation testing | @stryker-mutator/core | pre-push | Tests that pass trivially without catching bugs |

---

## Layer 1 — jscpd (token-level duplicate detection)

**Config:** `.jscpd.json` at repo root.

**Current baseline:** 3.08% duplicated lines, 19 clones. Most are in `src/server/rest/{content,scrape,screenshot}.ts` — REST endpoint error-handling boilerplate. Real tech debt to address by extracting a shared helper.

**Threshold:** 3.1% (just above baseline). Any new duplication that pushes past this fails the gate.

**Ratchet rule:** When duplication drops (e.g. after refactor), lower the threshold to the new baseline. Never raise it.

**Run:** `npm run lint:dup`

**Tested gate:** PASS baseline, FAIL when intentional duplicate is added past threshold.

## Layer 2 — knip (dead code)

**Config:** `knip.json` at repo root.

**Catches:**
- Unused dependencies (real waste in `node_modules`)
- Unused exports (typically left behind after refactor)
- Unused files
- Unresolved imports
- Missing dependencies

**Rule severity:**
- `dependencies` / `unlisted` / `binaries` / `unresolved` / `duplicates` / `files` → **error** (fails the gate)
- `exports` / `types` (and namespace versions) → **warn** (advisory; often public API for downstream users)

**Run:** `npm run lint:dead`

**Tested gate:** PASS baseline, FAIL when an unused dep is added.

## Layer 1.5 — ESLint + sonarjs

**Config:** `eslint.config.js` at repo root.

**Critical rules enabled:**
- `sonarjs/no-identical-functions` — identical function bodies in different places
- `sonarjs/no-duplicated-branches` — same code in if/else branches
- `sonarjs/no-identical-conditions` — repeated conditions in chained ifs
- `sonarjs/no-identical-expressions` — `x === x`, `x && x`, etc.
- `@typescript-eslint/no-unused-vars` — unused imports/locals (error in src, warn in tests)

We do NOT use the full `sonarjs.configs.recommended` ruleset — it includes 50+ rules covering style, security-paranoia, and cognitive complexity that produce many false positives. The curated set above catches duplicate-logic class of bugs without noise.

**Run:** `npm run lint:eslint`

**Tested gate:** PASS baseline, FAIL when two identical functions are introduced.

## Layer 3 — Helper catalog (AI context)

**Config:** `scripts/gen-helper-catalog.ts` writes `docs/HELPER-CATALOG.md`.

**What it does:** Walks every `.ts` file in `src/` and the tier-3 test lib (`tests/profile/lib/`), extracts every export with its JSDoc and signature, emits a structured markdown catalog. 149 entries currently.

**Why it exists:** AI sessions reset. Grep is unreliable. Private knowledge of "what exists" doesn't survive context windows. This file is the durable inventory of every helper available in the codebase. Future AI sessions (and humans) read it BEFORE writing any new helper, so they don't reinvent.

**Modes:**
- `npm run catalog:gen` — write the file
- `npm run catalog:check` — fail if the file is stale vs current exports

**The pre-commit gate runs `--check`** so you can't commit a new export without also committing a regenerated catalog.

**Tested gate:** PASS baseline, FAIL when a new export is added without regenerating.

## Layer 4 — api-extractor (public API surface lockfile)

**Config:** `api-extractor.json` at repo root.

**What it does:** Generates `docs/api/browser-gateway.core.api.md` — a snapshot of every public symbol exported from `src/core/index.ts` (the npm package entry). Any change to public types, function signatures, class members, etc. produces a diff in that file.

**The pre-commit gate runs api-extractor in strict mode** (no `--local`). If the generated report doesn't match the committed `.api.md`, the build fails. To accept a deliberate API change: run `npm run api:update` and commit the diff.

**Why it matters for OSS infra:** Users of our npm package import these symbols. Any silent break (renamed method, changed signature) cascades to every downstream consumer. The lockfile makes every public-API change a deliberate, reviewable event.

**Run:** `npm run api:check` (CI), `npm run api:update` (intentional change)

**Tested gate:** PASS baseline, FAIL when a new public method is added to `Gateway`.

## Layer 5 — Stryker (mutation testing, pre-push only)

**Config:** `stryker.config.json` at repo root.

**What it does:** Stryker mutates the source code (flips operators, swaps branches, replaces constants) and re-runs the test suite. If tests still pass after a mutation, you have a gap — your test "checks" something the test would still pass without.

**Scope:** 9 pure-logic files in `src/core/` where unit tests directly cover the code. Initially:
- profile encryption: `blob.ts`, `encryption.ts`, `envelope.ts`, `kcv.ts`, `kdf.ts`, `cookie-helpers.ts`
- routing/tracking: `concurrency.ts`, `cooldown.ts`, `selector.ts`

**Thresholds:**
- High: 90% mutation score (good)
- Low: 80% (acceptable)
- **Break: 85% (gate fails below this)**

**Current overall mutation score:** **92.05%** across all 9 files (390 mutants, 359 killed, 31 survived).

| File | Score |
|---|---|
| kcv.ts | 100.00% |
| kdf.ts | 96.97% |
| concurrency.ts | 95.00% |
| blob.ts | 94.92% |
| cookie-helpers.ts | 94.64% |
| selector.ts | 91.01% |
| envelope.ts | 90.91% |
| cooldown.ts | 86.54% |
| encryption.ts | 85.37% |

**Remaining survivors** are largely equivalent mutants (different code with identical observable behavior — e.g. Node crypto `authTagLength` defaults to 16 same as our explicit constant) or require Date.now mocking (test would couple to time). Documented in the HTML report at `reports/mutation/index.html`.

**Ratchet rule:** When mutation score improves (e.g. after closing a gap), raise the break threshold to the new floor minus a small margin. Never lower it.

**`concurrency: 8`** in `stryker.config.json`: Tuned for M-series Macs with 16+GB RAM. Each test runner spawns a vitest process (~300MB peak) and parallelization is core-bound. M4 with 10–14 cores handles 8 concurrent runners comfortably (CPU ~75% utilized, well under thermal throttling). Measured speedup: 4 min 9 sec @ concurrency 4 → 1 min 55 sec @ concurrency 8 (**2.2×**). On lower-spec machines (≤8GB RAM or ≤4 cores) drop back to 4.

**Why pre-push only:** Stryker takes several minutes. Running on every commit would kill the dev loop. Pre-push runs once on the unified diff (after squash) — see CLAUDE.md rule 14.

**Run:** `npm run stryker:incremental`

**Tested gate:** PASS at 84.75%, FAIL when artificially bumping break threshold above current score.

## Layer 6 — husky (orchestration)

**Config:** `.husky/pre-commit` and `.husky/pre-push`.

**pre-commit runs:** catalog:check → lint → lint:eslint → lint:dup → lint:dead → api:check → test:run (full suite, 289+ tests)

**pre-push runs:** stryker:incremental

**Bypass:** `git commit --no-verify` exists for emergency WIPs to private branches but per CLAUDE.md rule 13 is never used for commits headed to main.

**Tested chain:** Full pre-commit chain executes in ~90 seconds and passes on a clean working tree.

## Layer 7 — REST golden tests

**Location:** `tests/integration/rest-golden.test.ts`

**What it does:** For every public `/v1/*` endpoint, captures the response **shape** (key names + value types, NOT values) as a vitest inline snapshot. Any change to the response structure fails the snapshot test, requiring the author to either explicitly regenerate or fix the bug.

**Why shape-not-value:** Snapshotting values (timestamps, ports, ids) would fail every run. Shape is what users program against — adding a new field is potentially fine but reshaping an existing field is a breaking change.

**Endpoints currently locked:**
- `GET /health`
- `GET /v1/status`
- `GET /v1/sessions`
- `GET /v1/providers`
- `GET /v1/config` (status code only)

To intentionally change a shape: `npx vitest -u tests/integration/rest-golden.test.ts` then commit the diff so the reviewer sees the change explicitly.

**Tested gate:** PASS baseline, FAIL when a field is added to `/v1/status` providers shape.

---

## How the gates compose

The 7 layers are deliberately overlapping. No single tool catches every class of bug.

- jscpd catches **lexical** duplication (same tokens)
- eslint+sonarjs catches **structural** duplication (same AST shape, different identifiers)
- knip catches the **symptom** of duplication (old version becomes unreferenced after refactor)
- api-extractor catches the **downstream consequence** of unintended public-API drift
- Stryker catches the **lying tests** that pass without actually verifying behavior
- REST golden tests catch **shape drift** in the most visible public interface (HTTP responses)
- Catalog catches the **knowledge gap** that causes new duplication in the first place

Together they create defense-in-depth that no human reviewer can match for the classes of bugs they target.

## Ratcheting

Several gates use brownfield thresholds (jscpd 3.1%, Stryker break 50%). As we refactor and improve:

1. Re-measure after the refactor (`npm run lint:dup`, `npm run stryker:incremental`)
2. Lower the threshold to the new floor
3. Commit the new config

This is the standard "ratchet" pattern — quality only goes up, never down.
