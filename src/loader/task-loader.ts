import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Category, type Library, type Task, TaskSchema } from '@/types/task';

export interface TaskLoaderOptions {
  /** Filter by task category */
  category?: Category;
  /** Filter by library */
  library?: Library;
  /** Filter by specific task ID */
  id?: string;
}

export interface TaskLoadError {
  filePath: string;
  error: string;
}

export interface TaskLoadResult {
  tasks: Task[];
  errors: TaskLoadError[];
}

const TASK_SUBDIRS = ['bleeding_edge', 'version_locked_write', 'version_locked_audit'] as const;

/**
 * Loads and validates all task JSON files from the tasks/ directory.
 * Supports filtering by category, library, or individual task ID.
 */
export async function loadTasks(
  tasksDir: string,
  options: TaskLoaderOptions = {},
): Promise<TaskLoadResult> {
  const tasks: Task[] = [];
  const errors: TaskLoadError[] = [];

  for (const subdir of TASK_SUBDIRS) {
    const subdirPath = join(tasksDir, subdir);

    let files: string[];
    try {
      const entries = await readdir(subdirPath);
      files = entries.filter((f) => f.endsWith('.json'));
    } catch {
      // Subdirectory doesn't exist or can't be read — skip silently
      continue;
    }

    for (const file of files) {
      const filePath = join(subdirPath, file);

      try {
        const raw = await readFile(filePath, 'utf-8');
        const json: unknown = JSON.parse(raw);
        const result = TaskSchema.safeParse(json);

        if (!result.success) {
          const issueMessages = result.error.issues
            .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
            .join('\n');
          errors.push({
            filePath,
            error: `Validation failed:\n${issueMessages}`,
          });
          continue;
        }

        tasks.push(result.data);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({
          filePath,
          error: `Failed to read/parse JSON: ${message}`,
        });
      }
    }
  }

  // Apply filters
  const filtered = tasks.filter((task) => {
    if (options.category && task.category !== options.category) return false;
    if (options.library && task.library !== options.library) return false;
    if (options.id && task.id !== options.id) return false;
    return true;
  });

  return { tasks: filtered, errors };
}
