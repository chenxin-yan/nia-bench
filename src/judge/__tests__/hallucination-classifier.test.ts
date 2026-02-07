import { describe, expect, test } from 'bun:test';
import type { AstCheckResult } from '@/tests/ast-checker';
import type { Task } from '@/types/task';
import { classifyHallucinations } from '../hallucination-classifier';
import type { CriterionResult, JudgeResult } from '../rubric-scorer';

// --- Helper factories ---

function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test-task',
    category: 'version_locked_write',
    library: 'next',
    target_version: '13.5.6',
    prompt: 'Test prompt',
    reference_solution: 'Test solution',
    test_spec: {
      ast_checks: [],
    },
    rubric: {
      criteria: [
        { name: 'correct_usage', weight: 0.5, description: 'Uses correct API' },
        { name: 'no_hallucination', weight: 0.5, description: 'No hallucinated APIs' },
      ],
    },
    common_hallucinations: [],
    ...overrides,
  };
}

function createMockJudgeResult(criteria: CriterionResult[]): JudgeResult {
  return {
    criteria,
    judgeScore:
      criteria.filter((c) => c.verdict === 'PASS').reduce((s, c) => s + c.weight, 0) /
      criteria.reduce((s, c) => s + c.weight, 0),
    rawResponses: [],
  };
}

function createPassingJudgeResult(): JudgeResult {
  return createMockJudgeResult([
    {
      name: 'correct_usage',
      verdict: 'PASS',
      weight: 0.5,
      evidence: 'Uses correct API',
      reasoning: 'The code correctly implements the required pattern',
    },
    {
      name: 'no_hallucination',
      verdict: 'PASS',
      weight: 0.5,
      evidence: 'No hallucinated APIs detected',
      reasoning: 'All APIs used are valid for the target version',
    },
  ]);
}

// --- Test Case 1: future_api ---
describe('Test case 1: future_api detection', () => {
  test('detects future_api when agent uses await cookies() in Next.js 13 task', () => {
    // Mock a Next.js 13 task where AST check `await_absent` for `cookies()` failed
    // (agent used `await cookies()` which is a v15 pattern)
    const task = createMockTask({
      id: 'nextjs-13-sync-request-apis',
      category: 'version_locked_write',
      library: 'next',
      target_version: '13.5.6',
      common_hallucinations: [
        'const cookieStore = await cookies() (v15 pattern applied to v13)',
        'Using `NextRequest` parameter instead of the standalone functions',
      ],
    });

    const astResults: AstCheckResult[] = [
      {
        check: { type: 'await_absent', call: 'cookies' },
        passed: false,
        message: "Found unwanted 'await cookies' — this call should NOT be awaited",
      },
      {
        check: { type: 'await_absent', call: 'headers' },
        passed: true,
        message: "'headers' is correctly not awaited",
      },
      {
        check: { type: 'import_exists', name: 'cookies', from: 'next/headers' },
        passed: true,
        message: "Found import { cookies } from 'next/headers'",
      },
      {
        check: { type: 'import_exists', name: 'headers', from: 'next/headers' },
        passed: true,
        message: "Found import { headers } from 'next/headers'",
      },
    ];

    const judgeResult = createPassingJudgeResult();

    const result = classifyHallucinations(task, 'await cookies()', astResults, judgeResult);

    expect(result.types).toContain('future_api');
    expect(result.details.length).toBeGreaterThanOrEqual(1);

    const futureApiDetail = result.details.find((d) => d.type === 'future_api');
    expect(futureApiDetail).toBeDefined();
    expect(futureApiDetail?.description).toContain('cookies');
    expect(futureApiDetail?.description).toContain('newer version');
  });
});

// --- Test Case 2: outdated_api ---
describe('Test case 2: outdated_api detection', () => {
  test('detects outdated_api when agent uses forwardRef in React 19 task', () => {
    // Mock a React 19 task where `import_absent` for `forwardRef` failed
    // (agent imported forwardRef which is deprecated/removed in React 19)
    const task = createMockTask({
      id: 'react-19-ref-as-prop',
      category: 'bleeding_edge',
      library: 'react',
      target_version: '19.0.0',
      common_hallucinations: [
        'Using React.forwardRef() instead of passing ref as a regular prop (deprecated pattern)',
        'Wrapping component in forwardRef (v17/v18 pattern)',
      ],
    });

    const astResults: AstCheckResult[] = [
      {
        check: { type: 'import_absent', name: 'forwardRef' },
        passed: false,
        message: "Found unwanted import { forwardRef } from 'react'",
      },
    ];

    const judgeResult = createPassingJudgeResult();

    const result = classifyHallucinations(
      task,
      'import { forwardRef } from "react"',
      astResults,
      judgeResult,
    );

    expect(result.types).toContain('outdated_api');
    expect(result.details.length).toBeGreaterThanOrEqual(1);

    const outdatedDetail = result.details.find((d) => d.type === 'outdated_api');
    expect(outdatedDetail).toBeDefined();
    expect(outdatedDetail?.description).toContain('forwardRef');
  });
});

// --- Test Case 3: wrong_import_path ---
describe('Test case 3: wrong_import_path detection', () => {
  test('detects wrong_import_path when useActionState imported from react-dom instead of react', () => {
    // Mock a React 19 task where agent imported useActionState from react-dom
    // instead of react
    const task = createMockTask({
      id: 'react-19-form-actions',
      category: 'bleeding_edge',
      library: 'react',
      target_version: '19.0.0',
      common_hallucinations: [
        'Importing useFormState from react-dom (renamed to useActionState in react)',
        'Using react-dom hooks in client component incorrectly',
      ],
    });

    const astResults: AstCheckResult[] = [
      {
        check: { type: 'import_exists', name: 'useActionState', from: 'react' },
        passed: false,
        message: "Import { useActionState } from 'react' not found",
      },
      {
        check: { type: 'module_import_absent', module: 'react-dom' },
        passed: false,
        message: "Found unwanted import from 'react-dom'",
      },
    ];

    const judgeResult = createPassingJudgeResult();

    const result = classifyHallucinations(
      task,
      'import { useActionState } from "react-dom"',
      astResults,
      judgeResult,
    );

    expect(result.types).toContain('wrong_import_path');
    expect(result.details.length).toBeGreaterThanOrEqual(2);

    const wrongImportDetails = result.details.filter((d) => d.type === 'wrong_import_path');
    expect(wrongImportDetails.length).toBeGreaterThanOrEqual(1);
  });
});

// --- Test Case 4: multiple hallucinations ---
describe('Test case 4: multiple hallucinations detection', () => {
  test('detects multiple hallucination types from multiple AST failures', () => {
    // Mock a task with multiple different types of failures
    const task = createMockTask({
      id: 'nextjs-16-proxy-ts',
      category: 'bleeding_edge',
      library: 'next',
      target_version: '16.0.0',
      common_hallucinations: [
        'Creating middleware.ts instead of proxy.ts (v15 and earlier pattern)',
        'export function middleware(request: NextRequest) (v15 function name)',
        "Setting runtime: 'edge' in config (not supported in proxy.ts)",
      ],
    });

    const astResults: AstCheckResult[] = [
      {
        check: { type: 'function_exported', name: 'proxy' },
        passed: false,
        message: "No exported function 'proxy' found",
      },
      {
        check: { type: 'function_absent', name: 'middleware' },
        passed: false,
        message: "Found unwanted exported function 'middleware'",
      },
      {
        check: { type: 'property_absent', property: 'runtime', inObject: 'config' },
        passed: false,
        message: "Found unwanted property 'runtime' in 'config'",
      },
      {
        check: { type: 'call_exists', call: 'config.matcher' },
        passed: true,
        message: "Found 'config' with property 'matcher'",
      },
    ];

    // Also add a judge failure for no_hallucination
    const judgeResult = createMockJudgeResult([
      {
        name: 'correct_usage',
        verdict: 'PASS',
        weight: 0.5,
        evidence: 'Uses NextResponse correctly',
        reasoning: 'Correct usage',
      },
      {
        name: 'no_hallucination',
        verdict: 'FAIL',
        weight: 0.5,
        evidence: 'Used deprecated middleware.ts pattern from older version',
        reasoning: 'Agent used outdated middleware pattern instead of proxy.ts',
      },
    ]);

    const result = classifyHallucinations(
      task,
      'export function middleware() {}',
      astResults,
      judgeResult,
    );

    // Should detect multiple distinct hallucination types
    expect(result.types.length).toBeGreaterThanOrEqual(2);
    expect(result.details.length).toBeGreaterThanOrEqual(3); // AST failures + judge failure

    // Should have at least version_mismatch (from function_exported failure)
    // and outdated_api (from function_absent failure in bleeding_edge)
    const typeSet = new Set(result.types);
    expect(typeSet.size).toBeGreaterThanOrEqual(2);
  });

  test('correctly classifies judge hallucination evidence with outdated keyword', () => {
    const task = createMockTask({
      id: 'test-task',
      category: 'bleeding_edge',
      library: 'next',
      target_version: '16.0.0',
      common_hallucinations: [],
    });

    const astResults: AstCheckResult[] = [];

    const judgeResult = createMockJudgeResult([
      {
        name: 'no_hallucination',
        verdict: 'FAIL',
        weight: 0.5,
        evidence: 'Used deprecated middleware.ts pattern from older version',
        reasoning: 'Agent used outdated middleware pattern instead of proxy.ts',
      },
    ]);

    const result = classifyHallucinations(task, '', astResults, judgeResult);

    expect(result.types).toContain('outdated_api');
    expect(result.details.length).toBeGreaterThanOrEqual(1);
  });
});

// --- Test Case 5: no hallucinations ---
describe('Test case 5: no hallucinations (all pass)', () => {
  test('returns empty types when all AST checks pass and judge gives all PASS', () => {
    const task = createMockTask({
      id: 'nextjs-16-proxy-ts',
      category: 'bleeding_edge',
      library: 'next',
      target_version: '16.0.0',
      common_hallucinations: [
        'Creating middleware.ts instead of proxy.ts',
        "Setting runtime: 'edge' in config",
      ],
    });

    const astResults: AstCheckResult[] = [
      {
        check: { type: 'function_exported', name: 'proxy' },
        passed: true,
        message: "Found exported function 'proxy'",
      },
      {
        check: { type: 'function_absent', name: 'middleware' },
        passed: true,
        message: "Function 'middleware' is correctly absent from exports",
      },
      {
        check: { type: 'call_exists', call: 'config.matcher' },
        passed: true,
        message: "Found 'config' with property 'matcher'",
      },
      {
        check: { type: 'property_absent', property: 'runtime', inObject: 'config' },
        passed: true,
        message: "Property 'runtime' is correctly absent from 'config'",
      },
    ];

    const judgeResult = createPassingJudgeResult();

    const result = classifyHallucinations(
      task,
      'export function proxy() {}',
      astResults,
      judgeResult,
    );

    expect(result.types).toHaveLength(0);
    expect(result.details).toHaveLength(0);
  });

  test('returns empty types with empty AST checks and all PASS judge', () => {
    // Audit task with no AST checks
    const task = createMockTask({
      id: 'react-17-audit-v19-code',
      category: 'version_locked_audit',
      library: 'react',
      target_version: '17.0.2',
      common_hallucinations: [],
    });

    const astResults: AstCheckResult[] = [];
    const judgeResult = createPassingJudgeResult();

    const result = classifyHallucinations(task, '', astResults, judgeResult);

    expect(result.types).toHaveLength(0);
    expect(result.details).toHaveLength(0);
  });
});

// --- Additional edge cases ---

describe('Cross-reference with common hallucinations', () => {
  test('enhances descriptions with matching common hallucination patterns', () => {
    const task = createMockTask({
      id: 'nextjs-13-sync-request-apis',
      category: 'version_locked_write',
      library: 'next',
      target_version: '13.5.6',
      common_hallucinations: ['const cookieStore = await cookies() (v15 pattern applied to v13)'],
    });

    const astResults: AstCheckResult[] = [
      {
        check: { type: 'await_absent', call: 'cookies' },
        passed: false,
        message: "Found unwanted 'await cookies' — this call should NOT be awaited",
      },
    ];

    const judgeResult = createPassingJudgeResult();

    const result = classifyHallucinations(task, 'await cookies()', astResults, judgeResult);

    // The detail should reference the common hallucination pattern since 'cookies' matches
    expect(result.details.length).toBeGreaterThanOrEqual(1);
    const cookiesDetail = result.details.find((d) => d.description.includes('cookies'));
    expect(cookiesDetail).toBeDefined();
  });
});

describe('AST check type classification mapping', () => {
  test('call_absent failure in bleeding_edge task classifies as outdated_api', () => {
    const task = createMockTask({
      category: 'bleeding_edge',
      library: 'react',
      target_version: '19.0.0',
      common_hallucinations: [],
    });

    const astResults: AstCheckResult[] = [
      {
        check: { type: 'call_absent', call: 'toDataStreamResponse' },
        passed: false,
        message: "Found unwanted call to 'toDataStreamResponse()'",
      },
    ];

    const judgeResult = createPassingJudgeResult();

    const result = classifyHallucinations(task, '', astResults, judgeResult);
    expect(result.types).toContain('outdated_api');
  });

  test('property_location failure classifies as wrong_parameter', () => {
    const task = createMockTask({
      category: 'bleeding_edge',
      library: 'trpc',
      target_version: '11.0.0',
      common_hallucinations: [],
    });

    const astResults: AstCheckResult[] = [
      {
        check: { type: 'property_location', property: 'transformer', insideCall: 'httpBatchLink' },
        passed: false,
        message: "Property 'transformer' not found inside call to 'httpBatchLink()'",
      },
    ];

    const judgeResult = createPassingJudgeResult();

    const result = classifyHallucinations(task, '', astResults, judgeResult);
    expect(result.types).toContain('wrong_parameter');
  });

  test('type_annotation failure classifies as wrong_parameter', () => {
    const task = createMockTask({
      category: 'bleeding_edge',
      library: 'next',
      target_version: '16.0.0',
      common_hallucinations: [],
    });

    const astResults: AstCheckResult[] = [
      {
        check: {
          type: 'type_annotation',
          parameter: 'params',
          annotation: 'Promise<{ id: string }>',
        },
        passed: false,
        message: "Parameter 'params' does not have type annotation 'Promise<{ id: string }>'",
      },
    ];

    const judgeResult = createPassingJudgeResult();

    const result = classifyHallucinations(task, '', astResults, judgeResult);
    expect(result.types).toContain('wrong_parameter');
  });

  test('await_present failure classifies as outdated_api', () => {
    const task = createMockTask({
      category: 'bleeding_edge',
      library: 'next',
      target_version: '16.0.0',
      common_hallucinations: [],
    });

    const astResults: AstCheckResult[] = [
      {
        check: { type: 'await_present', call: 'cookies' },
        passed: false,
        message: "No 'await cookies' pattern found",
      },
    ];

    const judgeResult = createPassingJudgeResult();

    const result = classifyHallucinations(task, '', astResults, judgeResult);
    expect(result.types).toContain('outdated_api');
  });

  test('directive_present failure classifies as version_mismatch', () => {
    const task = createMockTask({
      category: 'bleeding_edge',
      library: 'next',
      target_version: '16.0.0',
      common_hallucinations: [],
    });

    const astResults: AstCheckResult[] = [
      {
        check: { type: 'directive_present', directive: 'use cache' },
        passed: false,
        message: "Directive 'use cache' not found",
      },
    ];

    const judgeResult = createPassingJudgeResult();

    const result = classifyHallucinations(task, '', astResults, judgeResult);
    expect(result.types).toContain('version_mismatch');
  });

  test('async_function failure classifies as version_mismatch', () => {
    const task = createMockTask({
      category: 'bleeding_edge',
      library: 'next',
      target_version: '16.0.0',
      common_hallucinations: [],
    });

    const astResults: AstCheckResult[] = [
      {
        check: { type: 'async_function', name: 'Page' },
        passed: false,
        message: "Function 'Page' is not async or not found",
      },
    ];

    const judgeResult = createPassingJudgeResult();

    const result = classifyHallucinations(task, '', astResults, judgeResult);
    expect(result.types).toContain('version_mismatch');
  });
});

describe('Judge evidence classification', () => {
  test('classifies judge evidence with "import" and "wrong" as wrong_import_path', () => {
    const task = createMockTask();
    const astResults: AstCheckResult[] = [];

    const judgeResult = createMockJudgeResult([
      {
        name: 'no_hallucination',
        verdict: 'FAIL',
        weight: 0.5,
        evidence: 'Wrong import path used for useActionState',
        reasoning: 'The import should be from react, not react-dom',
      },
    ]);

    const result = classifyHallucinations(task, '', astResults, judgeResult);
    expect(result.types).toContain('wrong_import_path');
  });

  test('classifies judge evidence with "parameter" as wrong_parameter', () => {
    const task = createMockTask();
    const astResults: AstCheckResult[] = [];

    const judgeResult = createMockJudgeResult([
      {
        name: 'no_hallucination',
        verdict: 'FAIL',
        weight: 0.5,
        evidence: 'Incorrect parameter passed to cookies function',
        reasoning: 'cookies() does not accept parameter in this version',
      },
    ]);

    const result = classifyHallucinations(task, '', astResults, judgeResult);
    expect(result.types).toContain('wrong_parameter');
  });

  test('classifies judge evidence with "future" as future_api', () => {
    const task = createMockTask();
    const astResults: AstCheckResult[] = [];

    const judgeResult = createMockJudgeResult([
      {
        name: 'no_hallucination',
        verdict: 'FAIL',
        weight: 0.5,
        evidence: 'Used future API that is not available in this version',
        reasoning: 'This API was introduced in a newer version',
      },
    ]);

    const result = classifyHallucinations(task, '', astResults, judgeResult);
    expect(result.types).toContain('future_api');
  });

  test('classifies judge evidence with "mixed" or "mismatch" as version_mismatch', () => {
    const task = createMockTask();
    const astResults: AstCheckResult[] = [];

    const judgeResult = createMockJudgeResult([
      {
        name: 'no_hallucination',
        verdict: 'FAIL',
        weight: 0.5,
        evidence: 'Mixed APIs from different versions detected',
        reasoning: 'Code uses patterns from both v17 and v19',
      },
    ]);

    const result = classifyHallucinations(task, '', astResults, judgeResult);
    expect(result.types).toContain('version_mismatch');
  });

  test('defaults to invented_method when judge evidence is ambiguous', () => {
    const task = createMockTask();
    const astResults: AstCheckResult[] = [];

    const judgeResult = createMockJudgeResult([
      {
        name: 'no_hallucination',
        verdict: 'FAIL',
        weight: 0.5,
        evidence: 'Code contains incorrect API usage',
        reasoning: 'The implementation does not match the specification',
      },
    ]);

    const result = classifyHallucinations(task, '', astResults, judgeResult);
    expect(result.types).toContain('invented_method');
  });
});

describe('Deduplication of hallucination types', () => {
  test('deduplicates types when multiple checks produce the same type', () => {
    const task = createMockTask({
      category: 'version_locked_write',
      library: 'next',
      target_version: '13.5.6',
      common_hallucinations: [],
    });

    const astResults: AstCheckResult[] = [
      {
        check: { type: 'await_absent', call: 'cookies' },
        passed: false,
        message: "Found unwanted 'await cookies'",
      },
      {
        check: { type: 'await_absent', call: 'headers' },
        passed: false,
        message: "Found unwanted 'await headers'",
      },
    ];

    const judgeResult = createPassingJudgeResult();

    const result = classifyHallucinations(task, '', astResults, judgeResult);

    // Both failures map to future_api, but types should be deduplicated
    expect(result.types).toEqual(['future_api']);
    // But details should preserve both entries
    expect(result.details).toHaveLength(2);
  });
});

describe('Version direction inference', () => {
  test('bleeding_edge category defaults absent APIs to outdated_api', () => {
    const task = createMockTask({
      category: 'bleeding_edge',
      library: 'react',
      target_version: '19.0.0',
      common_hallucinations: [],
    });

    const astResults: AstCheckResult[] = [
      {
        check: { type: 'import_absent', name: 'forwardRef' },
        passed: false,
        message: "Found unwanted import { forwardRef } from 'react'",
      },
    ];

    const judgeResult = createPassingJudgeResult();

    const result = classifyHallucinations(task, '', astResults, judgeResult);
    expect(result.types).toContain('outdated_api');
  });

  test('version_locked_write category defaults absent APIs to future_api', () => {
    const task = createMockTask({
      category: 'version_locked_write',
      library: 'react',
      target_version: '17.0.2',
      common_hallucinations: [],
    });

    const astResults: AstCheckResult[] = [
      {
        check: { type: 'import_absent', name: 'useId' },
        passed: false,
        message: "Found unwanted import { useId } from 'react'",
      },
    ];

    const judgeResult = createPassingJudgeResult();

    const result = classifyHallucinations(task, '', astResults, judgeResult);
    expect(result.types).toContain('future_api');
  });

  test('version_locked_audit category defaults to version_mismatch', () => {
    const task = createMockTask({
      category: 'version_locked_audit',
      library: 'react',
      target_version: '17.0.2',
      common_hallucinations: [],
    });

    const astResults: AstCheckResult[] = [
      {
        check: { type: 'import_absent', name: 'useId' },
        passed: false,
        message: "Found unwanted import { useId } from 'react'",
      },
    ];

    const judgeResult = createPassingJudgeResult();

    const result = classifyHallucinations(task, '', astResults, judgeResult);
    expect(result.types).toContain('version_mismatch');
  });
});
