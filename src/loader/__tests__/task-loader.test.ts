import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@/types/task';
import { loadTasks } from '../task-loader';

// A minimal valid task JSON object matching the TaskSchema
function createValidTask(overrides: Partial<Task> = {}): Record<string, unknown> {
  return {
    id: 'test-task-1',
    category: 'bleeding_edge',
    library: 'next',
    target_version: '16.0.0',
    prompt: 'Create a proxy file for Next.js 16',
    reference_solution: 'export function proxy() {}',
    test_spec: {
      ast_checks: [
        { type: 'function_exported', name: 'proxy' },
        { type: 'import_exists', name: 'NextResponse', from: 'next/server' },
      ],
      type_check: true,
    },
    rubric: {
      criteria: [
        { name: 'proxy_filename', weight: 0.25, description: 'File is proxy.ts' },
        { name: 'proxy_function_name', weight: 0.25, description: 'Exports function proxy()' },
        { name: 'correct_api_usage', weight: 0.3, description: 'Correct API usage' },
        { name: 'no_hallucination', weight: 0.2, description: 'No hallucinations' },
      ],
    },
    common_hallucinations: ['middleware.ts instead of proxy.ts', 'export function middleware()'],
    ...overrides,
  };
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'nia-bench-test-'));
  // Create the three subdirectory structures
  await mkdir(join(tempDir, 'bleeding_edge'), { recursive: true });
  await mkdir(join(tempDir, 'version_locked_write'), { recursive: true });
  await mkdir(join(tempDir, 'version_locked_audit'), { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('loadTasks', () => {
  it('should load a valid task JSON file', async () => {
    const validTask = createValidTask();
    await writeFile(
      join(tempDir, 'bleeding_edge', 'test-task.json'),
      JSON.stringify(validTask, null, 2),
    );

    const result = await loadTasks(tempDir);

    expect(result.tasks).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
    expect(result.tasks[0]?.id).toBe('test-task-1');
    expect(result.tasks[0]?.category).toBe('bleeding_edge');
    expect(result.tasks[0]?.library).toBe('next');
    expect(result.tasks[0]?.test_spec.ast_checks).toHaveLength(2);
    expect(result.tasks[0]?.rubric.criteria).toHaveLength(4);
  });

  it('should report validation errors for invalid task JSON and skip it', async () => {
    // Valid task
    const validTask = createValidTask();
    await writeFile(
      join(tempDir, 'bleeding_edge', 'valid-task.json'),
      JSON.stringify(validTask, null, 2),
    );

    // Invalid task: missing required fields
    const invalidTask = {
      id: 'bad-task',
      // missing category, library, target_version, etc.
    };
    await writeFile(
      join(tempDir, 'bleeding_edge', 'invalid-task.json'),
      JSON.stringify(invalidTask, null, 2),
    );

    const result = await loadTasks(tempDir);

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.id).toBe('test-task-1');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.filePath).toContain('invalid-task.json');
    expect(result.errors[0]?.error).toContain('Validation failed');
  });

  it('should handle malformed JSON gracefully', async () => {
    await writeFile(join(tempDir, 'bleeding_edge', 'broken.json'), '{ not valid json }}}');

    const result = await loadTasks(tempDir);

    expect(result.tasks).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.filePath).toContain('broken.json');
    expect(result.errors[0]?.error).toContain('Failed to read/parse JSON');
  });

  it('should load tasks from multiple subdirectories', async () => {
    const bleedingEdgeTask = createValidTask({
      id: 'be-task',
      category: 'bleeding_edge',
    });
    const versionLockedTask = createValidTask({
      id: 'vl-task',
      category: 'version_locked_write',
      library: 'react',
      target_version: '17.0.0',
    });
    const auditTask = createValidTask({
      id: 'audit-task',
      category: 'version_locked_audit',
      library: 'zod',
      target_version: '4.0.0',
    });

    await writeFile(
      join(tempDir, 'bleeding_edge', 'be.json'),
      JSON.stringify(bleedingEdgeTask, null, 2),
    );
    await writeFile(
      join(tempDir, 'version_locked_write', 'vl.json'),
      JSON.stringify(versionLockedTask, null, 2),
    );
    await writeFile(
      join(tempDir, 'version_locked_audit', 'audit.json'),
      JSON.stringify(auditTask, null, 2),
    );

    const result = await loadTasks(tempDir);

    expect(result.tasks).toHaveLength(3);
    expect(result.errors).toHaveLength(0);

    const ids = result.tasks.map((t) => t.id).sort();
    expect(ids).toEqual(['audit-task', 'be-task', 'vl-task']);
  });

  it('should filter by category', async () => {
    const bleedingEdgeTask = createValidTask({ id: 'be-task', category: 'bleeding_edge' });
    const versionLockedTask = createValidTask({
      id: 'vl-task',
      category: 'version_locked_write',
      library: 'react',
    });

    await writeFile(
      join(tempDir, 'bleeding_edge', 'be.json'),
      JSON.stringify(bleedingEdgeTask, null, 2),
    );
    await writeFile(
      join(tempDir, 'version_locked_write', 'vl.json'),
      JSON.stringify(versionLockedTask, null, 2),
    );

    const result = await loadTasks(tempDir, { category: 'bleeding_edge' });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.id).toBe('be-task');
  });

  it('should filter by library', async () => {
    const nextTask = createValidTask({ id: 'next-task', library: 'next' });
    const reactTask = createValidTask({ id: 'react-task', library: 'react' });

    await writeFile(join(tempDir, 'bleeding_edge', 'next.json'), JSON.stringify(nextTask, null, 2));
    await writeFile(
      join(tempDir, 'bleeding_edge', 'react.json'),
      JSON.stringify(reactTask, null, 2),
    );

    const result = await loadTasks(tempDir, { library: 'react' });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.id).toBe('react-task');
  });

  it('should filter by task ID', async () => {
    const task1 = createValidTask({ id: 'task-alpha' });
    const task2 = createValidTask({ id: 'task-beta' });

    await writeFile(join(tempDir, 'bleeding_edge', 't1.json'), JSON.stringify(task1, null, 2));
    await writeFile(join(tempDir, 'bleeding_edge', 't2.json'), JSON.stringify(task2, null, 2));

    const result = await loadTasks(tempDir, { id: 'task-beta' });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.id).toBe('task-beta');
  });

  it('should ignore non-JSON files', async () => {
    const validTask = createValidTask();
    await writeFile(
      join(tempDir, 'bleeding_edge', 'valid.json'),
      JSON.stringify(validTask, null, 2),
    );
    await writeFile(join(tempDir, 'bleeding_edge', 'readme.md'), '# Not a task');
    await writeFile(join(tempDir, 'bleeding_edge', '.gitkeep'), '');

    const result = await loadTasks(tempDir);

    expect(result.tasks).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });

  it('should handle missing subdirectories gracefully', async () => {
    // Remove all subdirs — loader should not crash
    await rm(join(tempDir, 'bleeding_edge'), { recursive: true });
    await rm(join(tempDir, 'version_locked_write'), { recursive: true });
    await rm(join(tempDir, 'version_locked_audit'), { recursive: true });

    const result = await loadTasks(tempDir);

    expect(result.tasks).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('should return empty results when no tasks match filter', async () => {
    const task = createValidTask({ id: 'next-task', library: 'next' });
    await writeFile(join(tempDir, 'bleeding_edge', 'task.json'), JSON.stringify(task, null, 2));

    const result = await loadTasks(tempDir, { library: 'zod' });

    expect(result.tasks).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('should validate AST check discriminated union types', async () => {
    // Task with an invalid AST check type
    const taskWithBadCheck = createValidTask();
    (taskWithBadCheck.test_spec as Record<string, unknown>).ast_checks = [
      { type: 'nonexistent_check_type', name: 'foo' },
    ];

    await writeFile(
      join(tempDir, 'bleeding_edge', 'bad-check.json'),
      JSON.stringify(taskWithBadCheck, null, 2),
    );

    const result = await loadTasks(tempDir);

    expect(result.tasks).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain('Validation failed');
  });

  it('should validate all AST check types correctly', async () => {
    const taskWithAllChecks = createValidTask();
    (taskWithAllChecks.test_spec as Record<string, unknown>).ast_checks = [
      { type: 'import_exists', name: 'use', from: 'react' },
      { type: 'import_absent', name: 'useFormState' },
      { type: 'module_import_absent', module: 'react-dom/client' },
      { type: 'function_exported', name: 'proxy' },
      { type: 'function_absent', name: 'middleware' },
      { type: 'await_present', call: 'cookies()' },
      { type: 'await_absent', call: 'streamText' },
      { type: 'call_exists', call: 'use(commentsPromise)' },
      { type: 'call_absent', call: 'toDataStreamResponse()' },
      { type: 'directive_present', directive: 'use cache' },
      { type: 'property_location', property: 'transformer', insideCall: 'httpBatchLink' },
      { type: 'async_function', name: 'DashboardPage' },
      { type: 'async_generator' },
      { type: 'yield_present' },
      { type: 'type_annotation', parameter: 'params', annotation: 'Promise<{ id: string }>' },
      { type: 'property_absent', property: 'runtime' },
    ];

    await writeFile(
      join(tempDir, 'bleeding_edge', 'all-checks.json'),
      JSON.stringify(taskWithAllChecks, null, 2),
    );

    const result = await loadTasks(tempDir);

    expect(result.tasks).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
    expect(result.tasks[0]?.test_spec.ast_checks).toHaveLength(16);
  });

  it('should validate optional context field for version-locked tasks', async () => {
    const taskWithContext = createValidTask({
      id: 'ctx-task',
      category: 'version_locked_write',
      context: {
        code: { 'package.json': '{"dependencies":{"next":"13.0.0"}}' },
        package_json: '{"dependencies":{"next":"13.0.0"}}',
      },
    });

    await writeFile(
      join(tempDir, 'version_locked_write', 'ctx.json'),
      JSON.stringify(taskWithContext, null, 2),
    );

    const result = await loadTasks(tempDir);

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.context).toBeDefined();
    expect(result.tasks[0]?.context?.code).toBeDefined();
    expect(result.tasks[0]?.context?.package_json).toBeDefined();
  });
});
