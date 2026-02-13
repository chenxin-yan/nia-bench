import {
	copyFile,
	mkdir,
	readdir,
	rename,
	stat,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { ToolCall } from "./agent";
import type { EvaluationResult } from "./evaluator";

// --- Types ---

/**
 * Smoke-test result for a single Nia source.
 *
 * After indexing completes, each source is probed with a lightweight search
 * query to verify it contains meaningful content (not 404 pages, empty
 * indices, or error responses). Results are stored in `RunMetadata` so
 * source quality can be correlated with task-level scores.
 */
export interface SourceReadiness {
	/** Source UUID from the Nia API. */
	sourceId: string;
	/** Human-readable name (e.g., "Next.js 16 Docs"). */
	displayName: string;
	/** Whether the source was resolved from the global registry. */
	global: boolean;
	/** Whether the smoke-test query returned meaningful content. */
	healthy: boolean;
	/** Short reason if unhealthy (e.g., "indexed 404 page", "empty content"). */
	issue?: string;
	/** Latency of the smoke-test query in ms. */
	latencyMs: number;
}

/**
 * Metadata about a benchmark run.
 */
export interface RunMetadata {
	/** ISO timestamp when the run started */
	startTime: string;
	/** ISO timestamp when the run ended (updated on completion) */
	endTime: string;
	/** Total number of tasks in the run */
	totalTasks: number;
	/** Conditions used in the run */
	conditions: string[];
	/** Number of repetitions per task/condition */
	reps: number;
	/** Parallel worker count */
	parallel: number;
	/** Maximum retries per agent execution on non-zero exit */
	maxRetries: number;
	/** Random seed for execution order */
	seed: number;
	/** Resolved model ID used for agent runs (provider/model format) */
	model: string;
	/** Installed opencode CLI version */
	opencodeVersion: string;
	/** Raw CLI arguments */
	cliArgs: string[];
	/** Status of the run */
	status: "running" | "completed" | "interrupted";
	/** Number of completed work items */
	completedItems: number;
	/** Total number of work items */
	totalItems: number;
	/** Per-source readiness from the Nia setup smoke test (nia condition only). */
	sourceReadiness?: SourceReadiness[];
}

// --- Functions ---

/**
 * Creates the results directory structure for a new run.
 * Returns the run directory path.
 *
 * Structure: results/{timestamp}/
 */
export async function createRunDir(outputDir: string): Promise<string> {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const runDir = join(outputDir, timestamp);
	await mkdir(runDir, { recursive: true });
	return runDir;
}

/**
 * Stores an evaluation result as a JSON file.
 *
 * Path: {runDir}/{taskId}/{condition}/run-{index}.json
 *
 * Uses atomic write (write to temp file, then rename) to avoid corruption
 * from parallel workers.
 */
export async function storeResult(
	runDir: string,
	result: EvaluationResult,
): Promise<string> {
	const resultDir = join(runDir, result.taskId, result.condition);
	await mkdir(resultDir, { recursive: true });

	const filename = `run-${result.runIndex}.json`;
	const filePath = join(resultDir, filename);
	const tempPath = `${filePath}.tmp`;

	const json = JSON.stringify(result, null, 2);
	await writeFile(tempPath, json, "utf-8");
	await rename(tempPath, filePath);

	return filePath;
}

/**
 * Writes or updates the run metadata file.
 *
 * Path: {runDir}/run-meta.json
 */
export async function writeRunMetadata(
	runDir: string,
	metadata: RunMetadata,
): Promise<void> {
	const filePath = join(runDir, "run-meta.json");
	const tempPath = `${filePath}.tmp`;

	const json = JSON.stringify(metadata, null, 2);
	await writeFile(tempPath, json, "utf-8");
	await rename(tempPath, filePath);
}

// --- Artifact Storage ---

/**
 * Stores the full agent transcript (raw NDJSON event stream) as a separate file.
 *
 * Path: {runDir}/{taskId}/{condition}/transcript-{index}.ndjson
 *
 * This contains the complete opencode output including all text responses,
 * tool calls with inputs and outputs, step markers, and error events.
 */
export async function storeTranscript(
	runDir: string,
	taskId: string,
	condition: string,
	runIndex: number,
	rawOutput: string,
): Promise<string> {
	const resultDir = join(runDir, taskId, condition);
	await mkdir(resultDir, { recursive: true });

	const filename = `transcript-${runIndex}.ndjson`;
	const filePath = join(resultDir, filename);
	const tempPath = `${filePath}.tmp`;

	await writeFile(tempPath, rawOutput, "utf-8");
	await rename(tempPath, filePath);

	return filePath;
}

/**
 * Stores the full tool call details (with inputs and outputs) as a separate file.
 *
 * Path: {runDir}/{taskId}/{condition}/tool-calls-{index}.json
 *
 * This is the structured, queryable version of tool usage — richer than the
 * summary in run-{index}.json, which only stores counts.
 */
export async function storeToolCalls(
	runDir: string,
	taskId: string,
	condition: string,
	runIndex: number,
	toolCalls: ToolCall[],
): Promise<string> {
	const resultDir = join(runDir, taskId, condition);
	await mkdir(resultDir, { recursive: true });

	const filename = `tool-calls-${runIndex}.json`;
	const filePath = join(resultDir, filename);
	const tempPath = `${filePath}.tmp`;

	const json = JSON.stringify(toolCalls, null, 2);
	await writeFile(tempPath, json, "utf-8");
	await rename(tempPath, filePath);

	return filePath;
}

/**
 * Directories and files to exclude when copying the working directory snapshot.
 * These are either too large, generated/cached, or not relevant for debugging.
 */
const WORKDIR_COPY_EXCLUDES = new Set([
	"node_modules",
	".opencode",
	"bun.lock",
	"package-lock.json",
]);

/**
 * Copies the agent's working directory into the results directory as a snapshot.
 *
 * Path: {runDir}/{taskId}/{condition}/workdir-{index}/
 *
 * Contains the opencode config, task context files, and agent-written code files.
 * Excludes node_modules, .opencode session data, and lock files.
 */
export async function copyWorkdir(
	runDir: string,
	taskId: string,
	condition: string,
	runIndex: number,
	sourceWorkDir: string,
): Promise<string> {
	const resultDir = join(runDir, taskId, condition);
	const destDir = join(resultDir, `workdir-${runIndex}`);
	await mkdir(destDir, { recursive: true });

	await copyDirFiltered(sourceWorkDir, destDir);

	return destDir;
}

/**
 * Recursively copies a directory, excluding entries in WORKDIR_COPY_EXCLUDES.
 */
async function copyDirFiltered(src: string, dest: string): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(src);
	} catch {
		return;
	}

	for (const entry of entries) {
		if (WORKDIR_COPY_EXCLUDES.has(entry)) continue;

		const srcPath = join(src, entry);
		const destPath = join(dest, entry);

		try {
			const entryStat = await stat(srcPath);

			if (entryStat.isDirectory()) {
				await mkdir(destPath, { recursive: true });
				await copyDirFiltered(srcPath, destPath);
			} else if (entryStat.isFile()) {
				await copyFile(srcPath, destPath);
			}
		} catch {
			// Skip unreadable entries
		}
	}
}
