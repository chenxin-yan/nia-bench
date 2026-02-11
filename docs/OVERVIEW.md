# Overview

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    BENCHMARK ORCHESTRATOR                    │
│                   src/runner/orchestrator.ts                  │
│  (CLI parsing, work queue generation, progress tracking)     │
└────────┬────────────────────────────────────────────────────┘
         │
    ┌────┴───────────────────────────────────┐
    ▼                                         ▼
┌──────────────────────┐          ┌──────────────────────┐
│  TASK LOADER         │          │  WORK QUEUE          │
│  (src/loader/)       │          │  & CONCURRENCY       │
│  - Loads JSON tasks  │          │  - AsyncSemaphore    │
│  - Validates schema  │          │  - Shuffle with seed │
│                      │          │  - Stratified sample │
└──────────┬───────────┘          └──────────┬───────────┘
           │                               │
           └───────────────────┬───────────┘
                               ▼
                   ┌─────────────────────────┐
                   │  NIA SETUP (optional)   │
                   │  (src/runner/           │
                   │   nia-setup.ts)         │
                   │  - Index repos & docs   │
                   │  - Poll until ready     │
                   └────────────┬────────────┘
                                │
                   ┌─────────────────────────┐
                   │  WORK ITEM EXECUTION    │
                   │  (Per condition & rep)   │
                   └────────────┬────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
    ┌─────────────┐         ┌──────────┐          ┌────────────┐
    │ AGENT       │         │EVALUATOR │          │ RESULT     │
    │ (src/runner/│         │(src/     │          │ STORE      │
    │ agent.ts)   │         │runner/)  │          │(src/runner/│
    │ - Runs      │         │- AST     │          │result-     │
    │   opencode  │         │  checks  │          │store.ts)   │
    │ - Extracts  │         │- Type    │          │- Stores    │
    │   files     │         │  check   │          │  JSON      │
    │ - Parses    │         │- Judge   │          │  results   │
    │   output    │         │  scoring │          │- Atomic    │
    │ - Retries   │         └──────────┘          │  writes    │
    │   on failure│                               └────────────┘
    └─────────────┘
                                │
                                ▼
                    ┌──────────────────────┐
                    │  REPORTER            │
                    │ (src/runner/         │
                    │  reporter.ts)        │
                    │- Aggregates results  │
                    │- Computes metrics    │
                    │- Generates reports   │
                    │- Text + JSON output  │
                    └──────────────────────┘
```

---

## Complete Workflow

### Phase 1: Initialization & Configuration

```
User runs: bun run src/index.ts [--options]
    │
    └─→ parseCliArgs()
        │
        └─→ Configuration created with:
            - Tasks directory
            - Output directory
            - Parallelization level (1-N workers)
            - Repetitions per task/condition (default: 3)
            - Max retries per agent execution (default: 3)
            - Random seed for reproducibility
            - Task limit with stratified sampling (optional)
            - Skip Nia setup flag (optional)
            - Model override (optional)
```

### Phase 2: Task Loading & Validation

```
loadTasks(tasksDir, filters)
    │
    ├─→ Scan task JSON files (37 total)
    │
    ├─→ Validate each task with TaskSchema (Zod)
    │   - Check required fields: id, category, library, prompt, etc.
    │   - Validate AST checks, rubric criteria
    │   - Validate test specifications
    │
    └─→ Return Task[] and errors[]
        (Tasks marked with "status: 'error'" are filtered out)
```

### Phase 2b: Stratified Sampling (optional)

```
If --limit N is set (and N < total tasks):

stratifiedSample(tasks, limit, rng)
    │
    ├─→ Group tasks by category
    ├─→ Compute proportional allocation (largest-remainder method)
    ├─→ Shuffle each group with seeded RNG
    └─→ Select allocated count from each group

    Example: 40 tasks with --limit 10
      bleeding_edge:         14/40 × 10 = 3.5 → 4
      version_locked_write:  14/40 × 10 = 3.5 → 3
      version_locked_audit:  12/40 × 10 = 3.0 → 3
```

### Phase 3: Work Queue Generation

```
generateWorkQueue(taskIds, conditions, reps)
    │
    ├─→ Create items for each combination:
    │   (taskId, condition, repIndex)
    │
    └─→ Example: 40 tasks × 3 conditions × 3 reps = 360 work items

    Shuffle queue with seeded RNG for reproducibility

    Example item:
    {
      taskId: "nextjs-16-proxy-ts",
      condition: "nia",
      repIndex: 0
    }
```

### Phase 3b: Nia Setup (conditional)

```
If "nia" condition is active AND --skip-nia-setup is NOT set:

ensureNiaSetup(tasks, options)
    │
    ├─→ Resolve Nia API key (env var or ~/.config/nia/api_key)
    ├─→ Derive required targets from tasks:
    │   Map (library, majorVersion) → repo tags + doc URLs
    │   Example: react:19 → [facebook/react@main, https://react.dev]
    │
    ├─→ Check status of all targets via Nia API
    │   ├─→ Already indexed → skip
    │   ├─→ Indexing in progress → wait
    │   └─→ Not indexed → start indexing
    │
    ├─→ Start indexing missing targets (parallel, concurrency-limited)
    │
    └─→ Poll until all targets reach "indexed"/"completed" status
        (default timeout: 10 minutes, poll interval: 15 seconds)
```

### Phase 4: Concurrent Execution

```
AsyncSemaphore(maxParallel=N) controls concurrency

For each work item:
  ┌────────────────────────────────────────────┐
  │ AGENT EXECUTION (agent.ts)                 │
  ├────────────────────────────────────────────┤
  │ Retries up to --max-retries times on       │
  │ non-zero exit (default: 3). Each attempt   │
  │ uses a fresh sandbox + working directory.  │
  │                                             │
  │ Per attempt:                                │
  │ 1. Create sandboxed HOME + temp workdir    │
  │ 2. Set up opencode environment              │
  │    - Select config based on condition       │
  │    - Add baseline/context7/nia MCP configs  │
  │ 3. Build prompt:                            │
  │    task.prompt + opencode system prompt     │
  │ 4. Execute opencode CLI:                    │
  │    opencode --model X --config Y <<< prompt│
  │ 5. Stream NDJSON output, parse events       │
  │ 6. Extract code files from streaming output │
  │    (Parse "tool_output" events)             │
  │ 7. Return AgentResult {                     │
  │      taskId, condition, runIndex,           │
  │      extractedFiles, rawOutput, exitCode,   │
  │      attempts...                            │
  │    }                                        │
  └────────────────────────────────────────────┘
                    │
                    ▼
  ┌────────────────────────────────────────────┐
  │ EVALUATION (evaluator.ts)                  │
  ├────────────────────────────────────────────┤
  │                                             │
  │ 1. AST CHECK PHASE (runAstChecks)          │
  │    - Parse extracted code with ts-morph    │
  │    - Execute all test_spec.ast_checks      │
  │    - Check: imports, exports, functions,   │
  │      async/await, directives, etc.         │
  │    - Result: AstCheckResult[] with pass/fail
  │                                             │
  │ 2. TYPE CHECK PHASE (optional)             │
  │    - Use appropriate typecheck-env version │
  │    - Run tsc --noEmit on extracted code    │
  │    - Detect version-specific type errors   │
  │    - Result: TypeCheckResult (pass/fail)   │
  │                                             │
  │ 3. HALLUCINATION CLASSIFICATION            │
  │    - Map AST failures to hallucination type│
  │    - Types: invented_method, wrong_param,  │
  │      outdated_api, future_api, etc.        │
  │    - Result: HallucinationResult           │
  │                                             │
  │ 4. LLM JUDGE SCORING (if !skipJudge)       │
  │    - Build judge prompt with:              │
  │      * Task description                    │
  │      * Reference solution                  │
  │      * Agent-generated code                │
  │      * Rubric criteria                     │
  │    - Call OpenRouter API (Claude Opus)     │
  │    - Parse structured JSON response        │
  │    - Score each rubric criterion (0-1)     │
  │    - Result: JudgeResult with criterion    │
  │      scores and explanations               │
  │                                             │
  │ 5. FINAL SCORE CALCULATION                 │
  │    finalScore = 0.6 × testScore            │
  │               + 0.4 × judgeScore           │
  │    where testScore = % of AST checks passed
  │                                             │
  │ 6. Return EvaluationResult {                │
  │      taskId, condition, runIndex,          │
  │      category, library, targetVersion,     │
  │      testScore, judgeScore, finalScore,    │
  │      astResults[], typeCheckResult,        │
  │      judgeResult, hallucinations,          │
  │      extractedFiles, prompt, durationMs,   │
  │      agentError, attempts,                 │
  │      toolCallCount, toolCallSummary        │
  │    }                                        │
  └────────────────────────────────────────────┘
                    │
                    ▼
  ┌────────────────────────────────────────────┐
  │ RESULT PERSISTENCE (result-store.ts)       │
  ├────────────────────────────────────────────┤
  │ Write to: results/{runDir}/{taskId}/       │
  │           {condition}/                     │
  │                                             │
  │ Files per rep:                              │
  │  - run-{repIndex}.json      (scorecard)    │
  │  - transcript-{repIndex}.ndjson (events)   │
  │  - tool-calls-{repIndex}.json (tool I/O)   │
  │  - workdir-{repIndex}/      (file snapshot)│
  │                                             │
  │ Atomic write: write to .tmp, then rename   │
  │ (prevents corruption from parallel workers)│
  │                                             │
  │ Artifacts (transcript, tool-calls, workdir)│
  │ skipped when --skip-artifacts is set.      │
  └────────────────────────────────────────────┘
```

### Phase 5: Report Generation

```
After all work items complete:

generateAndWriteReport(runDir)
    │
    ├─→ loadResults(runDir)
    │   └─→ Read all run-{index}.json files
    │       Group by taskId/condition
    │
    ├─→ computeMetrics(results)
    │   ├─→ taskPassRate: % of tasks with final_score >= 0.8
    │   ├─→ hallucinationRate: % with >= 1 hallucination
    │   ├─→ versionComplianceRate: % where ALL AST checks pass
    │   └─→ meanCombinedScore: average final_score
    │
    ├─→ Aggregate by:
    │   ├─→ Overall (all tasks, per condition)
    │   ├─→ By category (bleeding_edge, etc.)
    │   ├─→ By library (next, react, ai, trpc, zod)
    │
    ├─→ Compute hallucination distribution
    │
    ├─→ Extract per-task details
    │   └─→ Condition averages across reps
    │
    └─→ Write outputs:
        ├─→ report.json (structured data)
        ├─→ report.txt (human-readable ASCII table)
        └─→ Display on stdout
```

---

## Result Visualization & Report Generation

### Structured Report Output (JSON)

File: `results/{timestamp}/report.json`

### Human-Readable Report (ASCII Table)

File: `results/{timestamp}/report.txt`

### Metrics Explained

| Metric                      | Definition                             | Context                     |
| --------------------------- | -------------------------------------- | --------------------------- |
| **Task Pass Rate**          | % of tasks with final_score ≥ 0.8      | Overall success             |
| **Hallucination Rate**      | % of tasks with ≥1 hallucination       | False APIs, deprecated code |
| **Version Compliance Rate** | % where ALL AST checks pass            | Strict version correctness  |
| **Mean Combined Score**     | Weighted average: 0.6×test + 0.4×judge | Overall quality             |

---

## Task Categories

### Category A: Bleeding-Edge (14 tasks)

Features from latest library versions (likely post-training cutoff).

- **Next.js 16**: proxy.ts, enforced async, cache components (3)
- **React 19**: use() hook, useActionState, ref as prop (3)
- **AI SDK 5**: UIMessageStream, data parts, sync streamText (3)
- **tRPC 11**: transformer in link, SSE subscriptions, shorthand router (3)
- **Zod 4**: top-level validators, error API (2)

### Category B1: Version-Locked Write (14 tasks)

Write code correct for a _specific older version_.

- **Next.js 13**: Sync cookies/headers (3)
- **Next.js 14**: Direct params access (3)
- **Next.js 15**: middleware.ts (not proxy.ts) (1)
- **React 17**: useEffect+useState pattern (3)
- **React 18**: forwardRef required (1)
- **AI SDK 3**: await required, experimental_streamText (2)
- **tRPC 10**: Transformer at client level (1)
- **Zod 3**: Chained validators (1)

### Category B2: Version-Locked Audit (12 tasks)

Identify and fix version-incorrect code.

- Agents given code with bugs and must identify issues
- Suggest correct alternatives for target version

---

## AST Checks (Automated Testing)

Each task has a `test_spec.ast_checks[]` array with validation rules:

```typescript
// Example checks from nextjs-16-proxy-ts
[
  { type: "function_exported", name: "proxy" }, // ✓ export function proxy() {}
  { type: "function_absent", name: "middleware" }, // ✓ NOT export function middleware() {}
  { type: "call_exists", call: "config.matcher" }, // ✓ export const config = { matcher: ... }
  { type: "property_absent", property: "runtime", inObject: "config" }, // ✓ No runtime: 'edge'
];
```

### Check Types

- `import_exists`: Requires `import { X } from "module"`
- `import_absent`: Must NOT import something
- `module_import_absent`: Must NOT import entire module
- `function_exported`: Must export named function
- `function_absent`: Must NOT export named function
- `await_present`: Must `await` a specific call
- `await_absent`: Must NOT `await` something
- `call_exists`: Must call a specific function
- `call_absent`: Must NOT call something
- `directive_present`: Must have directive (e.g., `'use server'`)
- `property_location`: Property must be in specific object
- `property_absent`: Property must NOT be in specific object
- `async_function`: Function must be async
- `async_generator`: Function must be async generator
- `yield_present`: Function must contain a yield expression
- `type_annotation`: Check for specific type annotations

---

## LLM Judge Scoring

For tasks where automated AST checks alone aren't sufficient.

**Process:**

1. **Prompt Building** (prompt-template.ts):

   ```
   - Task description
   - Reference solution
   - Provided code
   - Rubric criteria (weighted)
   - Instruction: Score 0-1 per criterion
   ```

2. **API Call** (openrouter-client.ts):
   - Calls OpenRouter API
   - Parses JSON response with criterion scores
   - Handles retries & timeouts

3. **Score Aggregation**:

   ```
   judgeScore = average(criterion_scores)
   finalScore = 0.6 × testScore + 0.4 × judgeScore
   ```

````

---

## Hallucination Classification

Maps failures to specific error categories:

```typescript
type HallucinationType =
  | "invented_method" // Method that doesn't exist (e.g., z.string().ip())
  | "wrong_parameter" // Wrong param name or type
  | "outdated_api" // Using old API from earlier version
  | "future_api" // Using API from newer version
  | "wrong_import_path" // Importing from wrong module
  | "version_mismatch"; // General version incompatibility
````

**Classification Logic:**

1. For each failed AST check → map to hallucination type
2. Infer direction (older/newer) based on task metadata
3. Cross-reference with `common_hallucinations` hints
4. Aggregate into HallucinationResult
