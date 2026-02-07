import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Task } from '@/types/task';

// --- Types ---

export type Condition = 'baseline' | 'context7' | 'nia';

export interface AgentResult {
  /** Task ID from the task definition */
  taskId: string;
  /** Which condition was used (baseline, context7, nia) */
  condition: Condition;
  /** Repetition index (0-based) */
  runIndex: number;
  /** Raw stdout output from opencode */
  rawOutput: string;
  /** Extracted code files: filename -> code content */
  extractedFiles: Record<string, string>;
  /** Exit code from opencode process */
  exitCode: number;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Path to the working directory used for this run */
  workDir: string;
}

export interface AgentRunnerConfig {
  /** Whether to keep working directories after execution (for debugging) */
  keepWorkdirs?: boolean;
  /** Timeout in milliseconds per agent execution (default: 300_000 = 5 min) */
  timeout?: number;
  /** Base directory for temp working dirs (default: /tmp/nia-bench) */
  tempBaseDir?: string;
  /** Directory containing MCP config files (default: auto-resolved from module location) */
  mcpConfigDir?: string;
  /** Project root directory (for resolving default paths) */
  projectRoot?: string;
}

// --- Constants ---

const DEFAULT_TIMEOUT = 300_000; // 5 minutes
const DEFAULT_TEMP_BASE = '/tmp/nia-bench';
const CODE_FILE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];
const CONFIG_FILE_MAP: Record<Condition, string> = {
  baseline: 'baseline.opencode.json',
  context7: 'context7.opencode.json',
  nia: 'nia.opencode.json',
};

// --- Utility Functions ---

/**
 * Resolves the MCP config directory. Defaults to the mcp_configs directory
 * relative to this module's location.
 */
function resolveMcpConfigDir(config?: AgentRunnerConfig): string {
  if (config?.mcpConfigDir) return config.mcpConfigDir;
  // Default: resolve relative to the project root
  const projectRoot = config?.projectRoot ?? resolve(import.meta.dirname, '..', '..');
  return join(projectRoot, 'src', 'runner', 'mcp_configs');
}

/**
 * Creates a unique temporary working directory for an agent execution.
 * Format: /tmp/nia-bench/{timestamp}-{taskId}-{condition}-{rep}/
 */
export async function createWorkDir(
  taskId: string,
  condition: Condition,
  runIndex: number,
  tempBaseDir: string = DEFAULT_TEMP_BASE,
): Promise<string> {
  const timestamp = Date.now();
  const dirName = `${timestamp}-${taskId}-${condition}-${runIndex}`;
  const workDir = join(tempBaseDir, dirName);
  await mkdir(workDir, { recursive: true });
  return workDir;
}

/**
 * Copies the condition-specific .opencode.json config into the working directory.
 * opencode loads config from CWD, so placing it in the workdir ensures the correct config.
 */
export async function injectConfig(
  workDir: string,
  condition: Condition,
  config?: AgentRunnerConfig,
): Promise<void> {
  const mcpConfigDir = resolveMcpConfigDir(config);
  const configFileName = CONFIG_FILE_MAP[condition];
  const srcPath = join(mcpConfigDir, configFileName);
  const destPath = join(workDir, '.opencode.json');
  await copyFile(srcPath, destPath);
}

/**
 * Writes task context files (package.json, code files) into the working directory.
 * This simulates a real project workspace for the agent.
 */
export async function injectContext(workDir: string, task: Task): Promise<void> {
  if (!task.context) return;

  // Write package.json if provided
  if (task.context.package_json) {
    await writeFile(join(workDir, 'package.json'), task.context.package_json, 'utf-8');
  }

  // Write code files if provided
  if (task.context.code) {
    for (const [filename, content] of Object.entries(task.context.code)) {
      // Ensure parent directories exist for nested paths (e.g., "app/page.tsx")
      const filePath = join(workDir, filename);
      const parentDir = join(filePath, '..');
      await mkdir(parentDir, { recursive: true });
      await writeFile(filePath, content, 'utf-8');
    }
  }
}

/**
 * Extracts code from the agent's JSON stdout response.
 * Looks for markdown code blocks (```typescript...```, ```tsx...```, etc.)
 */
export function extractCodeFromResponse(rawOutput: string): Record<string, string> {
  const files: Record<string, string> = {};

  // Try to parse as JSON first (opencode -f json returns {response: "..."})
  let responseText = rawOutput;
  try {
    const parsed = JSON.parse(rawOutput) as { response?: string };
    if (parsed.response) {
      responseText = parsed.response;
    }
  } catch {
    // Not JSON, use raw text
  }

  // Match code blocks with optional language and filename hints
  // Patterns: ```typescript, ```tsx, ```ts, ```jsx, ```js, ```javascript
  const codeBlockRegex = /```(?:typescript|tsx|ts|jsx|js|javascript)?\s*(?:\n|$)([\s\S]*?)```/g;

  let match: RegExpExecArray | null;
  let blockIndex = 0;

  // biome-ignore lint/suspicious/noAssignInExpressions: regex exec loop pattern
  while ((match = codeBlockRegex.exec(responseText)) !== null) {
    const code = match[1]?.trim();
    if (code) {
      // Try to detect filename from context before the code block
      const beforeBlock = responseText.substring(0, match.index);
      const filenameMatch = beforeBlock.match(
        /(?:file[:\s]+|filename[:\s]+|in\s+)`?([^\s`]+\.(?:tsx?|jsx?))`?\s*$/i,
      );
      const filename = filenameMatch?.[1] ?? `extracted-${blockIndex}.ts`;
      files[filename] = code;
      blockIndex++;
    }
  }

  return files;
}

/**
 * Scans the working directory for code files written by the agent.
 * Excludes known non-agent files (node_modules, .opencode.json, etc.)
 */
export async function extractCodeFromDisk(workDir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};

  async function scanDir(dir: string, prefix: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const relativePath = prefix ? `${prefix}/${entry}` : entry;

      // Skip known non-agent directories and files
      if (
        entry === 'node_modules' ||
        entry === '.opencode' ||
        entry === '.opencode.json' ||
        entry === 'package.json' ||
        entry === 'bun.lock' ||
        entry === 'package-lock.json' ||
        entry.startsWith('.')
      ) {
        continue;
      }

      try {
        const entryStat = await stat(fullPath);

        if (entryStat.isDirectory()) {
          await scanDir(fullPath, relativePath);
        } else if (entryStat.isFile()) {
          const hasCodeExtension = CODE_FILE_EXTENSIONS.some((ext) => entry.endsWith(ext));
          if (hasCodeExtension) {
            const content = await readFile(fullPath, 'utf-8');
            files[relativePath] = content;
          }
        }
      } catch {
        // Skip unreadable entries
      }
    }
  }

  await scanDir(workDir, '');
  return files;
}

/**
 * Checks if opencode CLI is available on PATH.
 */
export async function checkOpencodeBinary(): Promise<boolean> {
  try {
    const proc = Bun.spawn(['which', 'opencode'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Runs the opencode agent for a single task/condition/rep combination.
 *
 * Steps:
 * 1. Create unique temp directory
 * 2. Copy condition-specific .opencode.json config
 * 3. Inject task context files (package.json, code files)
 * 4. Invoke opencode CLI with --cwd, -p (prompt), -f json, -q (quiet)
 * 5. Extract code from both stdout response and disk files
 * 6. Clean up temp directory (unless keepWorkdirs is true)
 */
export async function runAgent(
  task: Task,
  condition: Condition,
  runIndex: number,
  config?: AgentRunnerConfig,
): Promise<AgentResult> {
  const timeout = config?.timeout ?? DEFAULT_TIMEOUT;
  const tempBaseDir = config?.tempBaseDir ?? DEFAULT_TEMP_BASE;

  // Step 1: Create unique temp directory
  const workDir = await createWorkDir(task.id, condition, runIndex, tempBaseDir);

  try {
    // Step 2: Inject condition-specific config
    await injectConfig(workDir, condition, config);

    // Step 3: Inject task context files
    await injectContext(workDir, task);

    // Step 4: Invoke opencode CLI
    const startTime = Date.now();
    let rawOutput = '';
    let exitCode = 1;

    try {
      const proc = Bun.spawn(['opencode', '-c', workDir, '-p', task.prompt, '-f', 'json', '-q'], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          // Ensure HOME is set so opencode can find its global config
          HOME: process.env.HOME ?? '/tmp',
        },
      });

      // Set up timeout
      const timeoutId = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // Process may have already exited
        }
      }, timeout);

      try {
        // Read stdout
        rawOutput = await new Response(proc.stdout).text();
        exitCode = await proc.exited;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      rawOutput = `Error running opencode: ${message}`;
      exitCode = 1;
    }

    const durationMs = Date.now() - startTime;

    // Step 5: Extract code from both sources
    const diskFiles = await extractCodeFromDisk(workDir);
    const responseFiles = extractCodeFromResponse(rawOutput);

    // Prefer files on disk (more complete), fall back to extracted code blocks
    const extractedFiles: Record<string, string> =
      Object.keys(diskFiles).length > 0 ? diskFiles : responseFiles;

    return {
      taskId: task.id,
      condition,
      runIndex,
      rawOutput,
      extractedFiles,
      exitCode,
      durationMs,
      workDir,
    };
  } finally {
    // Step 6: Cleanup (unless keepWorkdirs is true)
    if (!config?.keepWorkdirs) {
      try {
        await rm(workDir, { recursive: true, force: true });
      } catch {
        // Cleanup failure is non-fatal
      }
    }
  }
}
