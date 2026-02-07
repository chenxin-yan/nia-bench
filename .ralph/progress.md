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
