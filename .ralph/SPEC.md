# Nia-Bench

> A benchmark measuring how context-augmentation tools improve coding agents' version-correct code generation across JavaScript/TypeScript library versions.

## Overview

Nia-Bench evaluates whether context tools (like Nia and Context7) help coding agents generate **version-correct** code when working with real-world JavaScript/TypeScript libraries. LLMs have knowledge cutoffs and frequently hallucinate APIs — using deprecated patterns, inventing methods, or mixing features from different library versions. Context tools aim to solve this by providing agents with up-to-date, version-specific documentation.

The benchmark tests 40 tasks across 5 libraries (Next.js, React, Vercel AI SDK, tRPC, Zod), comparing three conditions: a **baseline** (no context tools), **Context7** (resolve-library-id + query-docs), and **Nia** (full toolset including search, read, grep, explore). Each task targets a specific library version and is evaluated through automated AST-based tests (60% weight) and an LLM judge with structured rubrics (40% weight).

The core thesis: context tools should help agents write correct code not just for bleeding-edge features released after the training cutoff, but also for specific legacy versions — avoiding both hallucinated new APIs and deprecated old ones.

## Scope

### Included

- **40 benchmark tasks** across three categories: Bleeding-Edge API (14), Version-Locked Write (14), Version-Locked Audit (12)
- **Benchmark runner** that orchestrates task execution across three conditions (Baseline, Context7, Nia) using opencode CLI in non-interactive mode
- **AST-based automated test engine** for programmatic assertion checking (imports, function calls, await patterns, banned APIs)
- **LLM judge module** using structured pointwise rubric evaluation via OpenRouter API (GPT-5 Mini as judge model)
- **Hallucination classifier** that categorizes failure modes (invented_method, wrong_parameter, outdated_api, future_api, wrong_import_path, version_mismatch)
- **Results reporter** generating comparison tables and per-task breakdowns
- **Version-grouped type-check environments** with pinned library versions for compile-time validation
- **Version API surface reference files** (JSON) listing valid APIs per library per version

### Excluded

- Web UI or dashboard for results visualization
- Support for non-JavaScript/TypeScript libraries
- Custom model fine-tuning or training
- Real-time / live benchmarking (this is a batch evaluation tool)
- Support for context tools beyond Baseline, Context7, and Nia (extensible later)
- Performance benchmarking (latency, token usage) — focus is on correctness only

## Technical Stack

- **Language**: TypeScript with strict mode
- **Runtime**: Bun
- **Agent Runner**: opencode CLI (`opencode -p "<prompt>" -f json`) in non-interactive mode with per-condition `.opencode.json` MCP configs
- **AST Analysis**: ts-morph (TypeScript compiler wrapper for assertion checking)
- **LLM Judge**: OpenRouter API (GPT-5 Mini for judge, temperature 0.0, 3x majority vote)
- **Type Checking**: `tsc --noEmit` against version-grouped environments
- **Task Definitions**: JSON files following a defined schema
- **Results Storage**: Flat JSON files in `results/` directory
- **Testing**: Bun's built-in test runner for internal tests

## Architecture

The system is a CLI-driven batch pipeline with four distinct phases:

1. **Task Loading** — Reads task JSON files from `tasks/` directory, validates against the task schema, and builds an execution plan. Tasks can be filtered by category, library, or ID.

2. **Agent Execution** — For each task × condition × repetition, the runner spawns opencode CLI in non-interactive mode (`opencode --cwd <tempdir> -p "<prompt>" -f json`). Each condition has a different `.opencode.json` config defining which MCP servers are available. The runner creates isolated temporary working directories per execution, injects the appropriate opencode config and task context files, and captures the JSON output. Code is extracted from both the agent's JSON response and any files the agent wrote to the temp directory.

3. **Evaluation** — Two-layer scoring runs on each extracted code sample:
   - **Layer 1 (Automated Tests, 60%)**: ts-morph-based AST checks verify imports, function signatures, await/no-await patterns, banned API absence, and structural correctness. Type checking via `tsc --noEmit` validates compilation against pinned library versions.
   - **Layer 2 (LLM Judge, 40%)**: Sends generated code + reference solution + rubric to GPT-5 Mini via OpenRouter. Each criterion is scored binary (PASS/FAIL) with evidence and reasoning. Runs 3x with majority vote per criterion.

4. **Reporting** — Aggregates scores across all runs and generates comparison tables: overall metrics, per-category breakdowns, per-library breakdowns, and hallucination type distributions.

Each phase is independent and produces intermediate JSON files, allowing re-running evaluation or reporting without re-executing agent tasks.

### Agent Sandboxing

opencode CLI in non-interactive mode **auto-approves all permissions** — the agent can read/write files and execute shell commands without restriction. There is no built-in sandbox. To mitigate risk:

- **Temp directory isolation**: Each agent execution runs in a unique temp directory (`/tmp/nia-bench/{timestamp}-{taskId}-{condition}-{rep}/`). The opencode `--cwd` flag sets this as the working directory, so all relative file operations stay within it.
- **Config injection**: The condition-specific `.opencode.json` is copied into the temp dir before execution. opencode loads config from CWD, so each execution gets the correct MCP server configuration.
- **Context injection**: For version-locked tasks with a `context` field (e.g., package.json snippets), these files are written into the temp dir before the agent runs, simulating a real project workspace.
- **Code extraction**: After execution, the runner extracts code from two sources: (1) the agent's JSON stdout response (parsing markdown code blocks), and (2) any `.ts`/`.tsx`/`.js`/`.jsx` files the agent wrote to disk in the temp dir. Files on disk are preferred when available as they tend to be more complete.
- **Cleanup**: Temp directories are removed after code extraction. A `--keep-workdirs` flag preserves them for debugging.

> **Note**: The agent can theoretically escape the temp dir via absolute paths or `../` traversal. This is accepted as a low-probability risk since Claude Sonnet rarely attempts file system escapes. For maximum security, run inside a Docker container or VM.

### Parallel Execution

The runner supports configurable parallelism via `--parallel N` (default: 1 for sequential):

- **Work queue**: All (task, condition, rep) tuples are generated and shuffled (for randomization), then placed in a shared queue.
- **Worker pool**: Up to N workers pull items from the queue concurrently. Each worker creates its own temp dir, runs opencode, evaluates the result, and stores it — fully independent.
- **No shared state**: opencode processes in different directories have no conflicts (separate SQLite DBs, config, and file systems).
- **Rate limit awareness**: The main bottleneck is the LLM provider API rate limit (Anthropic for Claude Sonnet). Users should set `--parallel` based on their API tier (e.g., `--parallel 3` for 3 concurrent Claude Sonnet requests).
- **Progress logging**: Thread-safe progress output showing `[12/333] Task: nextjs-16-proxy-ts | Condition: nia | Rep: 2/3` with a running completion tally.

## Constraints

- Agent executions use opencode's default temperature settings
- Identical prompts across all three conditions — no mention of specific tool names
- Execution order is randomized to prevent ordering bias
- Each task repeats 3x per condition for statistical stability
- LLM judge runs 3x per task with majority vote per criterion to reduce scoring variance
- Library versions are pinned via exact version specifiers in per-environment `package.json` files
- No caching between runs — each execution is independent
- opencode CLI must be installed and available on PATH
- OpenRouter API key required for LLM judge (GPT-5 Mini access)
- Provider API keys required for agent model access (configured per opencode condition)

## References

- [BENCHMARK.md](../docs/BENCHMARK.md) — Full task inventory, rubrics, test specs, and evaluation methodology
- [opencode CLI](https://github.com/opencode-ai/opencode) — Agent runner with MCP support and non-interactive mode
- [ts-morph](https://ts-morph.com/) — TypeScript compiler wrapper for AST analysis
- [OpenRouter API](https://openrouter.ai/) — LLM API gateway for judge model access
