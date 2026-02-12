import { resolve } from "node:path";
import { loadTasks } from "@/loader";
import type { Task } from "@/types/task";
import type { Condition } from "./agent";
import {
	buildPrompt,
	checkOpencodeBinary,
	cleanupAgentDirs,
	DEFAULT_MODEL,
	getOpencodeVersion,
	runAgent,
} from "./agent";
import type { EvaluatorConfig } from "./evaluator";
import { evaluateCode } from "./evaluator";
import { ensureNiaSetup } from "./nia-setup";
import { generateAndWriteReport } from "./reporter";
import type { RunMetadata } from "./result-store";
import {
	copyWorkdir,
	createRunDir,
	storeResult,
	storeToolCalls,
	storeTranscript,
	writeRunMetadata,
} from "./result-store";

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
	/** Filter by condition(s) — can specify multiple */
	conditions?: Condition[];
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
	/** Maximum retries per agent execution on non-zero exit (default: 3) */
	maxRetries: number;
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
	/** Skip Nia setup phase that indexes required docs/repos (default: false) */
	skipNiaSetup: boolean;
	/** Maximum number of tasks to run, stratified proportionally by category (optional) */
	limit?: number;
	/** Skip storing artifacts (transcript, tool calls, workdir snapshot) for faster iteration */
	skipArtifacts: boolean;
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

// --- Stratified Sampling ---

/**
 * Selects a stratified sample of tasks proportional to category distribution.
 *
 * Uses the largest-remainder method (Hamilton method) for fair rounding:
 *   1. Compute each category's ideal (fractional) share of the limit.
 *   2. Give each category floor(share) tasks.
 *   3. Distribute remaining slots to categories with the largest fractional remainders.
 *
 * Within each category, tasks are shuffled with the provided seeded RNG before selection,
 * so the same seed always produces the same subset.
 *
 * @param tasks  - Full list of tasks (already filtered by --category/--library/--task)
 * @param limit  - Maximum total tasks to return
 * @param rng    - Seeded random number generator for reproducible selection
 * @returns Subset of tasks with proportional category representation
 */
export function stratifiedSample(
	tasks: Task[],
	limit: number,
	rng: () => number,
): Task[] {
	if (limit >= tasks.length) return tasks;

	// Group tasks by category
	const groups = new Map<string, Task[]>();
	for (const task of tasks) {
		const existing = groups.get(task.category) ?? [];
		existing.push(task);
		groups.set(task.category, existing);
	}

	// Compute proportional allocation using largest-remainder method
	const categories = [...groups.keys()];
	const total = tasks.length;

	// Step 1: Compute ideal shares and floor allocations
	const allocations: { category: string; floor: number; remainder: number }[] =
		categories.map((cat) => {
			const groupSize = groups.get(cat)?.length ?? 0;
			const ideal = (groupSize / total) * limit;
			const floor = Math.floor(ideal);
			return { category: cat, floor, remainder: ideal - floor };
		});

	// Step 2: Distribute remaining slots by largest remainder
	const allocated = allocations.reduce((sum, a) => sum + a.floor, 0);
	let remaining = limit - allocated;

	// Sort by remainder descending to assign extras fairly
	const sorted = [...allocations].sort((a, b) => b.remainder - a.remainder);
	for (const entry of sorted) {
		if (remaining <= 0) break;
		entry.floor++;
		remaining--;
	}

	// Step 3: Shuffle each group and take the allocated count
	const result: Task[] = [];
	for (const alloc of allocations) {
		const group = groups.get(alloc.category) ?? [];
		const shuffled = shuffleArray(group, rng);
		result.push(...shuffled.slice(0, alloc.floor));
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
		timeout: 900_000,
		maxRetries: 3,
		seed: Math.floor(Math.random() * 2147483647),
		dryRun: false,
		evalOnly: false,
		reportOnly: false,
		tasksDir: resolve(process.cwd(), "tasks"),
		projectRoot: process.cwd(),
		skipNiaSetup: false,
		skipArtifacts: false,
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
			case "--condition": {
				const val = args[++i] as Condition;
				if (!config.conditions) config.conditions = [];
				if (!config.conditions.includes(val)) config.conditions.push(val);
				break;
			}
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
				config.timeout = Number.parseInt(args[++i] ?? "900000", 10);
				break;
			case "--max-retries":
				config.maxRetries = Number.parseInt(args[++i] ?? "3", 10);
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
			case "--skip-nia-setup":
				config.skipNiaSetup = true;
				break;
			case "--limit":
				config.limit = Number.parseInt(args[++i] ?? "0", 10);
				break;
			case "--skip-artifacts":
				config.skipArtifacts = true;
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

	// Apply stratified limit if requested
	let selectedTasks = tasks;
	if (config.limit != null && config.limit > 0 && config.limit < tasks.length) {
		const sampleRng = createSeededRandom(config.seed);
		selectedTasks = stratifiedSample(tasks, config.limit, sampleRng);

		// Log the category breakdown
		const breakdown = new Map<string, number>();
		for (const t of selectedTasks) {
			breakdown.set(t.category, (breakdown.get(t.category) ?? 0) + 1);
		}
		const breakdownStr = [...breakdown.entries()]
			.map(([cat, count]) => `${cat}=${count}`)
			.join(", ");
		console.log(
			`Stratified sample: ${selectedTasks.length} task(s) selected (${breakdownStr})`,
		);
	}

	// Build task lookup map
	const taskMap = new Map(selectedTasks.map((t) => [t.id, t]));

	// Determine conditions
	const conditions: Condition[] =
		config.conditions && config.conditions.length > 0
			? config.conditions
			: ["baseline", "context7", "nia"];

	// Generate work queue
	const taskIds = selectedTasks.map((t) => t.id);
	const rawQueue = generateWorkQueue(taskIds, conditions, config.reps);

	// Shuffle with seeded random
	const rng = createSeededRandom(config.seed);
	const workQueue = shuffleArray(rawQueue, rng);

	console.log(
		`Work queue: ${workQueue.length} items (${selectedTasks.length} tasks x ${conditions.length} conditions x ${config.reps} reps)`,
	);
	const resolvedModel = config.model ?? DEFAULT_MODEL;
	console.log(
		`Seed: ${config.seed} | Parallel: ${config.parallel} | Max retries: ${config.maxRetries} | Model: ${resolvedModel}`,
	);

	// Nia Setup Phase: ensure required docs/repos are indexed before running
	if (
		conditions.includes("nia") &&
		!config.skipNiaSetup &&
		!config.dryRun &&
		!config.evalOnly
	) {
		console.log("\n=== Nia Setup Phase ===");
		console.log("Checking required documentation and repository sources...");
		try {
			await ensureNiaSetup(selectedTasks);
			console.log("=== Nia Setup Complete ===\n");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`\n  ! Nia setup incomplete: ${msg}`);
			console.warn(
				"  Continuing — agent may have limited documentation context.\n",
			);
		}
	}

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
		totalTasks: selectedTasks.length,
		conditions,
		reps: config.reps,
		parallel: config.parallel,
		maxRetries: config.maxRetries,
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

		let agentResult: Awaited<ReturnType<typeof runAgent>> | null = null;

		try {
			const task = taskMap.get(item.taskId);
			if (!task) {
				console.error(`Task not found: ${item.taskId}`);
				return;
			}

			const startMs = Date.now();

			// Step 1: Build the prompt (stored for observability)
			const prompt = buildPrompt(task.prompt, item.condition);

			// Step 2: Run agent (workdir cleanup is deferred to after artifact storage)
			agentResult = await runAgent(task, item.condition, item.repIndex, {
				keepWorkdirs: config.keepWorkdirs,
				timeout: config.timeout,
				projectRoot: config.projectRoot,
				model: config.model,
				maxRetries: config.maxRetries,
			});

			// Log warnings for agent failures
			if (agentResult.error) {
				console.warn(
					`  ! Agent error [${item.taskId}/${item.condition}/rep${item.repIndex}]: ${agentResult.error.name}: ${agentResult.error.message}`,
				);
			} else if (
				Object.keys(agentResult.extractedFiles).length === 0 &&
				agentResult.exitCode === 0
			) {
				console.warn(
					`  ! No code extracted [${item.taskId}/${item.condition}/rep${item.repIndex}]: Agent produced no code files (exit code 0)`,
				);
			}

			// Step 3: Build tool call summary for the lean result JSON
			const toolCallCount = agentResult.toolCalls.length;
			const toolCallSummary: Record<string, number> = {};
			for (const call of agentResult.toolCalls) {
				toolCallSummary[call.tool] = (toolCallSummary[call.tool] ?? 0) + 1;
			}

			// Step 4: Evaluate result
			const evalResult = await evaluateCode(
				task,
				agentResult.extractedFiles,
				item.condition,
				item.repIndex,
				evaluatorConfig,
				{
					prompt,
					durationMs: agentResult.durationMs,
					toolCallCount,
					toolCallSummary,
					agentError: agentResult.error,
					attempts: agentResult.attempts,
				},
			);

			// Step 5: Store evaluation result (lean scorecard JSON)
			await storeResult(runDir, evalResult);

			// Step 6: Store artifacts (transcript, tool calls, workdir snapshot)
			if (!config.skipArtifacts) {
				await Promise.all([
					storeTranscript(
						runDir,
						item.taskId,
						item.condition,
						item.repIndex,
						agentResult.rawOutput,
					),
					storeToolCalls(
						runDir,
						item.taskId,
						item.condition,
						item.repIndex,
						agentResult.toolCalls,
					),
					copyWorkdir(
						runDir,
						item.taskId,
						item.condition,
						item.repIndex,
						agentResult.workDir,
					),
				]);
			}

			const durationMs = Date.now() - startMs;
			progress.log(item, durationMs);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(
				`Error on ${item.taskId}/${item.condition}/rep${item.repIndex}: ${message}`,
			);
		} finally {
			// Clean up temp dirs now that artifacts are stored
			if (agentResult) {
				await cleanupAgentDirs(agentResult, config.keepWorkdirs);
			}
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
