import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Task } from '@/types/task';
import {
  type Condition,
  createWorkDir,
  extractCodeFromDisk,
  extractCodeFromResponse,
  injectConfig,
  injectContext,
} from '../agent';

/** Helper: check if a path exists */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// --- Test Helpers ---

const TEST_TEMP_DIR = join('/tmp', 'nia-bench-test', `agent-test-${Date.now()}`);

/** Minimal valid task for testing */
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test-task-1',
    category: 'bleeding_edge',
    library: 'next',
    target_version: '16',
    prompt: 'Create a proxy.ts file',
    reference_solution: 'export function proxy() {}',
    test_spec: {
      ast_checks: [],
    },
    rubric: {
      criteria: [{ name: 'test', weight: 1.0, description: 'Test criterion' }],
    },
    common_hallucinations: [],
    ...overrides,
  };
}

/** Get path to the actual MCP config directory */
function getMcpConfigDir(): string {
  return join(import.meta.dirname, '..', 'mcp_configs');
}

// --- Setup / Teardown ---

beforeEach(async () => {
  await mkdir(TEST_TEMP_DIR, { recursive: true });
});

afterEach(async () => {
  try {
    await rm(TEST_TEMP_DIR, { recursive: true, force: true });
  } catch {
    // Best effort cleanup
  }
});

// --- Tests ---

describe('createWorkDir', () => {
  test('creates a unique temp directory with correct naming', async () => {
    const workDir = await createWorkDir('my-task', 'baseline', 0, TEST_TEMP_DIR);

    // Verify directory exists
    expect(await pathExists(workDir)).toBe(true);

    // Verify naming pattern: {timestamp}-{taskId}-{condition}-{rep}
    const dirName = workDir.split('/').pop() ?? '';
    expect(dirName).toMatch(/^\d+-my-task-baseline-0$/);
  });

  test('creates different directories for different conditions', async () => {
    const dir1 = await createWorkDir('task-1', 'baseline', 0, TEST_TEMP_DIR);
    // Small delay to ensure different timestamps
    await new Promise((resolve) => setTimeout(resolve, 5));
    const dir2 = await createWorkDir('task-1', 'context7', 0, TEST_TEMP_DIR);

    expect(dir1).not.toBe(dir2);
  });

  test('creates different directories for different run indices', async () => {
    const dir1 = await createWorkDir('task-1', 'baseline', 0, TEST_TEMP_DIR);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const dir2 = await createWorkDir('task-1', 'baseline', 1, TEST_TEMP_DIR);

    expect(dir1).not.toBe(dir2);
  });

  test('creates nested directories if base does not exist', async () => {
    const nestedBase = join(TEST_TEMP_DIR, 'nested', 'deep');
    const workDir = await createWorkDir('task-1', 'baseline', 0, nestedBase);

    expect(await pathExists(workDir)).toBe(true);
  });
});

describe('injectConfig', () => {
  test('copies baseline config into working directory as .opencode.json', async () => {
    const workDir = await createWorkDir('task-1', 'baseline', 0, TEST_TEMP_DIR);
    await injectConfig(workDir, 'baseline', { mcpConfigDir: getMcpConfigDir() });

    const configPath = join(workDir, '.opencode.json');
    const content = await readFile(configPath, 'utf-8');
    const config = JSON.parse(content);

    // Baseline should have agent config but NO mcpServers
    expect(config.agents).toBeDefined();
    expect(config.agents.coder.model).toBe('claude-4-sonnet');
    expect(config.mcpServers).toBeUndefined();
  });

  test('copies context7 config with Context7 MCP server', async () => {
    const workDir = await createWorkDir('task-1', 'context7', 0, TEST_TEMP_DIR);
    await injectConfig(workDir, 'context7', { mcpConfigDir: getMcpConfigDir() });

    const configPath = join(workDir, '.opencode.json');
    const content = await readFile(configPath, 'utf-8');
    const config = JSON.parse(content);

    expect(config.agents).toBeDefined();
    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers.context7).toBeDefined();
    expect(config.mcpServers.context7.type).toBe('stdio');
    expect(config.mcpServers.context7.command).toBe('npx');
    expect(config.mcpServers.context7.args).toContain('@context7/mcp');
  });

  test('copies nia config with Nia MCP server', async () => {
    const workDir = await createWorkDir('task-1', 'nia', 0, TEST_TEMP_DIR);
    await injectConfig(workDir, 'nia', { mcpConfigDir: getMcpConfigDir() });

    const configPath = join(workDir, '.opencode.json');
    const content = await readFile(configPath, 'utf-8');
    const config = JSON.parse(content);

    expect(config.agents).toBeDefined();
    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers.nia).toBeDefined();
    expect(config.mcpServers.nia.type).toBe('stdio');
    expect(config.mcpServers.nia.command).toBe('npx');
  });

  test('all three conditions use the same model', async () => {
    const configs: Record<string, string> = {};
    const conditions: Condition[] = ['baseline', 'context7', 'nia'];

    for (const condition of conditions) {
      const workDir = await createWorkDir('task-1', condition, 0, TEST_TEMP_DIR);
      await injectConfig(workDir, condition, { mcpConfigDir: getMcpConfigDir() });
      configs[condition] = await readFile(join(workDir, '.opencode.json'), 'utf-8');
    }

    // All configs should use the same model
    const baselineModel = JSON.parse(configs.baseline ?? '{}').agents.coder.model;
    const context7Model = JSON.parse(configs.context7 ?? '{}').agents.coder.model;
    const niaModel = JSON.parse(configs.nia ?? '{}').agents.coder.model;

    expect(baselineModel).toBe(context7Model);
    expect(context7Model).toBe(niaModel);
  });
});

describe('injectContext', () => {
  test('does nothing when task has no context', async () => {
    const workDir = await createWorkDir('task-1', 'baseline', 0, TEST_TEMP_DIR);
    const task = makeTask(); // No context field

    await injectContext(workDir, task);

    // Only the work directory itself should exist (no extra files)
    const entries = await readdir(workDir);
    expect(entries).toHaveLength(0);
  });

  test('writes package.json when context has package_json', async () => {
    const workDir = await createWorkDir('task-1', 'baseline', 0, TEST_TEMP_DIR);
    const pkgJson = '{\n  "dependencies": {\n    "next": "13.5.6"\n  }\n}';
    const task = makeTask({
      context: { package_json: pkgJson },
    });

    await injectContext(workDir, task);

    const written = await readFile(join(workDir, 'package.json'), 'utf-8');
    expect(written).toBe(pkgJson);
  });

  test('writes code files when context has code map', async () => {
    const workDir = await createWorkDir('task-1', 'baseline', 0, TEST_TEMP_DIR);
    const task = makeTask({
      context: {
        code: {
          'app/page.tsx': 'export default function Page() { return <div>Hello</div>; }',
          'lib/utils.ts': 'export function util() {}',
        },
      },
    });

    await injectContext(workDir, task);

    const page = await readFile(join(workDir, 'app', 'page.tsx'), 'utf-8');
    expect(page).toBe('export default function Page() { return <div>Hello</div>; }');

    const util = await readFile(join(workDir, 'lib', 'utils.ts'), 'utf-8');
    expect(util).toBe('export function util() {}');
  });

  test('creates nested directories for code files', async () => {
    const workDir = await createWorkDir('task-1', 'baseline', 0, TEST_TEMP_DIR);
    const task = makeTask({
      context: {
        code: {
          'src/components/deep/Component.tsx': 'export default function C() {}',
        },
      },
    });

    await injectContext(workDir, task);

    const content = await readFile(
      join(workDir, 'src', 'components', 'deep', 'Component.tsx'),
      'utf-8',
    );
    expect(content).toBe('export default function C() {}');
  });

  test('writes both package.json and code files when both provided', async () => {
    const workDir = await createWorkDir('task-1', 'baseline', 0, TEST_TEMP_DIR);
    const task = makeTask({
      context: {
        package_json: '{"name": "test"}',
        code: {
          'index.ts': 'console.log("hello");',
        },
      },
    });

    await injectContext(workDir, task);

    expect(await pathExists(join(workDir, 'package.json'))).toBe(true);
    expect(await pathExists(join(workDir, 'index.ts'))).toBe(true);
  });
});

describe('extractCodeFromResponse', () => {
  test('extracts code from JSON response with markdown code blocks', () => {
    const jsonResponse = JSON.stringify({
      response:
        "Here's the code:\n\n```typescript\nexport function proxy() {\n  return { matched: true };\n}\n```\n\nThis implements the proxy.",
    });

    const files = extractCodeFromResponse(jsonResponse);
    expect(Object.keys(files)).toHaveLength(1);
    const code = Object.values(files)[0];
    expect(code).toContain('export function proxy()');
    expect(code).toContain('return { matched: true }');
  });

  test('extracts multiple code blocks', () => {
    const response = JSON.stringify({
      response:
        '```typescript\nexport function a() {}\n```\n\nAnd:\n\n```tsx\nexport function b() {}\n```',
    });

    const files = extractCodeFromResponse(response);
    expect(Object.keys(files).length).toBeGreaterThanOrEqual(2);
  });

  test('handles raw text (non-JSON) response', () => {
    const rawResponse = "Here's the code:\n```typescript\nexport function hello() {}\n```";

    const files = extractCodeFromResponse(rawResponse);
    expect(Object.keys(files)).toHaveLength(1);
    expect(Object.values(files)[0]).toContain('export function hello()');
  });

  test('returns empty object when no code blocks found', () => {
    const response = JSON.stringify({
      response: 'No code blocks here, just text.',
    });

    const files = extractCodeFromResponse(response);
    expect(Object.keys(files)).toHaveLength(0);
  });

  test('handles empty input', () => {
    const files = extractCodeFromResponse('');
    expect(Object.keys(files)).toHaveLength(0);
  });

  test('extracts code from tsx code blocks', () => {
    const response = JSON.stringify({
      response: '```tsx\nexport default function Page() {\n  return <div>Hello</div>;\n}\n```',
    });

    const files = extractCodeFromResponse(response);
    expect(Object.keys(files)).toHaveLength(1);
    expect(Object.values(files)[0]).toContain('<div>Hello</div>');
  });

  test('extracts code from js/jsx blocks', () => {
    const response = JSON.stringify({
      response: '```js\nconst x = 1;\n```\n\n```jsx\nconst y = <div/>;\n```',
    });

    const files = extractCodeFromResponse(response);
    expect(Object.keys(files).length).toBeGreaterThanOrEqual(2);
  });

  test('detects filename hints before code blocks', () => {
    const response = JSON.stringify({
      response: 'file: proxy.ts\n```typescript\nexport function proxy() {}\n```',
    });

    const files = extractCodeFromResponse(response);
    expect(files['proxy.ts']).toBeDefined();
    expect(files['proxy.ts']).toContain('export function proxy()');
  });
});

describe('extractCodeFromDisk', () => {
  test('finds TypeScript files written to the work dir', async () => {
    const workDir = await createWorkDir('task-1', 'baseline', 0, TEST_TEMP_DIR);
    await writeFile(join(workDir, 'proxy.ts'), 'export function proxy() {}', 'utf-8');

    const files = await extractCodeFromDisk(workDir);
    expect(files['proxy.ts']).toBe('export function proxy() {}');
  });

  test('finds files in subdirectories', async () => {
    const workDir = await createWorkDir('task-1', 'baseline', 0, TEST_TEMP_DIR);
    await mkdir(join(workDir, 'app'), { recursive: true });
    await writeFile(join(workDir, 'app', 'page.tsx'), '<div>Page</div>', 'utf-8');

    const files = await extractCodeFromDisk(workDir);
    expect(files['app/page.tsx']).toBe('<div>Page</div>');
  });

  test('ignores non-code files', async () => {
    const workDir = await createWorkDir('task-1', 'baseline', 0, TEST_TEMP_DIR);
    await writeFile(join(workDir, 'readme.md'), '# Hello', 'utf-8');
    await writeFile(join(workDir, 'data.json'), '{}', 'utf-8');
    await writeFile(join(workDir, 'code.ts'), 'const x = 1;', 'utf-8');

    const files = await extractCodeFromDisk(workDir);
    expect(Object.keys(files)).toHaveLength(1);
    expect(files['code.ts']).toBe('const x = 1;');
  });

  test('ignores .opencode.json and node_modules', async () => {
    const workDir = await createWorkDir('task-1', 'baseline', 0, TEST_TEMP_DIR);
    await writeFile(join(workDir, '.opencode.json'), '{}', 'utf-8');
    await mkdir(join(workDir, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(workDir, 'node_modules', 'pkg', 'index.ts'), '', 'utf-8');
    await writeFile(join(workDir, 'app.ts'), 'export {}', 'utf-8');

    const files = await extractCodeFromDisk(workDir);
    expect(Object.keys(files)).toHaveLength(1);
    expect(files['app.ts']).toBeDefined();
  });

  test('ignores package.json from context injection', async () => {
    const workDir = await createWorkDir('task-1', 'baseline', 0, TEST_TEMP_DIR);
    await writeFile(join(workDir, 'package.json'), '{"name":"test"}', 'utf-8');
    await writeFile(join(workDir, 'index.ts'), 'export default 1;', 'utf-8');

    const files = await extractCodeFromDisk(workDir);
    expect(files['package.json']).toBeUndefined();
    expect(files['index.ts']).toBe('export default 1;');
  });

  test('finds .js and .jsx files', async () => {
    const workDir = await createWorkDir('task-1', 'baseline', 0, TEST_TEMP_DIR);
    await writeFile(join(workDir, 'app.js'), 'const a = 1;', 'utf-8');
    await writeFile(join(workDir, 'comp.jsx'), '<div/>', 'utf-8');

    const files = await extractCodeFromDisk(workDir);
    expect(files['app.js']).toBe('const a = 1;');
    expect(files['comp.jsx']).toBe('<div/>');
  });

  test('returns empty object for empty directory', async () => {
    const workDir = await createWorkDir('task-1', 'baseline', 0, TEST_TEMP_DIR);
    const files = await extractCodeFromDisk(workDir);
    expect(Object.keys(files)).toHaveLength(0);
  });

  test('handles multiple files across nested directories', async () => {
    const workDir = await createWorkDir('task-1', 'baseline', 0, TEST_TEMP_DIR);
    await mkdir(join(workDir, 'app', 'api'), { recursive: true });
    await mkdir(join(workDir, 'lib'), { recursive: true });

    await writeFile(join(workDir, 'app', 'page.tsx'), 'page', 'utf-8');
    await writeFile(join(workDir, 'app', 'layout.tsx'), 'layout', 'utf-8');
    await writeFile(join(workDir, 'app', 'api', 'route.ts'), 'route', 'utf-8');
    await writeFile(join(workDir, 'lib', 'utils.ts'), 'utils', 'utf-8');

    const files = await extractCodeFromDisk(workDir);
    expect(Object.keys(files)).toHaveLength(4);
    expect(files['app/page.tsx']).toBe('page');
    expect(files['app/layout.tsx']).toBe('layout');
    expect(files['app/api/route.ts']).toBe('route');
    expect(files['lib/utils.ts']).toBe('utils');
  });
});

describe('integration: end-to-end dry run (no opencode call)', () => {
  test('full workflow: create dir, inject config, inject context, extract disk files, cleanup', async () => {
    const task = makeTask({
      id: 'nextjs-13-sync-request-apis',
      context: {
        package_json: '{\n  "dependencies": {\n    "next": "13.5.6"\n  }\n}',
      },
    });

    // Step 1: Create work dir
    const workDir = await createWorkDir(task.id, 'baseline', 0, TEST_TEMP_DIR);
    expect(await pathExists(workDir)).toBe(true);

    // Step 2: Inject config
    await injectConfig(workDir, 'baseline', { mcpConfigDir: getMcpConfigDir() });
    const configContent = await readFile(join(workDir, '.opencode.json'), 'utf-8');
    expect(JSON.parse(configContent).agents).toBeDefined();

    // Step 3: Inject context
    await injectContext(workDir, task);
    const pkgContent = await readFile(join(workDir, 'package.json'), 'utf-8');
    expect(pkgContent).toContain('13.5.6');

    // Step 4: Simulate agent writing files to disk
    await mkdir(join(workDir, 'app', 'profile'), { recursive: true });
    await writeFile(
      join(workDir, 'app', 'profile', 'page.tsx'),
      "import { cookies, headers } from 'next/headers';\n\nexport default async function ProfilePage() {\n  const cookieStore = cookies();\n  const headersList = headers();\n  return <div>Hello</div>;\n}",
      'utf-8',
    );

    // Step 5: Extract code from disk
    const diskFiles = await extractCodeFromDisk(workDir);
    expect(diskFiles['app/profile/page.tsx']).toBeDefined();
    expect(diskFiles['app/profile/page.tsx']).toContain('cookies()');
    expect(diskFiles['app/profile/page.tsx']).toContain('headers()');

    // Step 6: Cleanup
    await rm(workDir, { recursive: true, force: true });
    expect(await pathExists(workDir)).toBe(false);
  });

  test('context7 condition gets Context7 MCP server in config', async () => {
    const task = makeTask({ id: 'test-context7' });
    const workDir = await createWorkDir(task.id, 'context7', 0, TEST_TEMP_DIR);

    await injectConfig(workDir, 'context7', { mcpConfigDir: getMcpConfigDir() });

    const config = JSON.parse(await readFile(join(workDir, '.opencode.json'), 'utf-8'));
    expect(config.mcpServers.context7).toBeDefined();
    expect(config.mcpServers.context7.command).toBe('npx');
    expect(config.mcpServers.context7.args).toEqual(['-y', '@context7/mcp']);
  });

  test('nia condition gets Nia MCP server in config', async () => {
    const task = makeTask({ id: 'test-nia' });
    const workDir = await createWorkDir(task.id, 'nia', 0, TEST_TEMP_DIR);

    await injectConfig(workDir, 'nia', { mcpConfigDir: getMcpConfigDir() });

    const config = JSON.parse(await readFile(join(workDir, '.opencode.json'), 'utf-8'));
    expect(config.mcpServers.nia).toBeDefined();
    expect(config.mcpServers.nia.command).toBe('npx');
  });

  test('disk files preferred over response files in extraction', async () => {
    const workDir = await createWorkDir('task-1', 'baseline', 0, TEST_TEMP_DIR);

    // Simulate agent writing a file to disk
    await writeFile(
      join(workDir, 'proxy.ts'),
      'export function proxy() { /* disk version */ }',
      'utf-8',
    );

    // Simulate extracting from response (would give different code)
    const responseFiles = extractCodeFromResponse(
      JSON.stringify({
        response: '```typescript\nexport function proxy() { /* response version */ }\n```',
      }),
    );

    // Disk files should be preferred
    const diskFiles = await extractCodeFromDisk(workDir);
    const extractedFiles = Object.keys(diskFiles).length > 0 ? diskFiles : responseFiles;

    expect(Object.values(extractedFiles)[0]).toContain('disk version');
    expect(Object.values(extractedFiles)[0]).not.toContain('response version');
  });

  test('falls back to response files when no disk files exist', async () => {
    const workDir = await createWorkDir('task-1', 'baseline', 0, TEST_TEMP_DIR);

    // No files written to disk

    const responseFiles = extractCodeFromResponse(
      JSON.stringify({
        response: '```typescript\nexport function proxy() { /* response version */ }\n```',
      }),
    );

    const diskFiles = await extractCodeFromDisk(workDir);
    const extractedFiles = Object.keys(diskFiles).length > 0 ? diskFiles : responseFiles;

    expect(Object.values(extractedFiles)[0]).toContain('response version');
  });

  test('multi-file task: extracts all agent-written files', async () => {
    const workDir = await createWorkDir('task-1', 'baseline', 0, TEST_TEMP_DIR);
    await mkdir(join(workDir, 'app', '@children'), { recursive: true });

    await writeFile(join(workDir, 'app', 'page.tsx'), 'export default function Page() {}', 'utf-8');
    await writeFile(
      join(workDir, 'app', '@children', 'default.tsx'),
      'export default function Default() {}',
      'utf-8',
    );
    await writeFile(
      join(workDir, 'app', 'layout.tsx'),
      'export default function Layout() {}',
      'utf-8',
    );

    const diskFiles = await extractCodeFromDisk(workDir);
    expect(Object.keys(diskFiles)).toHaveLength(3);
    expect(diskFiles['app/page.tsx']).toContain('Page');
  });
});

describe('edge cases', () => {
  test('extractCodeFromResponse handles malformed JSON gracefully', () => {
    const malformed = '{response: not valid json';
    // Should fall back to treating it as raw text
    const files = extractCodeFromResponse(malformed);
    // No code blocks in that string
    expect(Object.keys(files)).toHaveLength(0);
  });

  test('extractCodeFromResponse handles empty code blocks', () => {
    const response = JSON.stringify({
      response: '```typescript\n\n```',
    });

    const files = extractCodeFromResponse(response);
    // Empty code block should be skipped (trim results in empty string)
    expect(Object.keys(files)).toHaveLength(0);
  });

  test('extractCodeFromDisk handles non-existent directory gracefully', async () => {
    const files = await extractCodeFromDisk('/tmp/nia-bench-test/nonexistent-dir-12345');
    expect(Object.keys(files)).toHaveLength(0);
  });

  test('injectContext handles task with empty context object', async () => {
    const workDir = await createWorkDir('task-1', 'baseline', 0, TEST_TEMP_DIR);
    const task = makeTask({ context: {} });

    // Should not throw
    await injectContext(workDir, task);

    const entries = await readdir(workDir);
    expect(entries).toHaveLength(0);
  });

  test('injectConfig throws on non-existent config directory', async () => {
    const workDir = await createWorkDir('task-1', 'baseline', 0, TEST_TEMP_DIR);

    await expect(
      injectConfig(workDir, 'baseline', { mcpConfigDir: '/tmp/nonexistent-config-dir' }),
    ).rejects.toThrow();
  });
});
