import { resolve } from "node:path";
import { loadTasks } from "@/loader";
import type { Condition } from "./agent";
import {
	checkOpencodeBinary,
	DEFAULT_MODEL,
	getOpencodeVersion,
	runAgent,
} from "./agent";
import type { EvaluatorConfig } from "./evaluator";
import { evaluateCode } from "./evaluator";
import { generateAndWriteReport } from "./reporter";
import type { RunMetadata } from "./result-store";
import { createRunDir, storeResult, writeRunMetadata } from "./result-store";

// --- Types ---

/**
 * A single unit of work in the benchmark: one (task, condition, rep) tuple.
 */
export interface WorkItem {
	/** Task ID */
	taskId: string;
	/** Condition to test */
	condition: Condition;
	/** Repetition index (0-based) */
	repIndex: number;
}

/**
 * CLI configuration parsed from command-line arguments.
 */
export interface CliConfig {
	/** Filter by task category */
	category?: string;
	/** Filter by library */
	library?: string;
	/** Filter by specific task ID */
	task?: string;
	/** Filter by condition */
	condition?: Condition;
	/** Number of repetitions per task/condition (default: 3) */
	reps: number;
	/** Max parallel workers (default: 1) */
	parallel: number;
	/** Skip LLM judge evaluation */
	skipJudge: boolean;
	/** Keep working directories after execution */
	keepWorkdirs: boolean;
	/** Output directory for results (default: results/) */
	outputDir: string;
	/** Timeout per agent execution in ms (default: 300000) */
	timeout: number;
	/** Random seed for execution order (default: random) */
	seed: number;
	/** Dry run — print execution plan without running */
	dryRun: boolean;
	/** Eval-only — re-run evaluation on existing results */
	evalOnly: boolean;
	/** Report-only — generate report from existing results */
	reportOnly: boolean;
	/** Tasks directory path */
	tasksDir: string;
	/** Project root directory */
	projectRoot: string;
	/**
	 * Model ID to use for the agent in provider/model format.
	 * Overrides the model in .opencode.json configs via --model flag.
	 * Example: "anthropic/claude-sonnet-4-20250514"
	 */
	model?: string;
}

// --- Seeded Random ---

/**
 * Simple mulberry32 PRNG for reproducible shuffling.
 * Returns a function that produces values in [0, 1).
 */
export function createSeededRandom(seed: number): () => number {
	let s = seed | 0;
	return () => {
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Fisher-Yates shuffle with a seeded random number generator.
 */
export function shuffleArray<T>(arr: T[], rng: () => number): T[] {
	const result = [...arr];
	for (let i = result.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		const temp = result[i] as T;
		result[i] = result[j] as T;
		result[j] = temp;
	}
	return result;
}

// --- Work Queue ---

/**
 * Generates the full work queue from tasks, conditions, and reps.
 * Each item is a (taskId, condition, repIndex) tuple.
 */
export function generateWorkQueue(
	taskIds: string[],
	conditions: Condition[],
	reps: number,
): WorkItem[] {
	const items: WorkItem[] = [];

	for (const taskId of taskIds) {
		for (const condition of conditions) {
			for (let repIndex = 0; repIndex < reps; repIndex++) {
				items.push({ taskId, condition, repIndex });
			}
		}
	}

	return items;
}

// --- Progress Logger ---

/**
 * Thread-safe progress logger that tracks completed items and estimates ETA.
 */
export class ProgressLogger {
	private completed = 0;
	private readonly total: number;
	private readonly startTime: number;
	private readonly recentDurations: number[] = [];
	private readonly maxRecentDurations = 10;

	constructor(total: number) {
		this.total = total;
		this.startTime = Date.now();
	}

	/**
	 * Logs progress for a completed work item.
	 */
	log(item: WorkItem, durationMs: number): void {
		this.completed++;
		this.recentDurations.push(durationMs);
		if (this.recentDurations.length > this.maxRecentDurations) {
			this.recentDurations.shift();
		}

		const elapsed = Date.now() - this.startTime;
		const eta = this.estimateEta();

		console.log(
			`[${this.completed}/${this.total}] Task: ${item.taskId} | Condition: ${item.condition} | Rep: ${item.repIndex + 1} | Elapsed: ${formatDuration(elapsed)} | ETA: ${eta}`,
		);
	}

	/**
	 * Estimates remaining time based on rolling average of recent execution durations.
	 */
	private estimateEta(): string {
		if (this.recentDurations.length === 0 || this.completed === 0)
			return "calculating...";

		const avgDuration =
			this.recentDurations.reduce((sum, d) => sum + d, 0) /
			this.recentDurations.length;
		const remaining = this.total - this.completed;
		const etaMs = avgDuration * remaining;

		return formatDuration(etaMs);
	}

	getCompleted(): number {
		return this.completed;
	}
}

/**
 * Formats milliseconds into a human-readable duration string.
 */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;

	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);

	if (hours > 0) {
		return `${hours}h${(minutes % 60).toString().padStart(2, "0")}m`;
	}
	if (minutes > 0) {
		return `${minutes}m${(seconds % 60).toString().padStart(2, "0")}s`;
	}
	return `${seconds}s`;
}

// --- Concurrency Limiter ---

/**
 * Simple async semaphore for controlling concurrency.
 */
export class AsyncSemaphore {
	private running = 0;
	private readonly maxConcurrency: number;
	private readonly waitQueue: (() => void)[] = [];

	constructor(maxConcurrency: number) {
		this.maxConcurrency = maxConcurrency;
	}

	async acquire(): Promise<void> {
		if (this.running < this.maxConcurrency) {
			this.running++;
			return;
		}

		return new Promise<void>((resolve) => {
			this.waitQueue.push(() => {
				this.running++;
				resolve();
			});
		});
	}

	release(): void {
		this.running--;
		const next = this.waitQueue.shift();
		if (next) {
			next();
		}
	}
}

// --- CLI Argument Parsing ---

/**
 * Parses command-line arguments into a CliConfig object.
 */
export function parseCliArgs(argv: string[]): CliConfig {
	const args = argv.slice(2); // Remove 'bun' and script path

	const config: CliConfig = {
		reps: 3,
		parallel: 1,
		skipJudge: false,
		keepWorkdirs: false,
		outputDir: "results",
		timeout: 300_000,
		seed: Math.floor(Math.random() * 2147483647),
		dryRun: false,
		evalOnly: false,
		reportOnly: false,
		tasksDir: resolve(process.cwd(), "tasks"),
		projectRoot: process.cwd(),
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		switch (arg) {
			case "--category":
				config.category = args[++i];
				break;
			case "--library":
				config.library = args[++i];
				break;
			case "--task":
				config.task = args[++i];
				break;
			case "--condition":
				config.condition = args[++i] as Condition;
				break;
			case "--reps":
				config.reps = Number.parseInt(args[++i] ?? "3", 10);
				break;
			case "--parallel":
				config.parallel = Number.parseInt(args[++i] ?? "1", 10);
				break;
			case "--skip-judge":
				config.skipJudge = true;
				break;
			case "--keep-workdirs":
				config.keepWorkdirs = true;
				break;
			case "--output-dir":
				config.outputDir = args[++i] ?? "results";
				break;
			case "--timeout":
				config.timeout = Number.parseInt(args[++i] ?? "300000", 10);
				break;
			case "--seed":
				config.seed = Number.parseInt(args[++i] ?? "0", 10);
				break;
			case "--dry-run":
				config.dryRun = true;
				break;
			case "--eval-only":
				config.evalOnly = true;
				break;
			case "--report-only":
				config.reportOnly = true;
				break;
			case "--tasks-dir":
				config.tasksDir = resolve(args[++i] ?? "tasks");
				break;
			case "--model":
				config.model = args[++i];
				break;
		}
	}

	return config;
}

// --- Main Orchestrator ---

/**
 * Main orchestrator function that runs the benchmark pipeline.
 */
export async function runBenchmark(config: CliConfig): Promise<void> {
	// Report-only mode: generate report from existing results
	if (config.reportOnly) {
		console.log(`Report-only mode: generating report from ${config.outputDir}`);
		await generateAndWriteReport(config.outputDir);
		return;
	}

	// Load tasks
	const { tasks, errors } = await loadTasks(config.tasksDir, {
		category: config.category as
			| "bleeding_edge"
			| "version_locked_write"
			| "version_locked_audit"
			| undefined,
		library: config.library as
			| "next"
			| "react"
			| "ai"
			| "trpc"
			| "zod"
			| undefined,
		id: config.task,
	});

	if (errors.length > 0) {
		console.warn(`\nWarning: ${errors.length} task file(s) failed validation:`);
		for (const err of errors) {
			console.warn(`  ${err.filePath}: ${err.error}`);
		}
	}

	if (tasks.length === 0) {
		console.error("No tasks found matching the specified filters.");
		process.exit(1);
	}

	console.log(`Loaded ${tasks.length} task(s)`);

	// Build task lookup map
	const taskMap = new Map(tasks.map((t) => [t.id, t]));

	// Determine conditions
	const conditions: Condition[] = config.condition
		? [config.condition]
		: ["baseline", "context7", "nia"];

	// Generate work queue
	const taskIds = tasks.map((t) => t.id);
	const rawQueue = generateWorkQueue(taskIds, conditions, config.reps);

	// Shuffle with seeded random
	const rng = createSeededRandom(config.seed);
	const workQueue = shuffleArray(rawQueue, rng);

	console.log(
		`Work queue: ${workQueue.length} items (${tasks.length} tasks x ${conditions.length} conditions x ${config.reps} reps)`,
	);
	const resolvedModel = config.model ?? DEFAULT_MODEL;
	console.log(
		`Seed: ${config.seed} | Parallel: ${config.parallel} | Model: ${resolvedModel}`,
	);

	// Dry run: print execution plan and exit
	if (config.dryRun) {
		console.log("\n--- Execution Plan (Dry Run) ---\n");
		for (let i = 0; i < workQueue.length; i++) {
			const item = workQueue[i];
			if (!item) continue;
			console.log(
				`  ${(i + 1).toString().padStart(4)}. Task: ${item.taskId} | Condition: ${item.condition} | Rep: ${item.repIndex + 1}`,
			);
		}
		console.log(`\nTotal: ${workQueue.length} items`);
		return;
	}

	// Eval-only mode: re-run evaluation on existing results
	if (config.evalOnly) {
		console.log(`Eval-only mode: re-running evaluation on ${config.outputDir}`);
		console.log("Eval-only mode not yet fully implemented. Exiting.");
		return;
	}

	// Check opencode binary
	const hasOpencode = await checkOpencodeBinary();
	if (!hasOpencode) {
		console.error(
			"Error: opencode CLI not found on PATH. Install it first: https://github.com/opencode-ai/opencode",
		);
		process.exit(1);
	}

	// Capture opencode version
	const opencodeVersion = await getOpencodeVersion();
	if (opencodeVersion) {
		console.log(`OpenCode version: ${opencodeVersion}`);
	} else {
		console.warn("Warning: Could not determine opencode version");
	}

	// Create results directory
	const runDir = await createRunDir(config.outputDir);
	console.log(`Results directory: ${runDir}`);

	// Write initial run metadata
	const metadata: RunMetadata = {
		startTime: new Date().toISOString(),
		endTime: "",
		totalTasks: tasks.length,
		conditions,
		reps: config.reps,
		parallel: config.parallel,
		seed: config.seed,
		model: resolvedModel,
		opencodeVersion: opencodeVersion ?? "unknown",
		cliArgs: process.argv.slice(2),
		status: "running",
		completedItems: 0,
		totalItems: workQueue.length,
	};
	await writeRunMetadata(runDir, metadata);

	// Set up progress logger
	const progress = new ProgressLogger(workQueue.length);

	// Set up graceful interruption handling
	let interrupted = false;

	const handleSignal = async () => {
		if (interrupted) return; // Prevent double handling
		interrupted = true;
		console.log(
			"\n\nInterrupted! Waiting for in-flight workers to complete...",
		);

		// Update metadata
		metadata.status = "interrupted";
		metadata.endTime = new Date().toISOString();
		metadata.completedItems = progress.getCompleted();
		await writeRunMetadata(runDir, metadata);
	};

	process.on("SIGINT", handleSignal);
	process.on("SIGTERM", handleSignal);

	// Execute work items with concurrency control
	const semaphore = new AsyncSemaphore(config.parallel);
	const evaluatorConfig: EvaluatorConfig = {
		skipJudge: config.skipJudge,
	};

	const promises = workQueue.map(async (item) => {
		if (interrupted) return; // Stop spawning new work

		await semaphore.acquire();

		if (interrupted) {
			semaphore.release();
			return;
		}

		try {
			const task = taskMap.get(item.taskId);
			if (!task) {
				console.error(`Task not found: ${item.taskId}`);
				return;
			}

			const startMs = Date.now();

			// Run agent
			const agentResult = await runAgent(task, item.condition, item.repIndex, {
				keepWorkdirs: config.keepWorkdirs,
				timeout: config.timeout,
				projectRoot: config.projectRoot,
				model: config.model,
			});

			// Log warnings for agent failures
			if (agentResult.error) {
				console.warn(
					`  ⚠ Agent error [${item.taskId}/${item.condition}/rep${item.repIndex}]: ${agentResult.error.name}: ${agentResult.error.message}`,
				);
			} else if (
				Object.keys(agentResult.extractedFiles).length === 0 &&
				agentResult.exitCode === 0
			) {
				console.warn(
					`  ⚠ No code extracted [${item.taskId}/${item.condition}/rep${item.repIndex}]: Agent produced no code files (exit code 0)`,
				);
			}

			// Evaluate result
			const evalResult = await evaluateCode(
				task,
				agentResult.extractedFiles,
				item.condition,
				item.repIndex,
				evaluatorConfig,
				agentResult.toolCalls,
				agentResult.error,
			);

			// Store result
			await storeResult(runDir, evalResult);

			const durationMs = Date.now() - startMs;
			progress.log(item, durationMs);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(
				`Error on ${item.taskId}/${item.condition}/rep${item.repIndex}: ${message}`,
			);
		} finally {
			semaphore.release();
		}
	});

	await Promise.allSettled(promises);

	// Clean up signal handlers
	process.off("SIGINT", handleSignal);
	process.off("SIGTERM", handleSignal);

	// Update final metadata
	metadata.status = interrupted ? "interrupted" : "completed";
	metadata.endTime = new Date().toISOString();
	metadata.completedItems = progress.getCompleted();
	await writeRunMetadata(runDir, metadata);

	console.log(`\nBenchmark ${metadata.status}. Results: ${runDir}`);
	console.log(
		`Completed: ${progress.getCompleted()}/${workQueue.length} items`,
	);

	// Generate report from the completed run
	if (progress.getCompleted() > 0) {
		console.log("\nGenerating report...\n");
		await generateAndWriteReport(runDir);
	}
}
