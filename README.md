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
2. **Type Checking** — Run `tsc` in version-specific TypeScript environments with pinned library versions
3. **Hallucination Classification** — Map failures to categories: `invented_method`, `wrong_parameter`, `outdated_api`, `future_api`, `wrong_import_path`, `version_mismatch`
4. **LLM Judge Scoring** — Rubric-based evaluation via OpenRouter API using Claude Opus

**Final Score** = `0.6 * testScore + 0.4 * judgeScore`

A task is considered **passed** when `finalScore >= 0.8`.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) runtime
- [OpenCode CLI](https://github.com/opencode-ai/opencode) installed and available on PATH
- An [OpenRouter](https://openrouter.ai/) API key (for LLM judge evaluation)

### Setup

```bash
# Clone the repository
git clone https://github.com/chenxin-yan/nia-bench.git
cd nia-bench

# Install dependencies
bun install

# Set up environment
cp .env.example .env
# Edit .env and add your OPENROUTER_API_KEY
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
--skip-judge            Disable LLM judge evaluation
--keep-workdirs         Keep temp working directories for debugging
--timeout <ms>          Per-agent timeout (default: 300000)
--seed <n>              Random seed for reproducible execution order
--dry-run               Print execution plan without running
--report-only           Generate report from existing results
--output-dir <dir>      Output directory (default: results/)
--tasks-dir <dir>       Tasks directory (default: tasks/)
--model <id>            Override model (provider/model format)
```

## Sample Output

```
================================================================
                     NIA-BENCH RESULTS v1.0
================================================================
 Metric                      Baseline   Context7        Nia
----------------------------------------------------------------
 Task Pass Rate                 47.1%      60.7%      67.6%
 Hallucination Rate             50.0%      32.1%      41.2%
 Version Compliance Rate        67.6%      78.6%      70.6%
 Mean Combined Score             0.73       0.80       0.81
================================================================
 CATEGORY A: BLEEDING EDGE
 Task Pass Rate                 66.7%      75.0%      83.3%
 Hallucination Rate             91.7%      87.5%      75.0%
================================================================
 CATEGORY B1: VERSION-LOCKED WRITE
 Task Pass Rate                 58.3%      80.0%      63.6%
 Version Compliance Rate        50.0%      80.0%      63.6%
================================================================
 CATEGORY B2: VERSION-LOCKED AUDIT
 Task Pass Rate                 10.0%      30.0%      54.5%
 Mean Combined Score             0.66       0.75       0.79
================================================================
```

## Project Structure

```
nia-bench/
├── src/
│   ├── index.ts                  # Entry point
│   ├── types/                    # Task schema (Zod) and reference types
│   ├── loader/                   # Task JSON loading and validation
│   ├── runner/
│   │   ├── orchestrator.ts       # CLI parsing, work queue, concurrency
│   │   ├── agent.ts              # OpenCode agent execution
│   │   ├── evaluator.ts          # AST + type check + judge pipeline
│   │   ├── reporter.ts           # Metrics computation and report generation
│   │   ├── result-store.ts       # Atomic result persistence
│   │   └── mcp_configs/          # Per-condition OpenCode MCP configs
│   ├── judge/                    # LLM judge (rubric scoring, hallucination classification)
│   └── tests/                    # AST checker and TypeScript type checker
│
├── tasks/                        # 40 task definitions (JSON)
│   ├── bleeding_edge/            # 14 bleeding-edge tasks
│   ├── version_locked_write/     # 14 version-locked write tasks
│   └── version_locked_audit/     # 12 version-locked audit tasks
│
├── typecheck-envs/               # Isolated TypeScript environments per library version
│   ├── react-17/ ... react-19/
│   ├── next-13/ ... next-16/
│   ├── ai-sdk-3/ ... ai-sdk-5/
│   ├── trpc-10/, trpc-11/
│   └── zod-3/, zod-4/
│
├── reference/                    # Version-specific API reference data
├── results/                      # Benchmark output (generated at runtime)
├── scripts/                      # Task validation scripts
└── docs/
    ├── OVERVIEW.md               # Architecture deep-dive
    └── BENCHMARK.md              # Full task specification
```

## Results Structure

Each benchmark run produces a timestamped output directory:

```
results/<timestamp>/
├── run-meta.json                 # Run configuration and metadata
├── report.json                   # Structured report (for programmatic use)
├── report.txt                    # Human-readable ASCII table
└── <task-id>/
    └── <condition>/
        ├── run-0.json            # Per-rep evaluation result
        ├── run-1.json
        └── run-2.json
```

## Development

```bash
# Run unit tests (318 tests)
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
