# Nia-Bench

A version-aware code generation benchmark that measures how well context-augmentation tools help LLM-based coding agents generate **version-correct** code across JavaScript/TypeScript libraries.

## Motivation

LLMs have knowledge cutoffs and can hallucinate APIs that don't exist, use deprecated patterns, or mix features from different library versions. Context tools like [Nia](https://www.trynia.ai/) and [Context7](https://github.com/upstash/context7) aim to solve this by giving agents access to up-to-date, version-specific documentation.

Nia-Bench tests a core thesis: **context tools should help agents write correct code not just for bleeding-edge features (released after training cutoff), but also for specific legacy versions** — avoiding both hallucinated new APIs and deprecated old ones.

## Three Test Conditions

| Condition    | Description                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------- |
| **Baseline** | Claude Sonnet 4 with no external context tools. Relies purely on training data.                     |
| **Context7** | Claude Sonnet 4 + Context7 MCP server (`resolve-library-id` -> `query-docs`).                       |
| **Nia**      | Claude Sonnet 4 + Nia skills (full toolset: `search`, `nia_read`, `nia_grep`, `nia_explore`, etc.). |

## Task Design

**40 tasks** across 5 libraries, split into 3 categories:

| Category                      | Count | Description                                                |
| ----------------------------- | ----- | ---------------------------------------------------------- |
| **Bleeding-Edge (A)**         | 14    | Use the latest features from post-training-cutoff releases |
| **Version-Locked Write (B1)** | 14    | Write code correct for a specific older version            |
| **Version-Locked Audit (B2)** | 12    | Identify and fix version-incorrect code                    |

### Target Libraries

| Library           | Versions       | Key Breaking Changes                                                         |
| ----------------- | -------------- | ---------------------------------------------------------------------------- |
| **Next.js**       | 13, 14, 15, 16 | `middleware.ts` -> `proxy.ts`, enforced async APIs, cache components         |
| **React**         | 17, 18, 19     | `use()` hook, `useActionState`, `ref` as prop, removed `ReactDOM.render`     |
| **Vercel AI SDK** | 3, 4, 5        | `experimental_` prefix removal, DataStream -> UIMessageStream, sync vs async |
| **tRPC**          | 10, 11         | Transformer location, SSE subscriptions, shorthand router                    |
| **Zod**           | 3, 4           | Error API overhaul, string validators to top-level, `z.record()` changes     |

## Evaluation Pipeline

Each generated code sample goes through a multi-stage evaluation:

1. **AST Checks** — Structural validation using [ts-morph](https://github.com/dsherret/ts-morph) (import presence/absence, exported functions, call expressions, directives, etc.)
2. **Hallucination Classification** — Map failures to categories: `invented_method`, `wrong_parameter`, `outdated_api`, `future_api`, `wrong_import_path`, `version_mismatch`
3. **LLM Judge Scoring** — Rubric-based evaluation via OpenRouter API using GPT-5 mini

**Final Score** = `0.6 * testScore + 0.4 * judgeScore`

A task is considered **passed** when `finalScore >= 0.8`.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) (v1.1+) runtime
- [OpenCode CLI](https://github.com/opencode-ai/opencode) installed and available on PATH
- An [OpenRouter](https://openrouter.ai/) API key (for LLM judge evaluation)
- A [Context7](https://context7.com/) API key
- A [Nia](https://www.trynia.ai/) API key

### Setup

```bash
# 1. Clone the repository
git clone https://github.com/chenxin-yan/nia-bench.git
cd nia-bench

# 2. Install project dependencies
bun install

# 3. Set up environment variables
cp .env.example .env
```

Then edit `.env` and fill in your API keys:

```env
OPENROUTER_API_KEY=sk-or-...    # Required — used by the LLM judge
CONTEXT7_API_KEY=...             # Required for the Context7 condition
NIA_API_KEY=...                  # Required for the Nia condition
```

### Verify Setup

```bash
# Run type checking (should pass with no errors)
bun run check:types

# Run the test suite
bun test

# Validate all task definitions
bun run scripts/validate-bleeding-edge-tasks.ts
bun run scripts/validate-version-locked-write-tasks.ts
bun run scripts/validate-version-locked-audit-tasks.ts
```

### Run the Benchmark

```bash
# Full benchmark (40 tasks x 3 conditions x 3 reps = 360 items)
bun run bench

# Dry run — print execution plan without running
bun run bench -- --dry-run

# Run a specific subset
bun run bench -- --library next --condition nia --reps 2

# Skip judge for faster iteration
bun run bench -- --skip-judge

# Run a quick subset (10 tasks, stratified by category)
bun run bench -- --limit 10 --seed 42

# Parallel execution
bun run bench -- --parallel 4

# Generate report from existing results
bun run bench -- --report-only --output-dir results/<timestamp>
```

### CLI Flags

```
--category <cat>        Filter: bleeding_edge | version_locked_write | version_locked_audit
--library <lib>         Filter: next | react | ai | trpc | zod
--task <id>             Filter: single task ID
--condition <cond>      Filter: baseline | context7 | nia
--reps <n>              Repetitions per task/condition (default: 3)
--parallel <n>          Concurrent workers (default: 1)
--limit <n>             Max tasks to run, stratified proportionally by category
--max-retries <n>       Retries per agent on non-zero exit (default: 3)
--skip-judge            Disable LLM judge evaluation
--skip-nia-setup        Skip the Nia pre-indexing setup phase
--skip-artifacts        Skip storing transcript, tool calls, and workdir snapshots
--keep-workdirs         Keep temp working directories for debugging
--timeout <ms>          Per-agent timeout (default: 300000)
--seed <n>              Random seed for reproducible execution order
--dry-run               Print execution plan without running
--report-only           Generate report from existing results
--output-dir <dir>      Output directory (default: results/)
--tasks-dir <dir>       Tasks directory (default: tasks/)
--model <id>            Override model (provider/model format)
```

## Nia Setup Phase

When the `nia` condition is included, the benchmark automatically runs a **pre-indexing setup phase** before task execution. This ensures all required documentation sites and GitHub repositories are indexed in Nia so the agent has version-accurate context available during generation.

The setup phase:

1. Derives required sources from the task list (maps each `library:majorVersion` to specific repo tags and doc sites)
2. Checks which sources are already indexed via the Nia API
3. Starts indexing any missing sources (with configurable concurrency)
4. Polls until all indexing completes (default timeout: 10 minutes)

Use `--skip-nia-setup` to bypass this phase if sources are already indexed.

## Task Retry

Agent executions that exit with a non-zero exit code are automatically retried up to `--max-retries` times (default: 3). Each retry uses a fresh sandboxed HOME and working directory to avoid leftover state. The `attempts` count is recorded in each result for analysis.

## Stratified Sampling (`--limit`)

The `--limit <n>` flag selects a subset of tasks while preserving proportional category representation using the **largest-remainder method** (Hamilton method). Combined with `--seed`, this produces reproducible subsets — useful for quick iteration or CI smoke tests.

```bash
# Run 10 tasks with proportional category distribution
bun run bench -- --limit 10 --seed 42
```

## Development

```bash
# Run unit tests
bun test

# Type check
bun run check:types

# Lint and format
bun run check

# Validate all task definitions
bun run scripts/validate-bleeding-edge-tasks.ts
bun run scripts/validate-version-locked-write-tasks.ts
bun run scripts/validate-version-locked-audit-tasks.ts
```

## Documentation

- **[`docs/BENCHMARK.md`](docs/BENCHMARK.md)** — Full task specification with all 40 tasks, prompts, reference solutions, and evaluation criteria
- **[`docs/OVERVIEW.md`](docs/OVERVIEW.md)** — Architecture deep-dive covering the complete execution pipeline

## License

[MIT](LICENSE)
