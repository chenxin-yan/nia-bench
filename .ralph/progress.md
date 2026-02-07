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

---

## Task: Create Version API Surface reference JSON files for all library versions

### Completed

- Created `src/types/reference.ts` with a `VersionApiSurfaceSchema` Zod schema defining the structure for reference JSON files. Includes fields for: library, version, sync_apis, async_apis, params_type, proxy_file/proxy_function, available_imports, unavailable_apis, removed_from_previous, available_hooks, unavailable_hooks, available_types, unavailable_types, rendering, caching_defaults, required_files, key_features, breaking_changes, and notes.
- Created all 14 reference JSON files organized by library:
  - **Next.js (4 files):** `reference/next/v13.json`, `v14.json`, `v15.json`, `v16.json` — covering the evolution from sync to async request APIs, middleware.ts to proxy.ts rename, and cacheTag/cacheLife/updateTag stabilization
  - **React (3 files):** `reference/react/v17.json`, `v18.json`, `v19.json` — covering hooks progression, ReactDOM.render to createRoot, forwardRef deprecation, and new use()/useActionState/useFormStatus hooks
  - **AI SDK (3 files):** `reference/ai-sdk/v3.json`, `v4.json`, `v5.json` — covering experimental_ prefix removal, sync streamText, toDataStreamResponse, and createUIMessageStream/writer.merge patterns
  - **tRPC (2 files):** `reference/trpc/v10.json`, `v11.json` — covering createTRPCProxyClient to createTRPCClient rename, transformer location change, rawInput to getRawInput(), and httpSubscriptionLink
  - **Zod (2 files):** `reference/zod/v3.json`, `v4.json` — covering chained to top-level validators, required_error/invalid_type_error removal, message to error parameter change, and deepPartial removal
- Wrote comprehensive validation test `src/types/__tests__/reference.test.ts` with 32 tests across 4 describe blocks:
  - **Schema Validation (5 tests):** all 14 files parse, correct library coverage, correct version counts, unique versions per library
  - **Cross-Version Consistency (13 tests):** sync/async API consistency, params type evolution, middleware/proxy naming, cacheTag availability, React hooks progression (use, useActionState, useId), rendering entry points, AI SDK experimental_ prefix, streamText sync/async, createUIMessageStream availability, tRPC client renames, Zod validator pattern changes, error API changes
  - **No Contradictions (2 tests):** no API both available and unavailable, no sync/async overlap
  - **Spot-Check Accuracy (12 tests):** verified against Nia-sourced official docs for Next.js (after() availability), React (forwardRef changes), Zod (.ip() and deepPartial), tRPC (httpSubscriptionLink)
- Used Nia research agents to verify key API details against official documentation for Next.js, React, AI SDK, tRPC, and Zod before creating reference files
- Verified: `bun test` (126 tests pass across 4 files, 0 fail), `bun run typecheck` passes, `bun run lint` clean

### Files Changed

- `src/types/reference.ts` — Zod schema and TypeScript types for reference JSON format
- `src/types/__tests__/reference.test.ts` — Comprehensive validation test suite (32 tests)
- `reference/next/v13.json` — Next.js 13 API surface
- `reference/next/v14.json` — Next.js 14 API surface
- `reference/next/v15.json` — Next.js 15 API surface
- `reference/next/v16.json` — Next.js 16 API surface
- `reference/react/v17.json` — React 17 API surface
- `reference/react/v18.json` — React 18 API surface
- `reference/react/v19.json` — React 19 API surface
- `reference/ai-sdk/v3.json` — AI SDK v3 API surface
- `reference/ai-sdk/v4.json` — AI SDK v4 API surface
- `reference/ai-sdk/v5.json` — AI SDK v5 API surface
- `reference/trpc/v10.json` — tRPC v10 API surface
- `reference/trpc/v11.json` — tRPC v11 API surface
- `reference/zod/v3.json` — Zod v3 API surface
- `reference/zod/v4.json` — Zod v4 API surface
- `reference/.gitkeep` — Removed (no longer needed)

### Decisions

- Used a flexible Zod schema with many optional fields to accommodate different library types (e.g., rendering is React-specific, proxy_file is Next.js-specific, available_hooks is React-specific)
- Used `.default([])` on array fields in the schema so consumers don't need to check for undefined on every array access
- Structured unavailable_apis entries with parenthetical notes (e.g., `"createTRPCProxyClient (renamed to createTRPCClient)"`) to provide context about why an API is unavailable — the test suite handles these descriptions when checking for contradictions
- Named reference files as `v{major}.json` (e.g., `v13.json`, `v4.json`) matching the version string in the JSON data for consistency
- Organized reference files in subdirectories by library name matching the `library` enum values (next, react, ai-sdk, trpc, zod) — note ai-sdk uses hyphen in directory name for readability
- Cross-version consistency tests check logical constraints (e.g., if use() is available in v19, it must be unavailable in v17/v18) to catch data entry errors
- Spot-check tests include comments documenting what was verified against official docs via Nia

### Notes for Future Agent

- The reference files are loaded by path `reference/{library-dir}/v{version}.json` — when building the evaluator (task 9) or judge (task 8), use the library name from the task to find the corresponding reference file
- The `ai-sdk` directory name differs from the library enum value `ai` — you'll need a mapping: `ai` -> `ai-sdk` (similar to how typecheck-envs maps `ai` -> `ai-sdk-N`)
- The `VersionApiSurfaceSchema` in `src/types/reference.ts` should be imported and used when loading reference files for the LLM judge prompt
- Reference files contain `notes` arrays that are particularly useful as LLM judge context — they describe version-specific gotchas
- The `unavailable_apis` entries use descriptive strings with parenthetical alternatives — when using these programmatically, split on the first space or parenthesis to extract the bare API name
- Library directory names: `next`, `react`, `ai-sdk`, `trpc`, `zod`

---

## Task: Build the opencode agent runner with per-condition MCP configs and temp directory sandboxing

### Completed

- Created `src/runner/mcp_configs/baseline.opencode.json` — opencode config with Claude 4 Sonnet as model, NO MCP servers configured. Uses `agents.coder`, `agents.task`, `agents.title`, `agents.summarizer` structure matching opencode's config format.
- Created `src/runner/mcp_configs/context7.opencode.json` — opencode config with Claude 4 Sonnet as model, Context7 MCP server configured with stdio transport (`npx -y @context7/mcp`), providing `resolve-library-id` and `query-docs` tools.
- Created `src/runner/mcp_configs/nia.opencode.json` — opencode config with Claude 4 Sonnet as model, Nia MCP server configured with stdio transport (`npx -y @nicepkg/nia-mcp`), providing full toolset (search, nia_read, nia_grep, nia_explore, etc.).
- Created `src/runner/agent.ts` with the `runAgent(task, condition, runIndex, config)` function implementing the full agent execution pipeline:
  - **Temp directory sandboxing**: Creates unique dirs at `/tmp/nia-bench/{timestamp}-{taskId}-{condition}-{rep}/`
  - **Config injection**: Copies condition-specific `.opencode.json` into the temp dir (opencode loads config from CWD)
  - **Context injection**: Writes task context files (package.json, code files) into the temp dir to simulate a real project workspace
  - **opencode invocation**: Spawns `opencode -c <workdir> -p "<prompt>" -f json -q` using `Bun.spawn()`, captures stdout as JSON
  - **Dual code extraction**: (1) parses agent's JSON stdout for markdown code blocks via regex, (2) scans temp dir for `.ts/.tsx/.js/.jsx` files written by the agent. Disk files are preferred when available.
  - **Multi-file support**: `extractedFiles` is `Record<string, string>` (filename -> code), supporting tasks that require multiple files
  - **Timeout handling**: Configurable timeout (default 5 min), kills the process on timeout
  - **Temp dir cleanup**: Removes temp dir after code extraction unless `keepWorkdirs: true`
- Defined `AgentResult` type: `{taskId, condition, runIndex, rawOutput, extractedFiles, exitCode, durationMs, workDir}`
- Defined `AgentRunnerConfig` type with options: `keepWorkdirs`, `timeout`, `tempBaseDir`, `mcpConfigDir`, `projectRoot`
- Exported utility functions for individual testing: `createWorkDir`, `injectConfig`, `injectContext`, `extractCodeFromResponse`, `extractCodeFromDisk`, `checkOpencodeBinary`
- Created `src/runner/index.ts` re-exporting all types and functions
- Wrote comprehensive test file `src/runner/__tests__/agent.test.ts` with 40 tests across 6 describe blocks:
  - **createWorkDir (4 tests)**: unique naming, different conditions, different run indices, nested directory creation
  - **injectConfig (4 tests)**: baseline config (no MCP), context7 config (Context7 MCP), nia config (Nia MCP), all conditions use same model
  - **injectContext (5 tests)**: no context, package.json only, code files only, nested directory creation, both package.json and code
  - **extractCodeFromResponse (8 tests)**: JSON response, multiple code blocks, raw text fallback, no code blocks, empty input, tsx/jsx blocks, filename hints
  - **extractCodeFromDisk (8 tests)**: finds TS files, nested directories, ignores non-code, ignores .opencode.json/node_modules/package.json, finds JS/JSX, empty directory, multiple nested files
  - **integration dry run (6 tests)**: full workflow (create/inject/extract/cleanup), context7 MCP config, nia MCP config, disk preferred over response, fallback to response, multi-file extraction
  - **edge cases (5 tests)**: malformed JSON, empty code blocks, non-existent directory, empty context, non-existent config dir
- Verified: `bun run typecheck` passes, `bun run lint` clean, all 166 tests pass across 5 files (40 new agent tests + 126 existing)

### Files Changed

- `src/runner/mcp_configs/baseline.opencode.json` — Baseline opencode config (no MCP)
- `src/runner/mcp_configs/context7.opencode.json` — Context7 opencode config (Context7 MCP server)
- `src/runner/mcp_configs/nia.opencode.json` — Nia opencode config (Nia MCP server)
- `src/runner/agent.ts` — Agent runner module with temp dir sandboxing and code extraction
- `src/runner/index.ts` — Barrel exports for runner module
- `src/runner/__tests__/agent.test.ts` — Comprehensive test suite (40 tests)
- `src/runner/mcp_configs/.gitkeep` — Removed (no longer needed, configs exist)

### Decisions

- Used opencode's `-c` flag (short for `--cwd`) to set the working directory, not `cd` — this is the proper way to sandbox the agent per opencode docs
- Used `-q` (quiet) flag to suppress spinner animation in non-interactive mode, cleaner stdout capture
- MCP server configs use `claude-4-sonnet` as the model for all agents — consistent across all three conditions to ensure fair comparison
- Nia MCP server uses `npx -y @nicepkg/nia-mcp` for stdio transport — this is the standard Nia MCP package
- Context7 MCP server uses `npx -y @context7/mcp` for stdio transport
- `extractCodeFromDisk` uses `node:fs/promises` `stat()` for proper file/directory detection instead of `Bun.file().exists()` which doesn't distinguish files from directories
- Disk-written files are preferred over response-extracted code blocks because agents may truncate code in text output but write complete files to disk
- The `extractCodeFromResponse` function handles both JSON (`{response: "..."}`) and raw text formats gracefully
- Code block extraction supports multiple language hints: typescript, tsx, ts, jsx, js, javascript
- Filename detection from response text uses a regex looking for patterns like `file: proxy.ts` or `filename: page.tsx` before code blocks
- Tests use a custom `pathExists()` helper instead of `node:fs/promises` `access()` because Bun's access() resolves to `null` rather than `undefined` on success, breaking standard assertions

### Notes for Future Agent

- The agent runner is designed to be called from the CLI orchestrator (task 11): `runAgent(task, 'baseline', 0, config)` for each work item in the queue
- The `runAgent` function is fully self-contained — it handles its own temp dir lifecycle, so multiple parallel workers can call it without conflicts
- `AgentResult.workDir` contains the temp dir path — this is useful when `keepWorkdirs: true` for debugging, otherwise the dir is deleted
- `AgentResult.extractedFiles` is the primary output for the evaluator (task 9) — pass it to `evaluateCode(task, result.extractedFiles)`
- When building the evaluator, note that `extractedFiles` keys are relative paths (e.g., `app/page.tsx`, `proxy.ts`) not absolute
- The `checkOpencodeBinary()` function should be called at CLI startup (task 11) to fail fast if opencode isn't installed
- opencode's JSON output format is `{response: "..."}` with escaped newlines/quotes — `extractCodeFromResponse` handles the parsing
- The MCP config files are copied (not symlinked) into each temp dir, so they're self-contained
- For the pilot run (task 12), use `--keep-workdirs` to inspect what the agent actually produced
- The regex for code block extraction handles the common patterns but may miss edge cases (e.g., nested code blocks, code blocks with metadata lines) — this can be refined during the pilot run

---

## Task: Build the LLM judge module with structured rubric evaluation via OpenRouter

### Completed

- Created `src/judge/prompt-template.ts` with `buildJudgePrompt(task, generatedCode, referenceDoc)` function that constructs the judge prompt following the BENCHMARK.md Section 5.2 template exactly. Includes all required sections: task prompt, target version, reference documentation (formatted from VersionApiSurface), reference solution, generated code, rubric criteria with weights, known hallucination patterns, and the "ONLY use reference documentation" instruction.
- Created `src/judge/openrouter-client.ts` with `callJudge(prompt, config)` function that calls OpenRouter API using the OpenAI-compatible SDK. Defaults to `openai/gpt-5-mini` model, temperature 0.0. Also includes `parseJudgeResponse(rawResponse)` for parsing and normalizing the JSON response from the LLM judge — handles JSON arrays, single objects, embedded JSON in surrounding text, missing fields, and invalid verdicts.
- Created `src/judge/rubric-scorer.ts` with:
  - `scoreWithRubric(task, generatedCode, config)` — main entry point: calls the LLM judge 3x (configurable), collects per-criterion verdicts, applies majority vote, and computes weighted judge score
  - `applyMajorityVote(task, rawResponses)` — applies majority voting: for each criterion, PASS if >= ceil(runs/2) say PASS, evidence/reasoning from the majority side
  - `calculateJudgeScore(criteria)` — computes `sum(passed_criterion.weight) / sum(all_criterion.weight)`
  - `loadReferenceDoc(task, referenceDir)` — loads the version API surface reference JSON file for the task's library+version, with proper library directory mapping (`ai` -> `ai-sdk`)
- Created `src/judge/index.ts` re-exporting all types and functions from the module
- Defined types: `CriterionResult` (name, verdict, weight, evidence, reasoning), `JudgeResult` (criteria, judgeScore, rawResponses), `ScorerConfig` (runs, clientConfig, referenceDir), `JudgeClientConfig` (apiKey, model, temperature, maxTokens), `JudgeCriterionResponse`, `JudgeCallResult`
- Wrote `src/judge/__tests__/prompt-template.test.ts` with 16 tests verifying: task prompt inclusion, target version, reference documentation (multiple sections), reference solution, generated code, all rubric criteria with names/weights/descriptions, known hallucinations, the "ONLY use reference documentation" instruction, React-specific rendering info, params_type n/a handling, JSON response format request, section ordering
- Wrote `src/judge/__tests__/rubric-scorer.test.ts` with 23 tests across 4 describe blocks:
  - **applyMajorityVote (7 tests)**: unanimous PASS (3/3), majority PASS (2/3), majority FAIL (1/3), weight preservation, failed runs count as FAIL, missing criterion handling, all 3 runs failed
  - **calculateJudgeScore (5 tests)**: weighted score with 2 pass + 1 fail (=0.6), all pass (=1.0), all fail (=0.0), empty criteria (=0), uneven weights
  - **parseJudgeResponse (7 tests)**: valid JSON array, JSON in surrounding text, invalid JSON error handling, single object, invalid verdict normalization to FAIL, empty array, missing fields with defaults
  - **Integration (3 tests)**: full workflow with mixed verdicts producing correct score (0.7), all runs fail (=0.0), single run (no voting)
- Verified: `bun run typecheck` passes, `bun test` (205 tests across 7 files, 0 fail), `bun run lint` clean

### Files Changed

- `src/judge/prompt-template.ts` — Judge prompt builder following BENCHMARK.md Section 5.2 template
- `src/judge/openrouter-client.ts` — OpenRouter API client with JSON response parsing
- `src/judge/rubric-scorer.ts` — Rubric scorer with majority voting and reference doc loading
- `src/judge/index.ts` — Re-exports for the judge module
- `src/judge/__tests__/prompt-template.test.ts` — Prompt template test suite (16 tests)
- `src/judge/__tests__/rubric-scorer.test.ts` — Rubric scorer and majority voting test suite (23 tests)
- `src/judge/.gitkeep` — Removed (no longer needed, actual files exist)

### Decisions

- Used `openai/gpt-5-mini` as the default judge model on OpenRouter (per SPEC.md and prd.json task notes), while making it configurable via `JudgeClientConfig.model` for flexibility (BENCHMARK.md mentions Claude Opus as an alternative)
- Temperature is 0.0 for reproducibility as specified in both SPEC.md and BENCHMARK.md
- The judge prompt requests a JSON array response format for easier parsing — each criterion is a separate object with `criterion`, `verdict`, `evidence`, and `reasoning` fields
- `parseJudgeResponse` is tolerant: it handles JSON arrays embedded in surrounding text (common with LLMs), single objects wrapped into arrays, missing fields defaulting to FAIL/empty, and invalid verdicts normalized to FAIL
- If a judge run returns unparseable JSON, the scorer retries once before counting it as a failed run. Failed runs count as FAIL for all criteria during majority voting.
- Library-to-directory mapping (`ai` -> `ai-sdk`) is centralized in `LIBRARY_DIR_MAP` constant, matching the pattern from the reference files and typecheck-envs
- The `formatReferenceDoc` function includes all relevant sections conditionally — empty arrays and n/a values are omitted for cleaner prompts
- Tests use no API calls — all judge-related tests mock the data layer (raw responses, criterion results) to test the voting logic, score calculation, and response parsing in isolation

### Notes for Future Agent

- The judge module is designed to be called from the evaluator (task 10): `scoreWithRubric(task, generatedCode, config)` returns `JudgeResult` with `criteria`, `judgeScore`, and `rawResponses`
- `loadReferenceDoc(task)` loads from `reference/{libDir}/v{majorVersion}.json` — uses `LIBRARY_DIR_MAP` for library name mapping
- The `referenceDir` config option allows overriding the reference directory path (useful for testing)
- The `runs` config option defaults to 3 (for 3x majority vote) but can be changed for faster development iterations
- The `skipJudge` flag in the evaluator (task 10) should bypass `scoreWithRubric` entirely and set `judgeScore = 0`
- `callJudge` creates a new OpenAI client for each call — this is intentional for statelessness. For high-parallelism scenarios, consider creating the client once and passing it in.
- The hallucination classifier (task 9) will need the `JudgeResult` from this module — specifically the per-criterion verdicts for the `no_hallucination` criterion
- When building the evaluator, concatenate all extracted files with filename headers for the `generatedCode` parameter passed to `buildJudgePrompt`

---

## Task: Build the hallucination classifier module

### Completed

- Created `src/judge/hallucination-classifier.ts` with the full hallucination classification system as defined in BENCHMARK.md Section 5.4
- Defined `HallucinationType` as a union type covering all 6 categories: `invented_method`, `wrong_parameter`, `outdated_api`, `future_api`, `wrong_import_path`, `version_mismatch`
- Defined `HallucinationDetail` type: `{type: HallucinationType, evidence: string, description: string}`
- Defined `HallucinationResult` type: `{types: HallucinationType[], details: HallucinationDetail[]}`
- Implemented `classifyHallucinations(task, generatedCode, astResults, judgeResult)` as the main entry point that combines three signal sources:
  1. **AST check failures**: Maps each of the 16 AST check types to appropriate hallucination types when they fail (e.g., `await_absent` failure → `future_api`, `import_absent` failure → `outdated_api` or `future_api` based on task category)
  2. **Judge results**: Extracts hallucination signals from FAIL verdicts on `no_hallucination` and similar criteria, with NLP-based type inference from evidence/reasoning text
  3. **Common hallucinations cross-reference**: Enhances descriptions by matching detected hallucinations against the task's known `common_hallucinations` patterns
- Implemented intelligent version direction inference (`inferVersionDirection`) that determines whether a wrong API is from a newer version (`future_api`) or older version (`outdated_api`) based on: task category (`bleeding_edge` → outdated, `version_locked_write` → future, `version_locked_audit` → mismatch), common_hallucinations hints, and API name matching
- Implemented judge evidence text classification (`inferTypeFromJudgeEvidence`) that maps keywords in judge evidence/reasoning to hallucination types (e.g., "import"+"wrong" → `wrong_import_path`, "deprecated"/"outdated" → `outdated_api`, etc.)
- Type deduplication: `types` array contains unique hallucination types, while `details` preserves all individual entries
- Exported the classifier and types from `src/judge/index.ts`
- Wrote comprehensive test file `src/judge/__tests__/hallucination-classifier.test.ts` with 23 tests across 8 describe blocks:
  - **Test case 1 (future_api)**: Next.js 13 task where `await_absent` for `cookies()` failed — correctly classifies as `future_api`
  - **Test case 2 (outdated_api)**: React 19 task where `import_absent` for `forwardRef` failed — correctly classifies as `outdated_api`
  - **Test case 3 (wrong_import_path)**: React 19 task where `useActionState` imported from `react-dom` instead of `react` — correctly classifies as `wrong_import_path`
  - **Test case 4 (multiple hallucinations)**: Next.js 16 task with multiple AST failures + judge FAIL — correctly returns multiple distinct types with all details
  - **Test case 5 (no hallucinations)**: All AST checks pass + judge all PASS — correctly returns empty types and details
  - **AST check type classification mapping**: 6 tests covering `call_absent`, `property_location`, `type_annotation`, `await_present`, `directive_present`, `async_function` check types
  - **Judge evidence classification**: 5 tests covering different keyword patterns in judge evidence (wrong_import_path, wrong_parameter, future_api, version_mismatch, invented_method default)
  - **Deduplication + version direction**: 4 tests for type deduplication and category-based direction inference
- Verified: `bun test` (228 tests pass across 8 files, 0 fail), `bun run typecheck` passes, `bun run lint` clean

### Files Changed

- `src/judge/hallucination-classifier.ts` — Hallucination classifier module with 6-type taxonomy
- `src/judge/index.ts` — Updated barrel exports to include hallucination classifier types and function
- `src/judge/__tests__/hallucination-classifier.test.ts` — Comprehensive test suite (23 tests)

### Decisions

- Used a union type (`HallucinationType`) instead of an enum for better TypeScript ergonomics and tree-shaking — the values are string literals matching BENCHMARK.md Section 5.4 exactly
- Kept the classifier stateless: it receives all inputs (task, code, AST results, judge results) and returns a pure result — no side effects, no external API calls, making it fully testable
- AST check type → hallucination type mapping is deterministic based on the check type and task category:
  - `await_absent` failure → `future_api` (async pattern from newer version)
  - `await_present` failure → `outdated_api` (sync pattern from older version)
  - `import_absent` / `function_absent` / `call_absent` / `property_absent` → direction inferred from task category
  - `import_exists` / `module_import_absent` → `wrong_import_path`
  - `property_location` / `type_annotation` → `wrong_parameter`
  - `function_exported` / `call_exists` / `directive_present` / `async_function` / `async_generator` / `yield_present` → `version_mismatch`
- Version direction inference prioritizes: (1) common_hallucinations keyword matching, (2) task category-based defaults. This handles the majority of cases correctly without needing to hardcode specific API knowledge.
- Judge evidence classification uses keyword matching (not LLM) to stay fast and deterministic — the inference is approximate but sufficient since the primary classification comes from AST checks
- The `generatedCode` parameter is accepted but not directly analyzed (prefixed with `_`) — it's available for potential future text-based analysis but currently all classification comes from structured AST results and judge verdicts

### Notes for Future Agent

- The classifier is designed to be called from the evaluator (task 10): `classifyHallucinations(task, generatedCode, astResults, judgeResult)` returns `HallucinationResult`
- `HallucinationResult.types` is a deduplicated array of unique hallucination types; `HallucinationResult.details` contains all individual hallucination entries with evidence
- A single code sample can have multiple hallucination types simultaneously — the evaluator should store the full `HallucinationResult` in the `EvaluationResult`
- When building the reporter (task 15), use `HallucinationResult.types` for the hallucination rate metric (% of tasks with >= 1 type) and `HallucinationResult.details` for per-type distribution
- The classifier combines signals from both AST checks (structural correctness) and judge verdicts (semantic correctness) — this two-layer approach catches both programmatically detectable issues (wrong imports, wrong await patterns) and semantically detectable issues (correct structure but wrong intent)
- When no specific type can be determined from judge evidence, it defaults to `invented_method` — this is the safest fallback as it indicates the judge detected something wrong but the specific category is unclear

---

## Task: Build the combined evaluator that orchestrates AST checks, type checking, and LLM judge scoring

### Completed

- Created `src/runner/evaluator.ts` with `evaluateCode(task, extractedFiles, condition, runIndex, config)` function that orchestrates all evaluation layers
- Defined `EvaluationResult` type with all fields: `taskId`, `condition`, `runIndex`, `testScore`, `judgeScore`, `finalScore`, `astResults`, `typeCheckResult`, `judgeResult`, `hallucinations`, `extractedFiles`
- Defined `EvaluatorConfig` type with options: `skipJudge`, `scorerConfig`, `typecheckEnvsDir`
- Implemented multi-file AST check support: checks are grouped by the `file` field, each group is run against the corresponding extracted file. File resolution supports exact match and partial path matching (e.g., `page.tsx` matches `app/page.tsx`).
- Layer 1: AST checks via `runAstChecks()` — computes `testScore = passedChecks / totalChecks`
- Layer 1b: Type checking via `runTypeCheck()`/`runTypeCheckMultiFile()` when `task.test_spec.type_check` is true — adds one pass/fail assertion to the test score
- Layer 2: LLM judge via `scoreWithRubric()` — gets `judgeScore` (0.0-1.0)
- Combined score formula: `finalScore = 0.6 * testScore + 0.4 * judgeScore`
- Special case for audit tasks: when no AST checks exist AND no type_check, `finalScore = judgeScore` (100% judge weight)
- Skip-judge mode: when `skipJudge: true`, `finalScore = testScore` for tasks with AST checks, or `finalScore = 0` for audit tasks
- Hallucination classification runs with all signals (AST results + judge results)
- All extracted files are concatenated with filename headers for the LLM judge context
- Exported `evaluateCode`, `EvaluationResult`, and `EvaluatorConfig` from `src/runner/index.ts`
- Wrote comprehensive integration test `src/runner/__tests__/evaluator.test.ts` with 14 tests across 6 describe blocks:
  - **Test case 1 (skip-judge, reference code)**: proxy task + reference solution passes all 4 AST checks, testScore=1.0, no hallucinations, finalScore=1.0. Also tested with sync APIs task.
  - **Test case 2 (skip-judge, bad code)**: proxy task + hallucinated middleware.ts fails AST checks, testScore<1.0, hallucinations detected. Also tested sync APIs task with await (v15 pattern) — correctly detects future_api hallucinations.
  - **Test case 3 (audit task, skip-judge)**: audit task with no AST checks returns finalScore=0 (judge skipped), no crashes. Also tested with empty extracted files.
  - **Test case 4 (score formula)**: verified combined formula math 0.6*0.8+0.4*0.6=0.72, verified skip-judge sets finalScore=testScore, verified audit finalScore=judgeScore.
  - **Multi-file support (2 tests)**: file-specific AST checks against multiple extracted files, missing file causes targeted failures.
  - **Edge cases (3 tests)**: empty extracted files, metadata field presence, partial path matching for file keys.
- Verified: `bun test` (242 tests pass across 9 files, 0 fail), `bun run typecheck` passes, `bun run lint` clean

### Files Changed

- `src/runner/evaluator.ts` — Combined evaluator module with all evaluation layers
- `src/runner/index.ts` — Updated barrel exports to include evaluator types and function
- `src/runner/__tests__/evaluator.test.ts` — Integration test suite (14 tests)

### Decisions

- The evaluator accepts `extractedFiles: Record<string, string>` (filename -> code) as input, decoupled from the agent runner. This allows re-running evaluation on existing outputs (needed for `--eval-only` mode in the CLI).
- Multi-file AST check resolution uses a three-tier strategy: (1) exact filename match, (2) partial suffix match (handles `page.tsx` matching `app/page.tsx`), (3) for checks without a `file` field, uses the first file if single, or concatenates all files if multiple.
- All extracted files are concatenated with `// --- filename ---` headers for the LLM judge — the judge needs full cross-file context.
- When the judge is skipped, a dummy `JudgeResult` with empty criteria is passed to the hallucination classifier. This ensures the classifier still runs on AST check signals even without judge data.
- The `hasAstChecks` flag considers both `ast_checks.length > 0` and `type_check: true` — if either is present, the standard 60/40 formula applies. Audit tasks have neither.
- Tests use `skipJudge: true` exclusively to avoid real API calls — the judge module itself was tested in task 8 with comprehensive unit tests.

### Notes for Future Agent

- The evaluator is designed to be called from the CLI orchestrator (task 11): `evaluateCode(task, agentResult.extractedFiles, agentResult.condition, agentResult.runIndex, config)`
- The `EvaluatorConfig.scorerConfig` passes through to the LLM judge — set `scorerConfig.runs` to control judge repetitions (default 3)
- For `--eval-only` mode, the orchestrator should read existing `AgentResult` JSON files and re-run `evaluateCode()` on them
- The `skipJudge` flag is crucial for development — without it, every evaluation costs real OpenRouter API credits
- The evaluator is fully independent from the agent runner — it takes extracted files as input, making it safe to run standalone
- When building the result storage (task 11), serialize the full `EvaluationResult` including `astResults`, `judgeResult`, and `hallucinations` as JSON
- The `extractedFiles` field in `EvaluationResult` preserves what was evaluated — useful for debugging and report generation
- Multi-file tasks work transparently: the evaluator handles file routing for AST checks and concatenation for judge/classifier

---

## Task: Build the CLI orchestrator with configurable parallelism, work queue, and result storage

### Completed

- Expanded `src/index.ts` from a placeholder into a full CLI entry point that parses args and calls `runBenchmark()`
- Created `src/runner/orchestrator.ts` with the full orchestration pipeline:
  - CLI argument parser supporting all flags: `--category`, `--library`, `--task`, `--condition`, `--reps`, `--parallel`, `--skip-judge`, `--keep-workdirs`, `--output-dir`, `--timeout`, `--seed`, `--dry-run`, `--eval-only`, `--report-only`, `--tasks-dir`
  - Work queue generation: enumerates all (task, condition, rep) tuples into a flat array
  - Seeded random (mulberry32 PRNG) for reproducible execution order shuffling via `--seed`
  - Fisher-Yates shuffle with seeded RNG for randomizing work queue
  - `AsyncSemaphore` for controlling parallel worker concurrency (configurable via `--parallel N`)
  - `ProgressLogger` with rolling average ETA estimation and elapsed time display
  - `formatDuration()` helper for human-readable time strings
  - Graceful interruption handling (SIGINT/SIGTERM): stops spawning new workers, waits for in-flight workers, saves partial results with `status: 'interrupted'`
  - `--dry-run` mode: prints the shuffled execution plan without running anything
  - `--eval-only` and `--report-only` mode stubs (to be fully implemented in later tasks)
  - Full execution pipeline: load tasks → generate queue → shuffle → run agent → evaluate → store result → update metadata
- Created `src/runner/result-store.ts` with:
  - `createRunDir()`: creates timestamped results directory at `results/{timestamp}/`
  - `storeResult()`: writes each `EvaluationResult` as JSON to `results/{timestamp}/{taskId}/{condition}/run-{index}.json` with atomic writes (temp file + rename)
  - `writeRunMetadata()`: writes/updates `run-meta.json` with run configuration, timing, and status
- Updated `src/runner/index.ts` barrel exports to include all new modules
- Wrote comprehensive test file `src/runner/__tests__/orchestrator.test.ts` with 30 tests across 8 describe blocks:
  - **generateWorkQueue (5 tests)**: correct item count (3x2x2=12), all combos present, single task x 3 conditions, empty task list, 0-based rep indices
  - **createSeededRandom (3 tests)**: same seed same sequence, different seeds different sequences, values in [0,1) range
  - **shuffleArray (6 tests)**: same seed same order, different seeds different order, preserves all elements, does not mutate original, work queue reproducibility, work queue difference
  - **parseCliArgs (4 tests)**: all flags parsed, defaults correct, eval-only/report-only, tasks-dir
  - **formatDuration (4 tests)**: ms, seconds, minutes+seconds, hours+minutes
  - **AsyncSemaphore (2 tests)**: respects max concurrency, sequential with concurrency=1
  - **ProgressLogger (1 test)**: tracks completed count
  - **result-store (5 tests)**: createRunDir, storeResult path structure, multiple runs, writeRunMetadata create, writeRunMetadata update
- Verified --dry-run: `bun run bench --dry-run --reps 1` prints exactly 15 items (5 tasks x 3 conditions x 1 rep)
- Verified --dry-run with filters: `bun run bench --dry-run --task nextjs-16-proxy-ts --condition baseline --reps 2` prints exactly 2 items
- Verified --seed reproducibility: `bun run bench --dry-run --reps 1 --seed 42` produces identical output on two consecutive runs
- Verified: `bun test` (272 tests pass across 10 files, 0 fail), `bun run typecheck` passes, `bun run lint` clean

### Files Changed

- `src/index.ts` — Expanded from placeholder to full CLI entry point
- `src/runner/orchestrator.ts` — Main orchestrator with CLI parsing, work queue, parallel execution, progress logging
- `src/runner/result-store.ts` — Result storage with atomic writes and run metadata
- `src/runner/index.ts` — Updated barrel exports for new modules
- `src/runner/__tests__/orchestrator.test.ts` — Comprehensive test suite (30 tests)

### Decisions

- Used a simple mulberry32 PRNG for seeded random instead of a library — it's lightweight, deterministic, and sufficient for shuffling. The algorithm is well-known and produces good distribution.
- Used `Bun.spawn()` for process spawning (consistent with agent.ts) and `process.argv` parsing with a custom switch-based parser (no external dependency like `minimist` or `yargs`) — the flag set is small and well-defined.
- Atomic writes for result storage: write to `.tmp` file then `rename()` — prevents corruption from parallel workers writing simultaneously.
- The `AsyncSemaphore` is a simple promise-queue semaphore pattern — no external library needed. Workers acquire before starting, release on completion.
- The `ProgressLogger` uses a rolling average of the last 10 execution durations for ETA estimation — more accurate than total average since execution times may vary.
- Signal handling uses `process.on('SIGINT'/'SIGTERM')` with an `interrupted` flag that prevents new work from starting but lets in-flight workers finish. Metadata is updated to `status: 'interrupted'` on signal.
- The `--eval-only` and `--report-only` modes are stubbed with console messages pointing to their respective future tasks (task 12 and task 15). The structural wiring is in place.
- The orchestrator uses `Promise.allSettled()` (via map + semaphore pattern) to ensure all settled promises are awaited, even on error.

### Notes for Future Agent

- The CLI entry point at `src/index.ts` now imports and calls `runBenchmark()` from the orchestrator — no longer just a placeholder
- For the pilot run (task 12), the orchestrator is ready to use. Just run `bun run bench --task nextjs-16-proxy-ts --condition baseline --reps 1 --skip-judge --keep-workdirs` to test end-to-end
- The `--eval-only` mode needs full implementation in task 12 or later — it should read existing `AgentResult` JSON files from a results directory and re-run evaluation
- The `--report-only` mode delegates to the reporter (task 15) — the placeholder message should be replaced with an actual call to `generateReport()`
- Result files are stored at `results/{timestamp}/{taskId}/{condition}/run-{index}.json` — the reporter needs to scan this structure
- Run metadata at `results/{timestamp}/run-meta.json` includes all configuration for reproducibility
- The `RunMetadata` type includes `completedItems` and `totalItems` for tracking partial results on interruption
- The worker pool creates all promises upfront (via `workQueue.map()`) and uses the semaphore to limit concurrency — this is simpler than a pull-based queue and works well with `Promise.allSettled()`
- The `--tasks-dir` flag can override where tasks are loaded from (default: `{cwd}/tasks/`)
- All CLI flags use `--kebab-case` convention (e.g., `--skip-judge`, `--keep-workdirs`, `--output-dir`)

---

## Task: Pilot run: execute end-to-end pipeline on 5 pilot tasks and validate sandboxing, execution, and evaluation

### Completed

- **Critical discovery**: opencode v1.1.47 uses a completely different CLI interface than the one the agent runner was originally built for. Updated the entire agent runner to match.
- Updated opencode CLI invocation from `opencode -c <cwd> -p "<prompt>" -f json -q` to `opencode run --format json --model <model> "<prompt>"` with `cwd` set via `Bun.spawn()` options
- Updated JSON output parsing from single `{response: "..."}` format to streaming NDJSON (newline-delimited JSON) events with types: `step_start`, `text`, `tool_use`, `step_finish`, `error`
- Added `parseOpenCodeEvents()` function to parse NDJSON output into typed event objects
- Updated `extractCodeFromResponse()` to concatenate text from all `text` type events, then extract code blocks from the concatenated text
- Updated MCP config model IDs from `claude-4-sonnet` to `anthropic/claude-sonnet-4-20250514` (correct provider/model format for opencode v1.1.47)
- Added `--model` CLI flag and `model` field to `AgentRunnerConfig` to override model via `opencode run --model` flag — necessary because opencode's global config/env-based model defaults can override the per-project `.opencode.json` settings
- Validated dry-run: `bun run bench --dry-run --reps 1` correctly prints 15 items (5 tasks × 3 conditions)
- Validated filter: `bun run bench --dry-run --task nextjs-16-proxy-ts --condition baseline --reps 2` correctly prints 2 items
- Validated seed reproducibility: two consecutive runs with `--seed 42` produce identical execution order
- **Successfully ran a real pilot task**: `bun run bench --task nextjs-16-proxy-ts --condition baseline --reps 1 --skip-judge --keep-workdirs --model anthropic/claude-sonnet-4-20250514`
  - Agent completed in ~3 minutes, created a full Next.js 16 project with `proxy.ts`
  - All 4 AST checks passed (testScore=1.0): proxy function exported, middleware function absent, config.matcher present, no runtime property
  - Zero hallucinations detected
  - Code extracted from disk correctly (6 code files found)
  - Result JSON stored at `results/{timestamp}/nextjs-16-proxy-ts/baseline/run-0.json`
  - Temp dir preserved with `.opencode.json` config injection verified
- Updated tests to cover NDJSON parsing (7 new tests for `parseOpenCodeEvents`), NDJSON-based code extraction, and updated model name assertions
- Verified: `bun test` (281 tests pass across 10 files, 0 fail), `bun run typecheck` passes, `bun run lint` clean

### Files Changed

- `src/runner/agent.ts` — Rewrote agent runner: new CLI syntax (`opencode run`), NDJSON parsing, `--model` flag, CWD via Bun.spawn options
- `src/runner/index.ts` — Added `parseOpenCodeEvents` and `OpenCodeEvent` exports
- `src/runner/orchestrator.ts` — Added `--model` CLI flag, model field in CliConfig, pass model to runAgent
- `src/runner/mcp_configs/baseline.opencode.json` — Updated model to `anthropic/claude-sonnet-4-20250514`
- `src/runner/mcp_configs/context7.opencode.json` — Updated model to `anthropic/claude-sonnet-4-20250514`
- `src/runner/mcp_configs/nia.opencode.json` — Updated model to `anthropic/claude-sonnet-4-20250514`
- `src/runner/__tests__/agent.test.ts` — Updated tests for NDJSON format, new model name, added parseOpenCodeEvents tests

### Decisions

- **CWD via Bun.spawn**: opencode v1.1.47's `run` subcommand has no `--cwd` flag. Instead, the working directory is set via `Bun.spawn({cwd: workDir})`, which makes opencode load its `.opencode.json` config from the temp dir.
- **--model flag is required**: opencode resolves the default model based on available API keys in the environment (priority: Copilot > Anthropic > OpenAI > Gemini > Groq > OpenRouter). If the user has a GROQ_API_KEY set but no ANTHROPIC_API_KEY, opencode will use the Groq model even if `.opencode.json` specifies Claude Sonnet. The `--model` flag on `opencode run` overrides this.
- **NDJSON event parsing**: opencode's `--format json` outputs one JSON object per line (NDJSON). Events have types: `step_start`, `text`, `tool_use`, `step_finish`, `error`. Text content is in `part.text` of `text` type events. Multiple text events may exist across multiple steps (multi-turn conversations with tool use).
- **Backward compatibility**: `extractCodeFromResponse` falls back to the old `{response: "..."}` JSON format if NDJSON parsing yields no text content — ensures the code extraction works with any format.
- **Deferred multi-condition and judge testing**: Only the baseline condition was tested with a real agent execution to minimize API costs. Context7 and Nia conditions, parallel execution, and the LLM judge remain to be validated in future runs. The structural wiring is in place.

### Notes for Future Agent

- **Always use `--model` flag** when running `bun run bench`: `bun run bench --model anthropic/claude-sonnet-4-20250514 ...`. Without it, the agent model depends on which API keys are set in the environment.
- The agent creates a full project scaffolding (ran `npx create-next-app`, installed dependencies, wrote proxy.ts) which explains the ~3 minute execution time. Future tasks may be faster since some don't require a full project setup.
- opencode auto-approves all tool permissions in non-interactive mode via `opencode run` — no special permission config needed in `.opencode.json`
- The extractCodeFromDisk function correctly skips `.opencode.json`, `node_modules`, `package.json`, `.git`, and other non-code files — this was validated with the real agent output
- Context7 and Nia MCP servers use `npx -y @context7/mcp` and `npx -y @nicepkg/nia-mcp` respectively — these still need live validation
- The LLM judge (OpenRouter with GPT-5 Mini) has not been tested with a real call yet — test with `--task nextjs-16-proxy-ts --condition baseline --reps 1 --model anthropic/claude-sonnet-4-20250514` (without `--skip-judge`) when ready
- The parallel execution test was not performed to save API costs — test with `--parallel 3` in a future run

---

## Task: Author all remaining Bleeding-Edge task JSON files (9 remaining after 2 pilot tasks)

### Completed

- Created all 12 remaining bleeding-edge task JSON files (the task description says 9 but there are actually 12 remaining from the 14 total minus the 2 pilot tasks):
  - `tasks/bleeding_edge/nextjs-16-enforced-async.json` — Task A-NX-2: enforced async APIs + parallel route defaults
  - `tasks/bleeding_edge/nextjs-16-cache-components.json` — Task A-NX-3: 'use cache' directive + cacheTag/cacheLife/updateTag (multi-file: page.tsx + actions.ts)
  - `tasks/bleeding_edge/react-19-form-actions.json` — Task A-RX-2: useActionState + useFormStatus
  - `tasks/bleeding_edge/react-19-ref-as-prop.json` — Task A-RX-3: ref as prop, no forwardRef
  - `tasks/bleeding_edge/ai-sdk-5-ui-message-stream.json` — Task A-AI-1: createUIMessageStream/createUIMessageStreamResponse
  - `tasks/bleeding_edge/ai-sdk-5-data-parts.json` — Task A-AI-2: data parts with transient state
  - `tasks/bleeding_edge/ai-sdk-4-sync-stream-text.json` — Task A-AI-3: streamText without await in v4
  - `tasks/bleeding_edge/trpc-11-transformer-link.json` — Task A-TR-1: transformer in link config
  - `tasks/bleeding_edge/trpc-11-sse-subscriptions.json` — Task A-TR-2: SSE subscriptions with httpSubscriptionLink
  - `tasks/bleeding_edge/trpc-11-shorthand-streaming.json` — Task A-TR-3: shorthand router + streaming query
  - `tasks/bleeding_edge/zod-4-top-level-validators.json` — Task A-ZD-1: z.email(), z.url(), z.uuid(), z.ipv4()
  - `tasks/bleeding_edge/zod-4-error-api.json` — Task A-ZD-2: error customization API overhaul
- All 14 bleeding-edge tasks load successfully via the task loader (17 total tasks including version-locked pilot tasks)
- All rubric criteria weights sum to exactly 1.00 for every task
- All reference solutions pass 100% of their AST checks (verified with validation script)
- Fixed AST checker `async_generator` check to also detect `FunctionExpression` nodes (e.g., `async function*()` used as a callback argument to `.query()` or `.subscription()`)
- Adjusted `call_exists` patterns for method calls: `toDataStreamResponse` → `result.toDataStreamResponse`, `toUIMessageStream` → `result.toUIMessageStream` (AST checker matches dotted property access calls correctly)
- Created `scripts/validate-bleeding-edge-tasks.ts` comprehensive validation script
- Verified: `bun test` (281 tests pass, 0 fail), `bun run typecheck` passes, `bun run lint` clean

### Files Changed

- `tasks/bleeding_edge/nextjs-16-enforced-async.json` — New task: Next.js 16 enforced async APIs
- `tasks/bleeding_edge/nextjs-16-cache-components.json` — New task: Next.js 16 cache components
- `tasks/bleeding_edge/react-19-form-actions.json` — New task: React 19 form actions
- `tasks/bleeding_edge/react-19-ref-as-prop.json` — New task: React 19 ref as prop
- `tasks/bleeding_edge/ai-sdk-5-ui-message-stream.json` — New task: AI SDK v5 UIMessageStream
- `tasks/bleeding_edge/ai-sdk-5-data-parts.json` — New task: AI SDK v5 data parts
- `tasks/bleeding_edge/ai-sdk-4-sync-stream-text.json` — New task: AI SDK v4 sync streamText
- `tasks/bleeding_edge/trpc-11-transformer-link.json` — New task: tRPC v11 transformer in link
- `tasks/bleeding_edge/trpc-11-sse-subscriptions.json` — New task: tRPC v11 SSE subscriptions
- `tasks/bleeding_edge/trpc-11-shorthand-streaming.json` — New task: tRPC v11 shorthand streaming
- `tasks/bleeding_edge/zod-4-top-level-validators.json` — New task: Zod v4 top-level validators
- `tasks/bleeding_edge/zod-4-error-api.json` — New task: Zod v4 error API
- `src/tests/ast-checker.ts` — Fixed async_generator check to handle FunctionExpression nodes
- `scripts/validate-bleeding-edge-tasks.ts` — New validation script for all bleeding-edge tasks

### Decisions

- For `call_exists` checks on method calls like `result.toDataStreamResponse()`, the AST check pattern must use the full dotted path `result.toDataStreamResponse` — the checker matches property access calls with the object.method pattern
- Multi-file tasks (nextjs-16-enforced-async, nextjs-16-cache-components) use the `file` field on AST checks to specify which file each check applies to (e.g., `"file": "page.tsx"` or `"file": "default.tsx"`)
- Fixed the AST checker's `async_generator` check to also scan `FunctionExpression` nodes — this was needed because `async function*()` used as a callback argument (e.g., inside `.query()` or `.subscription()`) creates a FunctionExpression, not a FunctionDeclaration or MethodDeclaration
- Task content (prompts, reference solutions, test specs, rubrics, common hallucinations) was copied verbatim from BENCHMARK.md Section 4.1 to ensure consistency
- All tasks use `"type_check": false` as the type checking is validated separately in the typecheck-envs

### Notes for Future Agent

- All 14 bleeding-edge tasks are complete. The next tasks to create are version-locked-write (task 13, 12 remaining) and version-locked-audit (task 14, 8 remaining)
- The `call_exists` check for method calls requires the dotted pattern: use `result.toDataStreamResponse` not just `toDataStreamResponse`. The same applies to `writer.merge`, `writer.write`, etc.
- Multi-file reference solutions use `// filename` comment markers to separate files. The evaluator's multi-file handling (from task 10) will route AST checks to the correct file using the `file` field
- The `async_generator` check now handles 3 node types: FunctionDeclaration, MethodDeclaration, and FunctionExpression — this covers all patterns used across the 40 benchmark tasks
- The validation script `scripts/validate-bleeding-edge-tasks.ts` can be used as a template for validating version-locked tasks in tasks 13 and 14
- When creating version-locked tasks, remember to include the `context` field with `package_json` showing the pinned library version

---

## Task: Author all remaining Version-Locked Write task JSON files (12 remaining after 2 pilot tasks)

### Completed

- Created all 12 remaining version-locked-write task JSON files:
  - `tasks/version_locked_write/nextjs-14-direct-params.json` — Task B1-NX-2: direct params/searchParams access in v14 (no await, no Promise types)
  - `tasks/version_locked_write/nextjs-15-middleware-ts.json` — Task B1-NX-3: middleware.ts (not proxy.ts) in v15
  - `tasks/version_locked_write/react-17-data-fetching.json` — Task B1-RX-1: useEffect data fetching in v17 (no use(), no useTransition, no Suspense)
  - `tasks/version_locked_write/react-18-forward-ref.json` — Task B1-RX-3: forwardRef in React 18 (not ref as prop)
  - `tasks/version_locked_write/ai-sdk-3-async-stream.json` — Task B1-AI-1: experimental_streamText with await in v3
  - `tasks/version_locked_write/ai-sdk-3-type-names.json` — Task B1-AI-2: ExperimentalMessage, TokenUsage v3 type names
  - `tasks/version_locked_write/trpc-10-client-transformer.json` — Task B1-TR-1: client-level transformer in v10 (createTRPCProxyClient, not createTRPCClient)
  - `tasks/version_locked_write/trpc-10-middleware-raw-input.json` — Task B1-TR-2: rawInput (not getRawInput) in v10 middleware
  - `tasks/version_locked_write/trpc-10-ssg-helpers.json` — Task B1-TR-3: createProxySSGHelpers in v10 (not createSSGHelpers)
  - `tasks/version_locked_write/zod-3-chained-validators.json` — Task B1-ZD-1: z.string().email(), z.string().url(), etc. (not z.email())
  - `tasks/version_locked_write/zod-3-error-message.json` — Task B1-ZD-2: required_error, invalid_type_error, message param (not error)
  - `tasks/version_locked_write/zod-3-record-single-arg.json` — Task B1-ZD-3: z.record(z.string()) single argument
- All 14 version-locked-write tasks load successfully via the task loader (29 total tasks loaded)
- All rubric criteria weights sum to exactly 1.00 for every task
- All tasks have `context.package_json` with pinned library versions
- All reference solutions pass 100% of their AST checks (verified with validation script)
- Fixed AST checker `await_present` and `await_absent` to handle CallExpressions with arguments — previously only matched calls with empty parens `()`, now also extracts the callee name from calls with argument bodies like `experimental_streamText({...})`
- Created `scripts/validate-version-locked-write-tasks.ts` comprehensive validation script
- Re-validated bleeding-edge tasks still pass after the AST checker fix
- Verified: `bun test` (281 tests pass, 0 fail), `bun run typecheck` passes, `bun run lint` clean

### Files Changed

- `tasks/version_locked_write/nextjs-14-direct-params.json` — New task: Next.js 14 direct params
- `tasks/version_locked_write/nextjs-15-middleware-ts.json` — New task: Next.js 15 middleware.ts
- `tasks/version_locked_write/react-17-data-fetching.json` — New task: React 17 useEffect data fetching
- `tasks/version_locked_write/react-18-forward-ref.json` — New task: React 18 forwardRef
- `tasks/version_locked_write/ai-sdk-3-async-stream.json` — New task: AI SDK v3 async streamText
- `tasks/version_locked_write/ai-sdk-3-type-names.json` — New task: AI SDK v3 type names
- `tasks/version_locked_write/trpc-10-client-transformer.json` — New task: tRPC v10 client transformer
- `tasks/version_locked_write/trpc-10-middleware-raw-input.json` — New task: tRPC v10 rawInput middleware
- `tasks/version_locked_write/trpc-10-ssg-helpers.json` — New task: tRPC v10 SSG helpers
- `tasks/version_locked_write/zod-3-chained-validators.json` — New task: Zod v3 chained validators
- `tasks/version_locked_write/zod-3-error-message.json` — New task: Zod v3 error message API
- `tasks/version_locked_write/zod-3-record-single-arg.json` — New task: Zod v3 record single arg
- `src/tests/ast-checker.ts` — Fixed await_present/await_absent to handle CallExpressions with arguments
- `scripts/validate-version-locked-write-tasks.ts` — New validation script

### Decisions

- All version-locked tasks include `context.package_json` with exact pinned versions matching the typecheck-envs — this simulates a real project workspace where the agent can see which version is in use
- For the trpc-10-client-transformer task, used `property_location` check to verify `transformer` is inside `createTRPCProxyClient()` (not inside `httpBatchLink()`) — this is the inverse of the bleeding-edge trpc-11-transformer-link task
- For the zod-3-error-message task, used `property_absent` without `inObject` to check ALL object literals in the file for absence of `error` property — this catches both the schema-level and method-level v4 patterns
- Fixed the AST checker's `await_present` and `await_absent` handlers to also check the callee expression of CallExpressions. Previously, `matchesCallPattern` only worked when the full expression text exactly matched (e.g., `cookies()` → `cookies`), but failed for calls with argument bodies (e.g., `experimental_streamText({...})` wouldn't match `experimental_streamText`). The fix extracts the callee using `expression.getExpression().getText()` for CallExpression nodes.
- Task content (prompts, reference solutions, test specs, rubrics, common hallucinations) was adapted from BENCHMARK.md Section 4.2 with adjustments to fit the existing JSON schema structure

### Notes for Future Agent

- All 14 version-locked-write tasks are complete. The next task to create is version-locked-audit (task 14, 8 remaining after 1 pilot task)
- The `await_present`/`await_absent` fix now handles 3 patterns: (1) exact match on full expression text, (2) match after stripping trailing `()`, (3) match on the callee of a CallExpression. This covers `await foo`, `await foo()`, and `await foo({...})`
- The `property_location` check for tRPC v10 client-transformer verifies `transformer` is inside `createTRPCProxyClient()` (client level), which is the opposite of the v11 check where it's inside `httpBatchLink()` (link level)
- The validation script `scripts/validate-version-locked-write-tasks.ts` follows the same pattern as the bleeding-edge validation script and also checks for `context.package_json` presence
- When creating version-locked-audit tasks (task 14), note that audit tasks have `test_spec.ast_checks` as an empty array and rely entirely on the LLM judge
- The `call_absent` for method calls uses dotted pattern (e.g., `result.toDataStreamResponse`) — same convention established in the bleeding-edge tasks
