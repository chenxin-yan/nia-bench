# AGENTS.md — Development Guide for Agentic Coding

This document provides essential information for automated coding agents operating in the nia-bench repository.

## Project Overview

**nia-bench** is a version-aware code generation benchmark that measures how well context-augmentation tools help LLM-based coding agents generate version-correct code across JavaScript/TypeScript libraries (Next.js, React, Vercel AI SDK, tRPC, Zod).

The codebase evaluates generated code through:
- AST checks (using ts-morph)
- Type checking (tsc in version-specific environments)
- Hallucination classification (invented APIs, deprecated patterns, version mismatches)
- LLM-based rubric scoring (OpenRouter API)

## Build, Lint & Test Commands

### Development Setup
```bash
# Install dependencies (uses bun)
bun install

# Install TypeScript (peer dependency)
bun add -D typescript
```

### Type Checking
```bash
# Check TypeScript types (no emit)
bun run check:types

# Or directly with tsc
tsc --noEmit
```

### Code Quality
```bash
# Run Biome formatter and linter checks
bun run check

# Fix formatting and lint issues (if Biome supports fix)
biome check . --fix
```

### Testing
```bash
# Run all tests
bun test

# Run a single test file
bun test src/types/__tests__/reference.test.ts

# Run tests matching a pattern
bun test --grep "pattern"
```

### Running the Benchmark
```bash
# Run the main benchmark
bun run bench

# With optional CLI arguments (see src/runner/orchestrator.ts for options)
bun run src/index.ts [args]
```

## Code Style Guidelines

### Imports & Module Organization

**Import Order** (enforced by Biome):
1. Node.js built-in modules (`node:*`)
2. Third-party packages
3. Internal imports (using `@/` path alias)
4. Type imports

```typescript
// ✅ Correct
import { readFile } from "node:fs/promises";
import type { VersionApiSurface } from "@/types/reference";
import { TaskSchema } from "@/types/task";

// ❌ Avoid
import { readFile } from "fs/promises";
import type { VersionApiSurface } from "../types/reference";
```

**Path Aliases:**
- Use `@/*` to reference files from `src/*` directory
- Example: `import { TaskSchema } from "@/types/task"`

### Formatting

- **Indentation:** Tab characters (not spaces)
- **Quote Style:** Double quotes (`"string"` not `'string'`)
- **Line Endings:** LF (handled by .gitignore)
- **Auto-formatting:** Run `bun run check` with `--fix` flag or rely on Biome

### Type System & TypeScript

- **Strict Mode:** Enabled (`"strict": true` in tsconfig.json)
- **Module Syntax:** Use `type` keyword for type-only imports
- **Target:** ES2022 with module preservation
- **Path Mapping:** Configure in tsconfig.json under `"paths"`

```typescript
// ✅ Correct
import type { Task } from "@/types/task";
export interface TaskResult {
  success: boolean;
  error?: string;
}

// ❌ Avoid
import { Task } from "@/types/task";  // missing 'type' keyword
```

### Naming Conventions

- **Files:** kebab-case (e.g., `task-loader.ts`, `hallucination-classifier.ts`)
- **Directories:** kebab-case (e.g., `/src/types`, `/src/loader`, `/src/tests`)
- **Interfaces/Types:** PascalCase with `I` prefix optional (e.g., `TaskResult`, `JudgeResult`)
- **Constants:** UPPER_SNAKE_CASE for module-level constants
- **Functions:** camelCase (e.g., `loadAllReferenceFiles()`, `buildJudgePrompt()`)
- **Classes:** PascalCase (e.g., `TaskLoader`)

### Validation & Error Handling

**Use Zod for Schema Validation:**
- Define schemas in `src/types/` (e.g., `TaskSchema`, `VersionApiSurfaceSchema`)
- Use `.safeParse()` for runtime validation and graceful error handling
- Return structured error results instead of throwing when validating untrusted input

```typescript
// ✅ Correct
const parseResult = VersionApiSurfaceSchema.safeParse(data);
if (!parseResult.success) {
  return { success: false, error: parseResult.error };
}
const validated = parseResult.data;

// ⚠️ Acceptable for critical errors
if (!value) throw new Error("Required field missing");
```

**Error Handling in Async Code:**
- Use try-catch for async operations
- Return `{ error: string }` structures for non-fatal errors
- Chain errors with context: `new Error(\`Failed to load: ${path}\`, { cause: err })`
- Main entry point catches fatal errors and exits gracefully

### Function Signatures & Documentation

- Prefer explicit return types
- Use JSDoc comments for complex functions and modules
- Export interfaces at module scope

```typescript
// ✅ Correct
/**
 * Loads and parses all reference API surface files
 * @returns Array of parsed reference definitions
 */
export async function loadAllReferenceFiles(): Promise<
  { path: string; data: VersionApiSurface }[]
> {
  // implementation
}
```

### Module Structure

- Organize related functionality into modules under `/src`
- Each module should have an `index.ts` as public API
- Use `__tests__` subdirectories for test files (collocated with source)
- Keep exports organized: types first, then functions/classes

```
src/
  types/
    task.ts
    reference.ts
    __tests__/
      reference.test.ts
  loader/
    index.ts
    task-loader.ts
    __tests__/
      task-loader.test.ts
  tests/
    ast-checker.ts
    type-checker.ts
    __tests__/
      ast-checker.test.ts
```

## Configuration Files Reference

- **tsconfig.json** — TypeScript compiler options (strict, ES2022 target, path aliases)
- **biome.json** — Code formatter & linter (tabs, double quotes, organizeImports)
- **package.json** — Scripts, dependencies (openai, ts-morph, zod), dev tools
- **.gitignore** — Excludes `node_modules/`, `results/*/`, `typecheck-envs/*/node_modules`, `.env`

## Key Dependencies

- **ts-morph** — AST manipulation and code analysis
- **zod** — Runtime type validation and schema definitions
- **openai** — OpenAI API client (for judge integration via OpenRouter)
- **@biomejs/biome** — Formatter and linter (dev)
- **@types/bun** — Bun runtime type definitions (dev)

## Important Notes for Agents

1. **Always run type checking** after modifications: `bun run check:types`
2. **Format before committing:** Ensure Biome passes via `bun run check`
3. **Tests are collocated:** Look in `__tests__/` subdirectories adjacent to source files
4. **Node.js imports:** Use `node:` prefix (e.g., `node:fs/promises`) for built-in modules
5. **Schema validation:** Use Zod schemas for external/untrusted data validation
6. **Error handling:** Distinguish between fatal errors (throw) and recoverable errors (return error objects)
7. **Environment variables:** Use `.env` file (excluded from git, see `.env.example`)
