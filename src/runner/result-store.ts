import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvaluationResult } from "./evaluator";

// --- Types ---

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
	/** Random seed for execution order */
	seed: number;
	/** Resolved model ID used for agent runs (provider/model format) */
	model: string;
	/** Raw CLI arguments */
	cliArgs: string[];
	/** Status of the run */
	status: "running" | "completed" | "interrupted";
	/** Number of completed work items */
	completedItems: number;
	/** Total number of work items */
	totalItems: number;
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
