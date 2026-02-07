# Progress Log

---

## Task: Initialize project scaffolding with Bun, TypeScript strict mode, and directory structure

### Completed

- Ran `bun init` to scaffold the project with TypeScript support
- Configured `tsconfig.json` with strict mode, ES2022 target, bundler moduleResolution, and `@/` -> `src/` path aliases
- Created the full directory structure: `src/`, `src/runner/mcp_configs/`, `src/tests/`, `src/judge/`, `src/loader/`, `src/types/`, `tasks/bleeding_edge/`, `tasks/version_locked_write/`, `tasks/version_locked_audit/`, `results/`, `reference/`, `typecheck-envs/`
- Installed core dependencies: `ts-morph@27.0.2`, `zod@4.3.6`, `openai@6.18.0`
- Installed and configured Biome v2.3.14 for linting and formatting (`biome.json`)
- Added package.json scripts: `bench`, `typecheck`, `test`, `lint`, `format`
- Created `src/index.ts` entry point that logs 'nia-bench' and exits with code 0
- Created `.env.example` with `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`
- Verified: `bun run typecheck` passes, `bun run lint` passes, `bun run bench` prints 'nia-bench' with exit code 0, `bun test` reports 0 tests with no errors

### Files Changed

- `package.json` — project config with dependencies and scripts
- `tsconfig.json` — TypeScript strict mode, ES2022, path aliases
- `biome.json` — Biome v2.x linter/formatter config
- `src/index.ts` — CLI entry point placeholder
- `.env.example` — environment variable template
- `.gitignore` — updated to exclude results and typecheck-env artifacts
- Various `.gitkeep` files for empty directory preservation

### Decisions

- Used Biome v2.3.14 (latest) which has a different config schema from v1.x — `organizeImports` is removed, `files.ignore` is now `files.includes`, schema URL must match installed version
- Set `files.includes` in biome.json to scope linting to `src/**/*.ts`, `src/**/*.tsx`, and `*.json` files only
- Used ES2022 target per SPEC.md (not ESNext which was the bun init default)
- Zod v4.3.6 was installed (latest) — note this is Zod v4 not v3, which is fine since it's used for internal schema validation only

### Notes for Future Agent

- The CLI entry point at `src/index.ts` currently just logs 'nia-bench' — it will be expanded into a full CLI with arg parsing in task 11
- Biome v2.x has a significantly different config format from v1.x — do NOT copy v1.x config examples
- `bun test` expects test files matching `**{.test,.spec,_test_,_spec_}.{js,ts,jsx,tsx}` pattern
- Path alias `@/` maps to `src/` — use it for clean imports in later tasks
- Zod v4 was installed as a project dependency for internal schema validation — this is separate from the Zod v3/v4 being tested in benchmark tasks (those go in typecheck-envs)

---

## Task: Define task JSON schema with Zod and create the task loader module

### Completed

- Created `src/types/task.ts` with comprehensive Zod schemas for the task JSON format
- Defined `TaskSchema` with all fields: `id`, `category` (enum), `library` (enum), `target_version`, `prompt`, `context` (optional), `reference_solution`, `test_spec`, `rubric`, `common_hallucinations`
- Defined `AstCheckSchema` as a discriminated union with 16 AST check types: `import_exists`, `import_absent`, `module_import_absent`, `function_exported`, `function_absent`, `await_present`, `await_absent`, `call_exists`, `call_absent`, `directive_present`, `property_location`, `async_function`, `async_generator`, `yield_present`, `type_annotation`, `property_absent`
- Each AST check type has specific parameters (e.g., `import_exists` requires `name` and `from`, `property_location` requires `property` and `insideCall`)
- All AST check types support an optional `file` field for multi-file tasks
- Exported inferred TypeScript types: `Task`, `AstCheck`, `RubricCriterion`, `TestSpec`, `Rubric`, `TaskContext`, `Category`, `Library`
- Created `src/loader/task-loader.ts` with `loadTasks()` function that reads all JSON files from `tasks/` subdirectories, validates against Zod schema, and returns typed `Task[]`
- Added filtering support: filter by `category`, `library`, or `id`
- Added error reporting: if a task JSON fails validation, the file path and Zod error details are logged, and the task is skipped (doesn't crash)
- Created `src/loader/index.ts` re-exporting the loader
- Wrote comprehensive test file `src/loader/__tests__/task-loader.test.ts` with 13 tests covering: valid loading, invalid JSON detection, malformed JSON handling, multi-directory loading, category/library/id filtering, non-JSON file ignoring, missing subdirectory handling, empty filter results, discriminated union validation, all 16 AST check types, and optional context field
- Verified: `bun run typecheck` passes, `bun test` (13 pass, 0 fail), `bun run lint` clean

### Files Changed

- `src/types/task.ts` — Zod schemas and TypeScript types for task JSON format
- `src/loader/task-loader.ts` — Task loader module with validation and filtering
- `src/loader/index.ts` — Re-exports for the loader module
- `src/loader/__tests__/task-loader.test.ts` — Comprehensive test suite (13 tests)

### Decisions

- Used Zod v4 `z.discriminatedUnion('type', [...])` for AST check types — this provides type-safe parsing with clear error messages when the `type` field doesn't match
- Used Zod v4 `z.record(z.string(), z.string())` for the `context.code` field (two-argument form required in Zod v4)
- Added optional `file` field to all AST check types to support multi-file tasks (e.g., tasks that produce both `page.tsx` and `default.tsx`)
- The loader reads from three hardcoded subdirectories (`bleeding_edge`, `version_locked_write`, `version_locked_audit`) matching the project structure
- Filtering happens after loading — all valid tasks are loaded first, then filtered. This means errors from non-matching tasks are still reported.
- Used `?.` optional chaining instead of `!` non-null assertions in tests to satisfy Biome lint rules

### Notes for Future Agent

- The `AstCheckSchema` discriminated union covers all 16 check types needed by the 40 benchmark tasks (based on BENCHMARK.md Section 4)
- When implementing the AST checker (task 4), each check type in the discriminated union maps to a specific ts-morph traversal pattern
- The `file` optional field on each AST check is for multi-file tasks — when absent, the check should apply to the primary/main file
- `RubricCriterion.weight` is a number between 0 and 1 (e.g., 0.25 = 25%), not a percentage integer
- `TaskContext` is optional — only version-locked tasks will have it. The `code` field maps filenames to their content, `package_json` is the raw package.json string
- The loader accepts any directory as `tasksDir` — in production this will be the project's `tasks/` directory, in tests it's a temp directory

---

## Task: Create 5 pilot task JSON files covering all three categories and multiple libraries

### Completed

- Created `tasks/bleeding_edge/nextjs-16-proxy-ts.json` — Task A-NX-1: proxy.ts middleware rename in Next.js 16. Includes 4 AST checks (function_exported proxy, function_absent middleware, call_exists config.matcher, property_absent runtime), 5 rubric criteria summing to 1.0, and 4 common hallucinations.
- Created `tasks/bleeding_edge/react-19-use-hook.json` — Task A-RX-1: use() hook in React 19. Includes 5 AST checks (import_exists use from react, call_exists use, call_exists Suspense, import_absent useEffect, import_absent useState), 5 rubric criteria summing to 1.0, and 3 common hallucinations.
- Created `tasks/version_locked_write/nextjs-13-sync-request-apis.json` — Task B1-NX-1: sync cookies/headers in Next.js 13. Includes 4 AST checks (await_absent cookies, await_absent headers, import_exists cookies from next/headers, import_exists headers from next/headers), 4 rubric criteria summing to 1.0, 2 common hallucinations, and context with package.json showing next@13.5.6.
- Created `tasks/version_locked_write/react-17-render-entry.json` — Task B1-RX-2: ReactDOM.render entry point in React 17. Includes 3 AST checks (call_exists ReactDOM.render, module_import_absent react-dom/client, import_absent createRoot), 4 rubric criteria summing to 1.0, 2 common hallucinations, and context with package.json showing react@17.0.2.
- Created `tasks/version_locked_audit/react-17-audit-v19-code.json` — Task B2-RX-1: audit React 19 code for v17 compatibility. Has 0 AST checks (audit tasks rely entirely on LLM judge), 5 rubric criteria summing to 1.0, reference_solution listing all 7 expected issues, and context with package.json.
- Validated all 5 task files load successfully using the task loader — all pass Zod schema validation, all rubric weights sum to exactly 1.00
- Created `scripts/validate-pilot-tasks.ts` validation script
- Verified: `bun run typecheck` passes, `bun run lint` passes, `bun test` (13 tests pass, 0 fail)

### Files Changed

- `tasks/bleeding_edge/nextjs-16-proxy-ts.json` — Pilot task: Next.js 16 proxy.ts
- `tasks/bleeding_edge/react-19-use-hook.json` — Pilot task: React 19 use() hook
- `tasks/version_locked_write/nextjs-13-sync-request-apis.json` — Pilot task: Next.js 13 sync APIs
- `tasks/version_locked_write/react-17-render-entry.json` — Pilot task: React 17 ReactDOM.render
- `tasks/version_locked_audit/react-17-audit-v19-code.json` — Pilot task: React 17 audit v19 code
- `scripts/validate-pilot-tasks.ts` — Validation script for pilot tasks

### Decisions

- Version-locked tasks include a `context` object with `package_json` showing the pinned library version — this simulates a real project workspace where the agent can see which version is in use
- Audit task (react-17-audit-v19-code) has `test_spec.ast_checks` as an empty array since audit tasks are evaluated entirely by the LLM judge
- The `reference_solution` for the audit task is a text description of expected issues rather than code — this matches the audit task format where the agent produces analysis, not code
- Used BENCHMARK.md Section 4 content verbatim for prompts, reference solutions, test specs, and rubrics
- AST check types map to the discriminated union defined in `src/types/task.ts` from task 2 — all check types used (`function_exported`, `function_absent`, `call_exists`, `property_absent`, `import_exists`, `import_absent`, `await_absent`, `module_import_absent`) are valid members of the union

### Notes for Future Agent

- These 5 pilot tasks span 2 libraries (Next.js, React) and all 3 categories (2 bleeding_edge, 2 version_locked_write, 1 version_locked_audit)
- When implementing the AST checker (task 4), test it against these 5 pilot tasks' reference solutions — all AST checks should PASS on the correct reference code
- The `call_exists` check with `config.matcher` in the proxy.ts task checks that a `config` object with a `matcher` property is exported — the AST checker implementation needs to handle dotted access patterns
- The `call_exists` check with `Suspense` in the use-hook task verifies JSX usage of `<Suspense>` — the AST checker needs to handle JSX element detection
- The `call_exists` check with `ReactDOM.render` needs to handle property access calls (method calls on objects)
- Version-locked write tasks have `context.package_json` — the runner will write this to the temp dir before agent execution
- The `scripts/validate-pilot-tasks.ts` script can be reused/extended when authoring remaining tasks (tasks 12-14)

---

## Task: Build the AST checker engine using ts-morph for automated test assertions

### Completed

- Created `src/tests/ast-checker.ts` with `runAstChecks(code: string, checks: AstCheck[]): AstCheckResult[]` function that parses code with ts-morph's in-memory file system and runs each check
- Implemented all 16 AST check types as defined in the discriminated union from `src/types/task.ts`:
  - `import_exists`: checks named, default, and namespace imports from a specific module
  - `import_absent`: checks that a named/default import does NOT exist (optionally scoped to a specific module)
  - `module_import_absent`: checks that NO imports exist from a specific module
  - `function_exported`: checks a named function/variable is exported (includes `export default`)
  - `function_absent`: checks a named function is NOT exported
  - `await_present`: checks a specific call IS awaited
  - `await_absent`: checks a specific call is NOT awaited
  - `call_exists`: checks for function calls, property access calls (e.g., `ReactDOM.render`), JSX elements (e.g., `<Suspense>`), and property access in exported objects (e.g., `config.matcher`)
  - `call_absent`: checks a call/JSX element does NOT exist
  - `directive_present`: checks for string directives like `'use cache'` or `'use server'`
  - `property_location`: checks a property exists inside a specific call expression's object argument
  - `async_function`: checks a function is async (supports named functions, arrow functions, and default exports)
  - `async_generator`: checks a function is both async and a generator (`async function*`)
  - `yield_present`: checks for `yield` keyword usage, optionally inside a specific function
  - `type_annotation`: checks a parameter has a specific type annotation
  - `property_absent`: checks a property does NOT exist in an object literal (optionally scoped to a specific exported object)
- Defined `AstCheckResult` type: `{check: AstCheck, passed: boolean, message: string}`
- Created `src/tests/index.ts` re-exporting the checker
- Wrote comprehensive test file `src/tests/__tests__/ast-checker.test.ts` with 76 tests covering:
  - **Positive tests**: All 5 pilot task reference solutions pass all their AST checks (4 tasks with checks + 1 audit task with empty checks)
  - **Negative tests**: 5 known-BAD code variants (middleware.ts instead of proxy.ts, proxy.ts with runtime:edge, useEffect+useState fallback instead of use(), await cookies/headers instead of sync, createRoot instead of ReactDOM.render) — all correctly detected as failures
  - **Edge cases**: Empty code string (all checks fail), empty checks array (returns empty), malformed/incomplete code (still parses), code with syntax errors (still processes checks)
  - **Individual check type tests**: 45+ individual tests for each of the 16 check types covering both pass and fail scenarios
- Verified: `bun run typecheck` passes, `bun test` (76 tests pass across 2 files, 0 fail), `bun run lint` clean

### Files Changed

- `src/tests/ast-checker.ts` — AST checker engine with all 16 check type implementations
- `src/tests/index.ts` — Re-exports for the tests module
- `src/tests/__tests__/ast-checker.test.ts` — Comprehensive test suite (76 tests)

### Decisions

- Used ts-morph's `Project` with `useInMemoryFileSystem: true` to avoid any disk I/O — all parsing happens in memory
- Created source files as `.tsx` extension to support JSX parsing for checks like `call_exists` with JSX elements (e.g., `<Suspense>`)
- `call_exists` handles 4 distinct patterns: (1) simple function calls (`use()`), (2) property access calls (`ReactDOM.render()`), (3) JSX elements (`<Suspense>`), and (4) properties in exported objects (`config.matcher`)
- `import_absent` without a `from` field checks ALL imports; with `from` it only checks the specified module — this matches how the pilot tasks use the check (some specify `from`, some don't)
- `property_absent` with `inObject` only checks the specified exported object; without it, checks ALL object literals in the file
- For `type_annotation`, whitespace is normalized for comparison to handle formatting differences
- The exhaustive switch ensures all 16 check types are handled — adding a new type to the discriminated union will cause a TypeScript compile error if not handled
- Used `Extract<AstCheck, { type: '...' }>` for type-safe parameter access in each check function

### Notes for Future Agent

- The AST checker is stateless — it receives `code: string` and `checks: AstCheck[]` and returns results. No side effects, no disk I/O.
- When building the evaluator (task 9), call `runAstChecks(code, task.test_spec.ast_checks)` for each task
- For multi-file tasks, the `file` field on each AST check indicates which file to check — the evaluator will need to handle this by parsing the appropriate file. Currently `runAstChecks` takes a single code string; the evaluator may need to call it multiple times with different files.
- JSX element detection (for `call_exists` with `Suspense`, etc.) works via `JsxOpeningElement` and `JsxSelfClosingElement` syntax kinds
- The checker correctly handles dotted call patterns like `ReactDOM.render` via `PropertyAccessExpression` traversal
- All 5 pilot task reference solutions are verified to pass all their AST checks in the test suite — this ensures the checks are correctly defined in the task JSON files

---

## Task: Create version-grouped type-check environments with pinned library versions

### Completed

- Created 14 typecheck-envs subdirectories, each with a `package.json` using exact pinned version specifiers:
  - `next-13` (next@13.5.6, react@18.2.0, @types/react@18.2.79)
  - `next-14` (next@14.2.35, react@18.3.1, @types/react@18.3.28)
  - `next-15` (next@15.5.12, react@19.2.4, @types/react@19.2.13)
  - `next-16` (next@16.1.6, react@19.2.4, @types/react@19.2.13)
  - `react-17` (react@17.0.2, react-dom@17.0.2, @types/react@17.0.91, @types/react-dom@17.0.26)
  - `react-18` (react@18.3.1, react-dom@18.3.1, @types/react@18.3.28, @types/react-dom@18.3.7)
  - `react-19` (react@19.2.4, react-dom@19.2.4, @types/react@19.2.13, @types/react-dom@19.1.6)
  - `ai-sdk-3` (ai@3.4.33, @ai-sdk/openai@0.0.72, zod@3.23.8)
  - `ai-sdk-4` (ai@4.3.19, @ai-sdk/openai@1.3.24, zod@3.25.76)
  - `ai-sdk-5` (ai@5.0.129, @ai-sdk/openai@1.3.24, zod@4.3.6)
  - `trpc-10` (@trpc/server@10.45.4, @trpc/client@10.45.4, @trpc/react-query@10.45.4, @tanstack/react-query@4.36.1, superjson@2.2.2, zod@3.23.8)
  - `trpc-11` (@trpc/server@11.9.0, @trpc/client@11.9.0, superjson@2.2.2, zod@3.25.76)
  - `zod-3` (zod@3.23.8)
  - `zod-4` (zod@4.3.6)
- Created `tsconfig.json` in each environment with: strict mode, ES2022 target, bundler moduleResolution, skipLibCheck: true, typeRoots constrained to local node_modules/@types, jsx: react-jsx (where needed)
- Ran `bun install` in all 14 environments — all dependencies resolved and installed successfully
- Created `src/tests/type-checker.ts` with `runTypeCheck()` and `runTypeCheckMultiFile()` functions that:
  - Map library+version to the correct typecheck-envs directory (e.g., `{library: 'ai', version: '3'}` → `ai-sdk-3`)
  - Write code to temp files in the env directory
  - Run `tsc --noEmit` using the environment's local TypeScript binary
  - Parse errors filtering only to the temp file (not library internal errors)
  - Clean up temp files after checking
- Updated `src/tests/index.ts` to re-export `TypeCheckResult`, `LibraryVersion`, `runTypeCheck`, `runTypeCheckMultiFile`
- Wrote comprehensive test file `src/tests/__tests__/type-checker.test.ts` with 18 tests across 6 describe blocks:
  - **Positive cases (3 tests)**: React 17 ReactDOM.render passes, Next.js 13 sync cookies passes, Zod v3 chained validators passes
  - **Negative cases (3 tests)**: React 18 createRoot fails in React 17 env (TS2307: module not found), same code passes in React 18 env, non-existent import fails
  - **Edge cases (4 tests)**: syntax errors detected, empty code passes (valid empty file), non-existent env returns descriptive error, non-existent base dir returns error
  - **Version mapping (3 tests)**: AI SDK maps to `ai-sdk-N` naming, patch version string extracts major correctly, tRPC env resolves
  - **Multi-file (3 tests)**: multiple valid files pass, file with type error fails, non-existent env returns error
  - **Cross-environment (2 tests)**: Zod v3 code passes in zod-3 env, React 17 ReactDOM.render fails in React 19 env (removed API)
- Verified: `bun test` (94 tests pass across 3 files, 0 fail), `bun run typecheck` passes, `bun run lint` clean

### Files Changed

- `typecheck-envs/next-13/package.json` — Next.js 13 pinned dependencies
- `typecheck-envs/next-14/package.json` — Next.js 14 pinned dependencies
- `typecheck-envs/next-15/package.json` — Next.js 15 pinned dependencies
- `typecheck-envs/next-16/package.json` — Next.js 16 pinned dependencies
- `typecheck-envs/react-17/package.json` — React 17 pinned dependencies
- `typecheck-envs/react-18/package.json` — React 18 pinned dependencies
- `typecheck-envs/react-19/package.json` — React 19 pinned dependencies
- `typecheck-envs/ai-sdk-3/package.json` — AI SDK v3 pinned dependencies
- `typecheck-envs/ai-sdk-4/package.json` — AI SDK v4 pinned dependencies
- `typecheck-envs/ai-sdk-5/package.json` — AI SDK v5 pinned dependencies
- `typecheck-envs/trpc-10/package.json` — tRPC v10 pinned dependencies
- `typecheck-envs/trpc-11/package.json` — tRPC v11 pinned dependencies
- `typecheck-envs/zod-3/package.json` — Zod v3 pinned dependencies
- `typecheck-envs/zod-4/package.json` — Zod v4 pinned dependencies
- `typecheck-envs/*/tsconfig.json` — 14 tsconfig files with strict mode and typeRoots
- `src/tests/type-checker.ts` — Type checker module with runTypeCheck and runTypeCheckMultiFile
- `src/tests/index.ts` — Updated barrel exports to include type checker
- `src/tests/__tests__/type-checker.test.ts` — Comprehensive test suite (18 tests)

### Decisions

- Used `skipLibCheck: true` in all typecheck-envs tsconfigs — this is required because older library type definitions (especially Next.js 13) have internal type inconsistencies with newer TypeScript versions. We only care about type-checking OUR generated code against the library's public API surface, not the library's internal types.
- Used `typeRoots: ["./node_modules/@types"]` to prevent TypeScript from walking up and picking up bun-types from the parent project's node_modules. Without this, the parent project's `bun-types` global declarations conflicted with the library types.
- Used `baseUrl: "."` to anchor module resolution to each environment's own directory.
- The type checker writes temp files prefixed with `_typecheck_` to avoid conflicts with existing files. Files are cleaned up in a `finally` block.
- `runTypeCheck` defaults to `.tsx` extension for temp files (JSX support), but callers can override to `.ts` for non-JSX code.
- `runTypeCheckMultiFile` prefixes temp files with `_typecheck_` to namespace them.
- Library name mapping: AI SDK uses `ai-sdk-N` naming convention (not just `ai-N`), matching the directory names.
- Version extraction uses the major version only: `"17.0.2"` → `"17"`, `"3"` → `"3"`.
- Error parsing filters tsc output to only include errors from the temp file(s), ignoring any library-internal warnings.

### Notes for Future Agent

- The type checker is designed to be called from the evaluator (task 9): `runTypeCheck(code, {library: task.library, version: task.target_version})`
- For multi-file tasks, use `runTypeCheckMultiFile(extractedFiles, libraryVersion)` instead
- The `typecheckEnvsDir` option exists for testing — in production, the default path resolution (`../../typecheck-envs` relative to the module) works correctly
- `await cookies()` in Next.js 13 does NOT produce a type error even though it's semantically wrong (await on non-Promise is valid TS). This is expected — the type checker catches module-level errors (wrong imports, missing APIs), while AST checks catch semantic pattern errors (await vs no-await).
- React 19 types have removed `ReactDOM.render` — this is confirmed to produce a type error when checked against the react-19 environment
- Some peer dependency warnings during install (e.g., AI SDK v3 with zod, AI SDK v5 with @ai-sdk/openai) are benign — the packages still function correctly
- The `trpc-10` environment includes `@tanstack/react-query@4.36.1` as a dependency of `@trpc/react-query` — needed for type resolution
- All 14 environments have `bun.lock` files generated (excluded from git via `.gitignore`)
