import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "@/types/task";
import type { EvaluationResult } from "../evaluator";
import {
	AsyncSemaphore,
	createSeededRandom,
	formatDuration,
	generateWorkQueue,
	ProgressLogger,
	parseCliArgs,
	shuffleArray,
	stratifiedSample,
} from "../orchestrator";
import type { RunMetadata } from "../result-store";
import { createRunDir, storeResult, writeRunMetadata } from "../result-store";

// --- Work Queue Generation ---

describe("generateWorkQueue", () => {
	test("generates correct number of items from 3 tasks x 2 conditions x 2 reps", () => {
		const taskIds = ["task-a", "task-b", "task-c"];
		const conditions = ["baseline", "nia"] as const;
		const queue = generateWorkQueue(taskIds, [...conditions], 2);

		expect(queue.length).toBe(12); // 3 * 2 * 2
	});

	test("all task/condition/rep combos are present", () => {
		const taskIds = ["task-a", "task-b", "task-c"];
		const conditions = ["baseline", "nia"] as const;
		const queue = generateWorkQueue(taskIds, [...conditions], 2);

		// Every combo of (task, condition, rep) should appear exactly once
		const seen = new Set<string>();
		for (const item of queue) {
			const key = `${item.taskId}|${item.condition}|${item.repIndex}`;
			expect(seen.has(key)).toBe(false);
			seen.add(key);
		}
		expect(seen.size).toBe(12);
	});

	test("generates items for single task x 3 conditions x 1 rep", () => {
		const queue = generateWorkQueue(
			["my-task"],
			["baseline", "context7", "nia"],
			1,
		);
		expect(queue.length).toBe(3);

		expect(
			queue.some((w) => w.taskId === "my-task" && w.condition === "baseline"),
		).toBe(true);
		expect(
			queue.some((w) => w.taskId === "my-task" && w.condition === "context7"),
		).toBe(true);
		expect(
			queue.some((w) => w.taskId === "my-task" && w.condition === "nia"),
		).toBe(true);
	});

	test("generates empty queue for empty task list", () => {
		const queue = generateWorkQueue([], ["baseline", "context7", "nia"], 3);
		expect(queue.length).toBe(0);
	});

	test("rep indices are 0-based and sequential", () => {
		const queue = generateWorkQueue(["task-a"], ["baseline"], 3);
		const repIndices = queue.map((w) => w.repIndex).sort();
		expect(repIndices).toEqual([0, 1, 2]);
	});
});

// --- Seeded Random & Shuffling ---

describe("createSeededRandom", () => {
	test("same seed produces same sequence", () => {
		const rng1 = createSeededRandom(42);
		const rng2 = createSeededRandom(42);

		const seq1 = Array.from({ length: 10 }, () => rng1());
		const seq2 = Array.from({ length: 10 }, () => rng2());

		expect(seq1).toEqual(seq2);
	});

	test("different seeds produce different sequences", () => {
		const rng1 = createSeededRandom(42);
		const rng2 = createSeededRandom(99);

		const seq1 = Array.from({ length: 10 }, () => rng1());
		const seq2 = Array.from({ length: 10 }, () => rng2());

		expect(seq1).not.toEqual(seq2);
	});

	test("values are in [0, 1) range", () => {
		const rng = createSeededRandom(42);
		for (let i = 0; i < 100; i++) {
			const val = rng();
			expect(val).toBeGreaterThanOrEqual(0);
			expect(val).toBeLessThan(1);
		}
	});
});

describe("shuffleArray", () => {
	test("same seed produces same shuffle order", () => {
		const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

		const rng1 = createSeededRandom(42);
		const rng2 = createSeededRandom(42);

		const shuffled1 = shuffleArray(items, rng1);
		const shuffled2 = shuffleArray(items, rng2);

		expect(shuffled1).toEqual(shuffled2);
	});

	test("different seed produces different order", () => {
		const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

		const rng1 = createSeededRandom(42);
		const rng2 = createSeededRandom(99);

		const shuffled1 = shuffleArray(items, rng1);
		const shuffled2 = shuffleArray(items, rng2);

		expect(shuffled1).not.toEqual(shuffled2);
	});

	test("preserves all elements after shuffle", () => {
		const items = ["a", "b", "c", "d", "e"];
		const rng = createSeededRandom(42);
		const shuffled = shuffleArray(items, rng);

		expect(shuffled.sort()).toEqual([...items].sort());
	});

	test("does not mutate the original array", () => {
		const items = [1, 2, 3, 4, 5];
		const original = [...items];
		const rng = createSeededRandom(42);
		shuffleArray(items, rng);

		expect(items).toEqual(original);
	});

	test("shuffling with same seed produces identical work queues", () => {
		const taskIds = ["task-a", "task-b", "task-c"];
		const conditions = ["baseline", "context7", "nia"] as const;
		const queue = generateWorkQueue(taskIds, [...conditions], 2);

		const rng1 = createSeededRandom(42);
		const rng2 = createSeededRandom(42);

		const shuffled1 = shuffleArray(queue, rng1);
		const shuffled2 = shuffleArray(queue, rng2);

		expect(shuffled1).toEqual(shuffled2);
	});

	test("shuffling with different seeds produces different work queues", () => {
		const taskIds = ["task-a", "task-b", "task-c"];
		const conditions = ["baseline", "context7", "nia"] as const;
		const queue = generateWorkQueue(taskIds, [...conditions], 2);

		const rng1 = createSeededRandom(42);
		const rng2 = createSeededRandom(99);

		const shuffled1 = shuffleArray(queue, rng1);
		const shuffled2 = shuffleArray(queue, rng2);

		// Map to strings for comparison
		const keys1 = shuffled1.map(
			(w) => `${w.taskId}|${w.condition}|${w.repIndex}`,
		);
		const keys2 = shuffled2.map(
			(w) => `${w.taskId}|${w.condition}|${w.repIndex}`,
		);

		expect(keys1).not.toEqual(keys2);
	});
});

// --- CLI Argument Parsing ---

describe("parseCliArgs", () => {
	test("parses all flags correctly", () => {
		const config = parseCliArgs([
			"bun",
			"src/index.ts",
			"--category",
			"bleeding_edge",
			"--library",
			"next",
			"--task",
			"my-task",
			"--condition",
			"nia",
			"--reps",
			"5",
			"--parallel",
			"3",
			"--skip-judge",
			"--keep-workdirs",
			"--output-dir",
			"my-results",
			"--timeout",
			"60000",
			"--seed",
			"42",
			"--dry-run",
		]);

		expect(config.category).toBe("bleeding_edge");
		expect(config.library).toBe("next");
		expect(config.task).toBe("my-task");
		expect(config.conditions).toEqual(["nia"]);
		expect(config.reps).toBe(5);
		expect(config.parallel).toBe(3);
		expect(config.skipJudge).toBe(true);
		expect(config.keepWorkdirs).toBe(true);
		expect(config.outputDir).toBe("my-results");
		expect(config.timeout).toBe(60000);
		expect(config.seed).toBe(42);
		expect(config.dryRun).toBe(true);
	});

	test("uses defaults when no flags provided", () => {
		const config = parseCliArgs(["bun", "src/index.ts"]);

		expect(config.category).toBeUndefined();
		expect(config.library).toBeUndefined();
		expect(config.task).toBeUndefined();
		expect(config.conditions).toBeUndefined();
		expect(config.reps).toBe(3);
		expect(config.parallel).toBe(1);
		expect(config.skipJudge).toBe(false);
		expect(config.keepWorkdirs).toBe(false);
		expect(config.outputDir).toBe("results");
		expect(config.timeout).toBe(900000);
		expect(config.dryRun).toBe(false);
		expect(config.evalOnly).toBe(false);
		expect(config.reportOnly).toBe(false);
	});

	test("parses --eval-only and --report-only", () => {
		const config1 = parseCliArgs(["bun", "src/index.ts", "--eval-only"]);
		expect(config1.evalOnly).toBe(true);

		const config2 = parseCliArgs(["bun", "src/index.ts", "--report-only"]);
		expect(config2.reportOnly).toBe(true);
	});

	test("parses --tasks-dir", () => {
		const config = parseCliArgs([
			"bun",
			"src/index.ts",
			"--tasks-dir",
			"/custom/tasks",
		]);
		expect(config.tasksDir).toBe("/custom/tasks");
	});
});

// --- Format Duration ---

describe("formatDuration", () => {
	test("formats milliseconds", () => {
		expect(formatDuration(500)).toBe("500ms");
	});

	test("formats seconds", () => {
		expect(formatDuration(5000)).toBe("5s");
		expect(formatDuration(45_000)).toBe("45s");
	});

	test("formats minutes and seconds", () => {
		expect(formatDuration(65_000)).toBe("1m05s");
		expect(formatDuration(323_000)).toBe("5m23s");
	});

	test("formats hours and minutes", () => {
		expect(formatDuration(3_600_000)).toBe("1h00m");
		expect(formatDuration(8_100_000)).toBe("2h15m");
	});
});

// --- AsyncSemaphore ---

describe("AsyncSemaphore", () => {
	test("allows up to maxConcurrency concurrent tasks", async () => {
		const sem = new AsyncSemaphore(2);
		let running = 0;
		let maxRunning = 0;

		const task = async () => {
			await sem.acquire();
			running++;
			maxRunning = Math.max(maxRunning, running);
			await new Promise((resolve) => setTimeout(resolve, 50));
			running--;
			sem.release();
		};

		await Promise.all([task(), task(), task(), task()]);

		expect(maxRunning).toBeLessThanOrEqual(2);
	});

	test("semaphore with concurrency 1 runs tasks sequentially", async () => {
		const sem = new AsyncSemaphore(1);
		const order: number[] = [];

		const task = async (id: number) => {
			await sem.acquire();
			order.push(id);
			await new Promise((resolve) => setTimeout(resolve, 10));
			sem.release();
		};

		await Promise.all([task(1), task(2), task(3)]);

		expect(order.length).toBe(3);
		// All tasks should complete
		expect(order.sort()).toEqual([1, 2, 3]);
	});
});

// --- ProgressLogger ---

describe("ProgressLogger", () => {
	test("tracks completed count", () => {
		const logger = new ProgressLogger(5);
		expect(logger.getCompleted()).toBe(0);

		// Capture console.log to avoid noise
		const originalLog = console.log;
		console.log = () => {};

		logger.log({ taskId: "test", condition: "baseline", repIndex: 0 }, 1000);
		expect(logger.getCompleted()).toBe(1);

		logger.log({ taskId: "test", condition: "nia", repIndex: 0 }, 2000);
		expect(logger.getCompleted()).toBe(2);

		console.log = originalLog;
	});
});

// --- Stratified Sampling ---

/**
 * Helper to create a minimal Task object for testing stratifiedSample.
 */
function makeTask(id: string, category: string): Task {
	return {
		id,
		category,
		library: "next",
		target_version: "16",
		prompt: "test prompt",
		reference_solution: "const x = 1;",
		test_spec: { ast_checks: [] },
		rubric: { criteria: [] },
		common_hallucinations: [],
	} as Task;
}

describe("stratifiedSample", () => {
	test("returns all tasks when limit >= total count", () => {
		const tasks = [
			makeTask("a", "bleeding_edge"),
			makeTask("b", "version_locked_write"),
		];
		const rng = createSeededRandom(42);
		const result = stratifiedSample(tasks, 5, rng);
		expect(result.length).toBe(2);
	});

	test("returns exact limit count when limit < total", () => {
		const tasks = [
			...Array.from({ length: 14 }, (_, i) =>
				makeTask(`be-${i}`, "bleeding_edge"),
			),
			...Array.from({ length: 14 }, (_, i) =>
				makeTask(`vw-${i}`, "version_locked_write"),
			),
			...Array.from({ length: 12 }, (_, i) =>
				makeTask(`va-${i}`, "version_locked_audit"),
			),
		];
		const rng = createSeededRandom(42);
		const result = stratifiedSample(tasks, 10, rng);
		expect(result.length).toBe(10);
	});

	test("distributes proportionally across categories (40 tasks, limit 10)", () => {
		const tasks = [
			...Array.from({ length: 14 }, (_, i) =>
				makeTask(`be-${i}`, "bleeding_edge"),
			),
			...Array.from({ length: 14 }, (_, i) =>
				makeTask(`vw-${i}`, "version_locked_write"),
			),
			...Array.from({ length: 12 }, (_, i) =>
				makeTask(`va-${i}`, "version_locked_audit"),
			),
		];

		const rng = createSeededRandom(42);
		const result = stratifiedSample(tasks, 10, rng);

		// Count per category
		const counts = new Map<string, number>();
		for (const t of result) {
			counts.set(t.category, (counts.get(t.category) ?? 0) + 1);
		}

		// 14/40*10=3.5, 14/40*10=3.5, 12/40*10=3.0
		// With largest-remainder: two categories get 4 (from 3.5), one gets 3 (from 3.0), but one 3.5 rounds down
		// The exact split depends on tie-breaking, but total must be 10
		// and each category should get at least 3
		expect(counts.get("bleeding_edge") ?? 0).toBeGreaterThanOrEqual(3);
		expect(counts.get("version_locked_write") ?? 0).toBeGreaterThanOrEqual(3);
		expect(counts.get("version_locked_audit") ?? 0).toBeGreaterThanOrEqual(3);

		const total = [...counts.values()].reduce((a, b) => a + b, 0);
		expect(total).toBe(10);
	});

	test("same seed produces same sample", () => {
		const tasks = [
			...Array.from({ length: 14 }, (_, i) =>
				makeTask(`be-${i}`, "bleeding_edge"),
			),
			...Array.from({ length: 14 }, (_, i) =>
				makeTask(`vw-${i}`, "version_locked_write"),
			),
			...Array.from({ length: 12 }, (_, i) =>
				makeTask(`va-${i}`, "version_locked_audit"),
			),
		];

		const rng1 = createSeededRandom(42);
		const rng2 = createSeededRandom(42);

		const result1 = stratifiedSample(tasks, 10, rng1);
		const result2 = stratifiedSample(tasks, 10, rng2);

		const ids1 = result1.map((t) => t.id);
		const ids2 = result2.map((t) => t.id);
		expect(ids1).toEqual(ids2);
	});

	test("different seeds produce different samples", () => {
		const tasks = [
			...Array.from({ length: 14 }, (_, i) =>
				makeTask(`be-${i}`, "bleeding_edge"),
			),
			...Array.from({ length: 14 }, (_, i) =>
				makeTask(`vw-${i}`, "version_locked_write"),
			),
			...Array.from({ length: 12 }, (_, i) =>
				makeTask(`va-${i}`, "version_locked_audit"),
			),
		];

		const rng1 = createSeededRandom(42);
		const rng2 = createSeededRandom(99);

		const result1 = stratifiedSample(tasks, 10, rng1);
		const result2 = stratifiedSample(tasks, 10, rng2);

		const ids1 = result1.map((t) => t.id).sort();
		const ids2 = result2.map((t) => t.id).sort();
		expect(ids1).not.toEqual(ids2);
	});

	test("handles single category correctly", () => {
		const tasks = Array.from({ length: 10 }, (_, i) =>
			makeTask(`be-${i}`, "bleeding_edge"),
		);
		const rng = createSeededRandom(42);
		const result = stratifiedSample(tasks, 5, rng);

		expect(result.length).toBe(5);
		for (const t of result) {
			expect(t.category).toBe("bleeding_edge");
		}
	});

	test("handles limit of 1 — selects exactly one task", () => {
		const tasks = [
			...Array.from({ length: 5 }, (_, i) =>
				makeTask(`be-${i}`, "bleeding_edge"),
			),
			...Array.from({ length: 5 }, (_, i) =>
				makeTask(`vw-${i}`, "version_locked_write"),
			),
		];
		const rng = createSeededRandom(42);
		const result = stratifiedSample(tasks, 1, rng);

		expect(result.length).toBe(1);
	});

	test("no duplicate tasks in result", () => {
		const tasks = [
			...Array.from({ length: 14 }, (_, i) =>
				makeTask(`be-${i}`, "bleeding_edge"),
			),
			...Array.from({ length: 14 }, (_, i) =>
				makeTask(`vw-${i}`, "version_locked_write"),
			),
			...Array.from({ length: 12 }, (_, i) =>
				makeTask(`va-${i}`, "version_locked_audit"),
			),
		];
		const rng = createSeededRandom(42);
		const result = stratifiedSample(tasks, 10, rng);

		const ids = result.map((t) => t.id);
		const uniqueIds = new Set(ids);
		expect(uniqueIds.size).toBe(ids.length);
	});
});

// --- CLI --limit Parsing ---

describe("parseCliArgs --limit", () => {
	test("parses --limit flag", () => {
		const config = parseCliArgs(["bun", "src/index.ts", "--limit", "10"]);
		expect(config.limit).toBe(10);
	});

	test("limit is undefined when not provided", () => {
		const config = parseCliArgs(["bun", "src/index.ts"]);
		expect(config.limit).toBeUndefined();
	});

	test("--limit combines with other filters", () => {
		const config = parseCliArgs([
			"bun",
			"src/index.ts",
			"--library",
			"next",
			"--limit",
			"5",
			"--condition",
			"baseline",
		]);
		expect(config.limit).toBe(5);
		expect(config.library).toBe("next");
		expect(config.conditions).toEqual(["baseline"]);
	});
});

// --- Result Store ---

describe("result-store", () => {
	const tempDir = join("/tmp", `nia-bench-test-result-store-${Date.now()}`);

	beforeAll(async () => {
		await mkdir(tempDir, { recursive: true });
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("createRunDir creates a timestamped directory", async () => {
		const runDir = await createRunDir(tempDir);
		expect(runDir).toContain(tempDir);

		const entries = await readdir(tempDir);
		expect(entries.length).toBeGreaterThan(0);
	});

	test("storeResult writes result JSON with correct path structure", async () => {
		const runDir = await createRunDir(tempDir);

		const result: EvaluationResult = {
			taskId: "test-task",
			condition: "baseline",
			runIndex: 0,
			category: "bleeding_edge",
			library: "next",
			targetVersion: "16",
			testScore: 0.8,
			judgeScore: 0.6,
			finalScore: 0.72,
			astResults: [],
			judgeResult: null,
			hallucinations: { types: [], details: [] },
			extractedFiles: { "file.ts": "const x = 1;" },
			prompt: "",
			durationMs: 0,
			agentError: null,
			attempts: 1,
			toolCallCount: 0,
			toolCallSummary: {},
		};

		const filePath = await storeResult(runDir, result);
		expect(filePath).toContain("test-task/baseline/run-0.json");

		const content = await readFile(filePath, "utf-8");
		const parsed = JSON.parse(content) as EvaluationResult;
		expect(parsed.taskId).toBe("test-task");
		expect(parsed.testScore).toBe(0.8);
		expect(parsed.finalScore).toBe(0.72);
	});

	test("storeResult handles multiple runs for same task/condition", async () => {
		const runDir = await createRunDir(tempDir);

		const result0: EvaluationResult = {
			taskId: "multi-task",
			condition: "nia",
			runIndex: 0,
			category: "bleeding_edge",
			library: "next",
			targetVersion: "16",
			testScore: 1.0,
			judgeScore: 0.9,
			finalScore: 0.96,
			astResults: [],
			judgeResult: null,
			hallucinations: { types: [], details: [] },
			extractedFiles: {},
			prompt: "",
			durationMs: 0,
			agentError: null,
			attempts: 1,
			toolCallCount: 0,
			toolCallSummary: {},
		};

		const result1: EvaluationResult = {
			...result0,
			runIndex: 1,
			testScore: 0.6,
			finalScore: 0.72,
		};

		await storeResult(runDir, result0);
		await storeResult(runDir, result1);

		const dir = join(runDir, "multi-task", "nia");
		const files = await readdir(dir);
		expect(files.sort()).toEqual(["run-0.json", "run-1.json"]);
	});

	test("writeRunMetadata writes and reads correctly", async () => {
		const runDir = await createRunDir(tempDir);

		const metadata: RunMetadata = {
			startTime: "2026-02-07T12:00:00.000Z",
			endTime: "",
			totalTasks: 5,
			conditions: ["baseline", "context7", "nia"],
			reps: 3,
			parallel: 2,
			maxRetries: 3,
			seed: 42,
			model: "anthropic/claude-sonnet-4-20250514",
			opencodeVersion: "1.1.53",
			cliArgs: ["--reps", "3", "--parallel", "2"],
			status: "running",
			completedItems: 0,
			totalItems: 45,
		};

		await writeRunMetadata(runDir, metadata);

		const content = await readFile(join(runDir, "run-meta.json"), "utf-8");
		const parsed = JSON.parse(content) as RunMetadata;
		expect(parsed.totalTasks).toBe(5);
		expect(parsed.seed).toBe(42);
		expect(parsed.model).toBe("anthropic/claude-sonnet-4-20250514");
		expect(parsed.opencodeVersion).toBe("1.1.53");
		expect(parsed.status).toBe("running");
	});

	test("writeRunMetadata can update metadata", async () => {
		const runDir = await createRunDir(tempDir);

		const metadata: RunMetadata = {
			startTime: "2026-02-07T12:00:00.000Z",
			endTime: "",
			totalTasks: 5,
			conditions: ["baseline"],
			reps: 1,
			parallel: 1,
			maxRetries: 3,
			seed: 42,
			model: "anthropic/claude-sonnet-4-20250514",
			opencodeVersion: "1.1.53",
			cliArgs: [],
			status: "running",
			completedItems: 0,
			totalItems: 5,
		};

		await writeRunMetadata(runDir, metadata);

		// Update
		metadata.status = "completed";
		metadata.endTime = "2026-02-07T12:30:00.000Z";
		metadata.completedItems = 5;
		await writeRunMetadata(runDir, metadata);

		const content = await readFile(join(runDir, "run-meta.json"), "utf-8");
		const parsed = JSON.parse(content) as RunMetadata;
		expect(parsed.status).toBe("completed");
		expect(parsed.completedItems).toBe(5);
	});
});
