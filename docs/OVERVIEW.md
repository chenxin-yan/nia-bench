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
└──────────┬───────────┘          └──────────┬───────────┘
           │                               │
           └───────────────────┬───────────┘
                               ▼
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
    └─────────────┘         └──────────┘          │  writes    │
                                                  └────────────┘
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

## 📁 Directory Structure

```
nia-bench/
├── src/
│   ├── index.ts                      # Entry point → orchestrator
│   ├── types/
│   │   ├── task.ts                   # Task schema (Zod)
│   │   └── reference.ts              # Reference solution types
│   ├── loader/
│   │   ├── task-loader.ts            # Loads & validates task JSON files
│   │   └── __tests__/
│   ├── runner/                       # Core orchestration
│   │   ├── orchestrator.ts           # Main benchmark runner
│   │   ├── agent.ts                  # OpenCode agent executor
│   │   ├── evaluator.ts              # Evaluation (AST + type check + judge)
│   │   ├── reporter.ts               # Report generation & metrics
│   │   ├── result-store.ts           # Result persistence
│   │   ├── mcp_configs/              # OpenCode configuration files
│   │   │   ├── nia.opencode.json
│   │   │   ├── context7.opencode.json
│   │   │   └── baseline.opencode.json
│   │   └── __tests__/
│   ├── judge/                        # LLM-based evaluation
│   │   ├── hallucination-classifier.ts # Classifies failure types
│   │   ├── rubric-scorer.ts          # Scores against rubric
│   │   ├── prompt-template.ts        # Judge prompts
│   │   ├── openrouter-client.ts      # LLM API calls
│   │   └── __tests__/
│   └── tests/                        # Automated code evaluation
│       ├── ast-checker.ts            # AST validation
│       ├── type-checker.ts           # TypeScript type checking
│       └── __tests__/
│
├── tasks/                            # Task definitions (40 JSON files)
│   ├── bleeding_edge/                # Category A: Latest features
│   │   ├── nextjs-16-*.json          # 3 Next.js 16 tasks
│   │   ├── react-19-*.json           # 3 React 19 tasks
│   │   ├── ai-sdk-5-*.json           # 3 AI SDK 5 tasks
│   │   ├── trpc-11-*.json            # 3 tRPC 11 tasks
│   │   └── zod-4-*.json              # 2 Zod 4 tasks
│   ├── version_locked_write/         # Category B1: Write for specific version
│   │   ├── nextjs-13-*.json
│   │   ├── nextjs-14-*.json
│   │   ├── nextjs-15-*.json
│   │   ├── react-17-*.json
│   │   ├── react-18-*.json
│   │   ├── ai-sdk-3-*.json
│   │   ├── trpc-10-*.json
│   │   └── zod-3-*.json
│   └── version_locked_audit/         # Category B2: Audit code for version
│       └── (12 audit tasks)
│
├── results/                          # Output directory (created at runtime)
│   └── {timestamp}/
│       ├── run-meta.json             # Run metadata
│       ├── report.json               # Structured report
│       ├── report.txt                # Human-readable report
│       └── {taskId}/
│           └── {condition}/
│               └── run-{index}.json  # Individual result files
│
├── typecheck-envs/                   # TypeScript environments for version testing
│   ├── react-17/
│   ├── react-18/
│   ├── react-19/
│   ├── next-13/ through next-16/
│   ├── zod-3/
│   ├── zod-4/
│   ├── ai-sdk-3/ through ai-sdk-5/
│   └── trpc-10/
│       trpc-11/
│
├── docs/
│   └── BENCHMARK.md                  # Detailed specification (1500+ lines)
│
└── scripts/                          # Validation scripts
    ├── validate-bleeding-edge-tasks.ts
    ├── validate-version-locked-write-tasks.ts
    ├── validate-version-locked-audit-tasks.ts
    └── validate-pilot-tasks.ts
```

---

## 🔄 Complete Workflow

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
            - Random seed for reproducibility
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

**Task Structure:**

```typescript
interface Task {
  id: string; // "nextjs-16-proxy-ts"
  category: "bleeding_edge" | "version_locked_write" | "version_locked_audit";
  library: "next" | "react" | "ai" | "trpc" | "zod";
  target_version: string; // "16.0.0"
  prompt: string; // The task prompt
  reference_solution: string; // Canonical correct code
  test_spec: {
    ast_checks: AstCheck[]; // Automated validation rules
    type_check: boolean; // Enable TypeScript checking
  };
  rubric: {
    criteria: RubricCriterion[]; // Judge evaluation criteria
  };
  common_hallucinations: string[]; // Known failure modes
}
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

### Phase 4: Concurrent Execution

```
AsyncSemaphore(maxParallel=N) controls concurrency

For each work item:
  ┌────────────────────────────────────────────┐
  │ AGENT EXECUTION (agent.ts)                 │
  ├────────────────────────────────────────────┤
  │ 1. Create temp working directory            │
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
  │      extractedFiles, rawOutput, exitCode... │
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
  │      testScore, judgeScore, finalScore,    │
  │      astResults[], typeCheckResult,        │
  │      judgeResult, hallucinations...        │
  │    }                                        │
  └────────────────────────────────────────────┘
                    │
                    ▼
  ┌────────────────────────────────────────────┐
  │ RESULT PERSISTENCE (result-store.ts)       │
  ├────────────────────────────────────────────┤
  │ Write to: results/{runDir}/{taskId}/       │
  │           {condition}/run-{repIndex}.json  │
  │                                             │
  │ Atomic write: write to .tmp, then rename   │
  │ (prevents corruption from parallel workers)│
  └────────────────────────────────────────────┘
```

### Phase 5: Report Generation

```
After all work items complete:

generateAndWriteReport(runDir)
    │
    ├─→ loadResults(runDir)
    │   └─→ Read all result-{index}.json files
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

## 📊 Result Visualization & Report Generation

### Structured Report Output (JSON)

File: `results/{timestamp}/report.json`

```typescript
interface Report {
  generatedAt: string                      // ISO timestamp
  resultsDir: string                       // Source directory path
  totalTasks: number                       // 40
  totalResults: number                     // e.g., 360 (40 × 3 × 3)
  conditions: string[]                     // ["baseline", "context7", "nia"]

  overall: ConditionMetrics[]              // Metrics per condition
  byCategory: {
    bleeding_edge: ConditionMetrics[]
    version_locked_write: ConditionMetrics[]
    version_locked_audit: ConditionMetrics[]
  }
  byLibrary: {
    next: ConditionMetrics[]
    react: ConditionMetrics[]
    ai: ConditionMetrics[]
    trpc: ConditionMetrics[]
    zod: ConditionMetrics[]
  }

  hallucinationDistribution: {
    baseline: HallucinationDistribution[]   // Per hallucination type
    context7: HallucinationDistribution[]
    nia: HallucinationDistribution[]
  }

  taskDetails: TaskDetail[]                // Per-task breakdown
}

interface ConditionMetrics {
  condition: string                        // "baseline", "context7", "nia"
  metrics: {
    taskPassRate: number                   // 0.0-1.0 (% tasks passing)
    hallucinationRate: number              // 0.0-1.0
    versionComplianceRate: number          // 0.0-1.0 (all AST checks pass)
    meanCombinedScore: number              // 0.0-1.0
    count: number                          // Sample size
  }
}

interface TaskDetail {
  taskId: string
  category: string
  library: string
  targetVersion: string
  conditions: {
    baseline: { avgFinalScore, avgTestScore, ... }
    context7: { ... }
    nia: { ... }
  }
}
```

### Human-Readable Report (ASCII Table)

File: `results/{timestamp}/report.txt`

Output Example:

```
================================================================
                     NIA-BENCH RESULTS v1.0
================================================================
 Metric                       Baseline    Context7        Nia
----------------------------------------------------------------
 Task Pass Rate                78.5%        82.1%       85.3%
 Hallucination Rate            12.3%         8.7%        5.2%
 Version Compliance Rate       85.0%        90.0%       93.0%
 Mean Combined Score            0.76         0.81        0.85
================================================================
 CATEGORY A: BLEEDING-EDGE TASKS
 Task Pass Rate                72.0%        80.0%       85.0%
 Hallucination Rate            20.0%        10.0%        5.0%
================================================================
 CATEGORY B1: VERSION-LOCKED WRITE
 Task Pass Rate                85.0%        90.0%       92.0%
 Version Compliance Rate       90.0%        95.0%       97.0%
...
```

### Metrics Explained

| Metric                      | Definition                             | Context                     |
| --------------------------- | -------------------------------------- | --------------------------- |
| **Task Pass Rate**          | % of tasks with final_score ≥ 0.8      | Overall success             |
| **Hallucination Rate**      | % of tasks with ≥1 hallucination       | False APIs, deprecated code |
| **Version Compliance Rate** | % where ALL AST checks pass            | Strict version correctness  |
| **Mean Combined Score**     | Weighted average: 0.6×test + 0.4×judge | Overall quality             |

---

## 🎯 Task Categories

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

## 🔍 AST Checks (Automated Testing)

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
- `async_function`: Function must be async
- `async_generator`: Function must be async generator
- `string_literal_check`: Check for literal strings in code

---

## 🤖 LLM Judge Scoring

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
   - Calls OpenRouter API with Claude Opus
   - Parses JSON response with criterion scores
   - Handles retries & timeouts

3. **Score Aggregation**:

   ```
   judgeScore = average(criterion_scores)
   finalScore = 0.6 × testScore + 0.4 × judgeScore
   ```

**Rubric Example** (nextjs-16-proxy-ts):

```json
{
  "criteria": [
    {
      "name": "proxy_filename",
      "weight": 0.25,
      "description": "File is proxy.ts, not middleware.ts"
    },
    {
      "name": "proxy_function_name",
      "weight": 0.25,
      "description": "Exports function proxy()"
    },
    {
      "name": "no_edge_runtime",
      "weight": 0.15,
      "description": "No runtime: 'edge' in config"
    },
    {
      "name": "correct_api_usage",
      "weight": 0.2,
      "description": "Correct NextResponse, cookies, redirects"
    },
    {
      "name": "no_hallucination",
      "weight": 0.15,
      "description": "No v15 patterns, no invented APIs"
    }
  ]
}
```

---

## 🐛 Hallucination Classification

Maps failures to specific error categories:

```typescript
type HallucinationType =
  | "invented_method" // Method that doesn't exist (e.g., z.string().ip())
  | "wrong_parameter" // Wrong param name or type
  | "outdated_api" // Using old API from earlier version
  | "future_api" // Using API from newer version
  | "wrong_import_path" // Importing from wrong module
  | "version_mismatch"; // General version incompatibility
```

**Classification Logic:**

1. For each failed AST check → map to hallucination type
2. Infer direction (older/newer) based on task metadata
3. Cross-reference with `common_hallucinations` hints
4. Aggregate into HallucinationResult

---

## 📦 Key Dependencies

- **ts-morph** (v27.0.2): AST parsing and manipulation for code validation
- **zod** (v4.3.6): Runtime schema validation for task definitions
- **openai** (v6.18.0): OpenRouter API calls for LLM judge
- **bun**: Runtime and package manager
- **TypeScript** (v5): Type safety
- **Biome** (v2.3.14): Code formatting & linting

---

## 🚀 Running the Benchmark

### Basic Run

```bash
bun run src/index.ts
# Runs all 40 tasks × 3 conditions × 3 reps = 360 items
# Uses 1 worker (sequential)
# Results written to results/{timestamp}/
```

### With Options

```bash
# Run only Next.js 16 tasks with Nia condition, 2 reps, 4 workers
bun run src/index.ts \
  --library next \
  --task nextjs-16-proxy-ts \
  --condition nia \
  --reps 2 \
  --parallel 4

# Dry run: print execution plan without running
bun run src/index.ts --dry-run

# Skip judge evaluation (faster for iteration)
bun run src/index.ts --skip-judge

# Override model (use different Claude version)
bun run src/index.ts --model anthropic/claude-opus-4-1-20250805

# Generate report from existing results
bun run src/index.ts --report-only --output-dir results/{timestamp}
```

### CLI Flags

```
--category <cat>        Filter: bleeding_edge | version_locked_write | version_locked_audit
--library <lib>         Filter: next | react | ai | trpc | zod
--task <id>             Filter: single task ID
--condition <cond>      Filter: baseline | context7 | nia
--reps <n>              Repetitions per task (default: 3)
--parallel <n>          Worker threads (default: 1)
--skip-judge            Disable LLM judge (faster)
--keep-workdirs         Keep temp working directories (for debugging)
--timeout <ms>          Per-agent timeout (default: 300000)
--seed <n>              Random seed for work queue shuffle (reproducible order)
--dry-run               Print plan without executing
--eval-only             Re-run evaluation on existing results (partial support)
--report-only           Generate report from existing results
--output-dir <dir>      Results directory (default: results/)
--tasks-dir <dir>       Tasks directory (default: tasks/)
--model <id>            Model override (provider/model format)
```

---

## 📝 Result File Structure

```
results/
└── 2025-02-09T02-22-33-456Z/
    ├── run-meta.json
    │   {
    │     "startTime": "2025-02-09T02:22:33.456Z",
    │     "endTime": "2025-02-09T03:15:44.123Z",
    │     "totalTasks": 40,
    │     "conditions": ["baseline", "context7", "nia"],
    │     "reps": 3,
    │     "parallel": 4,
    │     "seed": 12345,
    │     "status": "completed",
    │     "completedItems": 360,
    │     "totalItems": 360
    │   }
    ├── report.json          # Structured report (for parsing)
    ├── report.txt           # Human-readable ASCII table
    │
    ├── nextjs-16-proxy-ts/
    │   ├── baseline/
    │   │   ├── run-0.json   # Rep 0 result
    │   │   ├── run-1.json   # Rep 1 result
    │   │   └── run-2.json   # Rep 2 result
    │   ├── context7/
    │   │   └── run-*.json
    │   └── nia/
    │       └── run-*.json
    │
    ├── nextjs-16-enforced-async/
    │   └── ...
    │
    └── [38 more task directories]
```

### Individual Result File (`run-X.json`)

```typescript
{
  taskId: "nextjs-16-proxy-ts",
  condition: "nia",
  runIndex: 0,
  testScore: 0.95,                    // % AST checks passed
  judgeScore: 0.88,                   // Judge's evaluation
  finalScore: 0.922,                  // 0.6×0.95 + 0.4×0.88
  astResults: [                       // One per check
    {
      check: { type: "function_exported", name: "proxy" },
      passed: true,
      message: "Found function export: proxy"
    },
    ...
  ],
  typeCheckResult: {                  // If enabled
    passed: true,
    errors: []
  },
  judgeResult: {
    criterion_scores: {
      proxy_filename: 1.0,
      proxy_function_name: 1.0,
      no_edge_runtime: 1.0,
      correct_api_usage: 0.75,
      no_hallucination: 0.5
    },
    explanations: { ... }
  },
  hallucinations: {
    types: ["wrong_parameter"],       // Classification
    details: [
      {
        type: "wrong_parameter",
        evidence: "...",
        description: "..."
      }
    ]
  },
  extractedFiles: {
    "proxy.ts": "export function proxy(request) { ... }"
  }
}
```

---

## 🔧 Key Classes & Functions

### Orchestrator (orchestrator.ts)

- `parseCliArgs(argv)`: Parse command-line arguments
- `generateWorkQueue(taskIds, conditions, reps)`: Create work items
- `runBenchmark(config)`: Main entry point
- `ProgressLogger`: Tracks completion + ETA
- `AsyncSemaphore`: Concurrency control

### Agent (agent.ts)

- `runAgent(task, condition, repIndex)`: Execute OpenCode
- `checkOpencodeBinary()`: Verify opencode CLI is installed
- `extractCodeFromOutput(rawOutput)`: Parse NDJSON events

### Evaluator (evaluator.ts)

- `evaluateCode(task, extractedFiles, ...)`: Full evaluation pipeline
- `runAstChecks(code, checks)`: Validate with AST
- `runTypeCheck(code, envPath)`: TypeScript checking

### Reporter (reporter.ts)

- `loadResults(runDir)`: Read all result files
- `computeMetrics(results)`: Aggregate statistics
- `formatReportText(report)`: Generate ASCII table
- `generateAndWriteReport(runDir)`: Write JSON + TXT outputs

### Hallucination Classifier (judge/hallucination-classifier.ts)

- `classifyHallucinations(task, astResults, judgeResult)`: Map failures to types

### Rubric Scorer (judge/rubric-scorer.ts)

- `scoreWithRubric(code, task, condition)`: LLM judge evaluation
- `calculateJudgeScore(responses)`: Average criterion scores

---

## 📊 Data Flow Summary

```
Input: User CLI args
  │
  ├─→ Load tasks (validate with Zod)
  ├─→ Generate work queue (shuffle with seed)
  │
  ├─→ For each work item [taskId, condition, rep]:
  │   │
  │   ├─→ Run Agent
  │   │   └─→ Execute opencode CLI
  │   │   └─→ Extract code files from NDJSON stream
  │   │
  │   ├─→ Evaluate Code
  │   │   ├─→ AST Checks (ts-morph)
  │   │   ├─→ Type Check (tsc in version-specific env)
  │   │   ├─→ Classify Hallucinations
  │   │   └─→ Judge Scoring (OpenRouter API)
  │   │
  │   └─→ Store Result (atomic write to JSON)
  │
  └─→ Generate Report
      ├─→ Load all results
      ├─→ Compute metrics (pass rate, compliance, etc.)
      ├─→ Aggregate by category/library/condition
      └─→ Write report.json + report.txt + stdout

Output: Results directory with JSON + text reports
```

---

## Key Concepts

### Conditions

- **Baseline**: Pure LLM capability (no context tools)
- **Context7**: Context augmentation tool #1
- **Nia**: Context augmentation tool #2 (full toolset)
  → Measures how much context tools improve accuracy

### Categories

- **Bleeding-Edge (A)**: Latest features (post-training cutoff)
  - Measures: Can context tools help with unknown features?
- **Version-Locked Write (B1)**: Code for specific old version
  - Measures: Can agents stick to old APIs when required?
- **Version-Locked Audit (B2)**: Identify version bugs in given code
  - Measures: Can agents recognize and fix version issues?

### Scoring

- **Test Score**: % of automated AST checks passing (0-1)
- **Judge Score**: LLM evaluation of rubric criteria (0-1)
- **Final Score**: 60% test + 40% judge (0-1)
- **Pass Threshold**: finalScore ≥ 0.8 for task to count as "passed"
