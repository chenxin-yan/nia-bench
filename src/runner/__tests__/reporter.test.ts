import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvaluationResult } from "../evaluator";
import {
	buildTaskDetails,
	computeHallucinationDistribution,
	computeMetrics,
	computeToolUsageMetrics,
	extractTaskMetadata,
	formatReportText,
	generateReport,
	inferTaskMetadata,
	loadResults,
	writeReport,
} from "../reporter";

// --- Helpers ---

/**
 * Creates a mock EvaluationResult with configurable fields.
 */
function mockResult(
	overrides: Partial<EvaluationResult> = {},
): EvaluationResult {
	return {
		taskId: "nextjs-16-proxy-ts",
		condition: "baseline",
		runIndex: 0,
		category: "bleeding_edge",
		library: "next",
		targetVersion: "16",
		testScore: 1.0,
		judgeScore: 0.8,
		finalScore: 0.88,
		astResults: [
			{
				check: { type: "function_exported", name: "proxy" },
				passed: true,
				message: "Function proxy is exported",
			},
			{
				check: { type: "function_absent", name: "middleware" },
				passed: true,
				message: "Function middleware is not exported",
			},
		],
		judgeResult: null,
		hallucinations: { types: [], details: [] },
		extractedFiles: { "proxy.ts": "export function proxy() {}" },
		prompt: "",
		durationMs: 0,
		agentError: null,
		attempts: 1,
		toolCallCount: 0,
		toolCallSummary: {},
		...overrides,
	};
}

/**
 * Writes a mock result to the expected directory structure.
 */
async function writeResult(
	runDir: string,
	result: EvaluationResult,
): Promise<void> {
	const resultDir = join(runDir, result.taskId, result.condition);
	await mkdir(resultDir, { recursive: true });
	const filePath = join(resultDir, `run-${result.runIndex}.json`);
	await writeFile(filePath, JSON.stringify(result, null, 2), "utf-8");
}

let tempDir: string;

beforeEach(async () => {
	tempDir = join(
		tmpdir(),
		`reporter-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	await mkdir(tempDir, { recursive: true });
});

afterEach(async () => {
	try {
		await rm(tempDir, { recursive: true, force: true });
	} catch {
		// ignore cleanup errors
	}
});

// --- loadResults tests ---

describe("loadResults", () => {
	test("loads results from expected directory structure", async () => {
		const r1 = mockResult({
			taskId: "nextjs-16-proxy-ts",
			condition: "baseline",
			runIndex: 0,
		});
		const r2 = mockResult({
			taskId: "nextjs-16-proxy-ts",
			condition: "nia",
			runIndex: 0,
		});
		await writeResult(tempDir, r1);
		await writeResult(tempDir, r2);

		const results = await loadResults(tempDir);
		expect(results.length).toBe(2);
	});

	test("returns empty array for non-existent directory", async () => {
		const results = await loadResults("/tmp/non-existent-dir-12345");
		expect(results.length).toBe(0);
	});

	test("skips non-JSON files and metadata", async () => {
		const r1 = mockResult();
		await writeResult(tempDir, r1);

		// Write a non-JSON file and metadata file at root
		await writeFile(join(tempDir, "run-meta.json"), "{}", "utf-8");
		await writeFile(join(tempDir, "report.txt"), "text", "utf-8");

		const results = await loadResults(tempDir);
		expect(results.length).toBe(1);
	});

	test("skips malformed JSON files", async () => {
		const r1 = mockResult();
		await writeResult(tempDir, r1);

		// Write a malformed JSON file in the expected structure
		const badDir = join(tempDir, "bad-task", "baseline");
		await mkdir(badDir, { recursive: true });
		await writeFile(join(badDir, "run-0.json"), "{ invalid json", "utf-8");

		const results = await loadResults(tempDir);
		expect(results.length).toBe(1);
		expect(results[0]?.taskId).toBe("nextjs-16-proxy-ts");
	});

	test("loads multiple reps for same task+condition", async () => {
		await writeResult(tempDir, mockResult({ runIndex: 0 }));
		await writeResult(tempDir, mockResult({ runIndex: 1 }));
		await writeResult(tempDir, mockResult({ runIndex: 2 }));

		const results = await loadResults(tempDir);
		expect(results.length).toBe(3);
	});
});

// --- computeMetrics tests ---

describe("computeMetrics", () => {
	test("computes correct metrics for simple case", () => {
		const results = [
			mockResult({ taskId: "task-a", finalScore: 0.9, testScore: 1.0 }),
			mockResult({ taskId: "task-b", finalScore: 0.6, testScore: 0.5 }),
		];

		const metrics = computeMetrics(results);

		// task-a: 0.9 >= 0.8 -> pass, task-b: 0.6 < 0.8 -> fail
		expect(metrics.taskPassRate).toBe(0.5); // 1/2
		expect(metrics.hallucinationRate).toBe(0); // no hallucinations
		expect(metrics.versionComplianceRate).toBe(1.0); // all AST checks pass in mocks
		expect(metrics.meanCombinedScore).toBe(0.75); // (0.9 + 0.6) / 2
		expect(metrics.count).toBe(2);
	});

	test("returns zeros for empty results", () => {
		const metrics = computeMetrics([]);
		expect(metrics.taskPassRate).toBe(0);
		expect(metrics.hallucinationRate).toBe(0);
		expect(metrics.versionComplianceRate).toBe(0);
		expect(metrics.meanCombinedScore).toBe(0);
		expect(metrics.count).toBe(0);
	});

	test("averages across reps for same task", () => {
		// Same task, 3 reps
		const results = [
			mockResult({ taskId: "task-a", runIndex: 0, finalScore: 0.9 }),
			mockResult({ taskId: "task-a", runIndex: 1, finalScore: 0.8 }),
			mockResult({ taskId: "task-a", runIndex: 2, finalScore: 0.7 }),
		];

		const metrics = computeMetrics(results);

		// Average: (0.9+0.8+0.7)/3 = 0.8 -> pass (>= 0.8)
		expect(metrics.taskPassRate).toBe(1.0);
		expect(metrics.meanCombinedScore).toBeCloseTo(0.8, 5);
		expect(metrics.count).toBe(3);
	});

	test("detects hallucinations when strict majority of reps have them", () => {
		// 2 of 3 reps have hallucinations — strict majority (> 50%)
		const results = [
			mockResult({
				taskId: "task-a",
				runIndex: 0,
				hallucinations: { types: [], details: [] },
			}),
			mockResult({
				taskId: "task-a",
				runIndex: 1,
				hallucinations: {
					types: ["future_api"],
					details: [
						{ type: "future_api", evidence: "test", description: "test" },
					],
				},
			}),
			mockResult({
				taskId: "task-a",
				runIndex: 2,
				hallucinations: {
					types: ["future_api"],
					details: [
						{ type: "future_api", evidence: "test", description: "test" },
					],
				},
			}),
		];

		const metrics = computeMetrics(results);
		expect(metrics.hallucinationRate).toBe(1.0); // 2/3 reps = strict majority
	});

	test("does not count hallucinations when exactly half of reps have them", () => {
		// 1 of 2 reps has hallucination — not a strict majority (= 50%, not > 50%)
		const results = [
			mockResult({
				taskId: "task-a",
				runIndex: 0,
				hallucinations: { types: [], details: [] },
			}),
			mockResult({
				taskId: "task-a",
				runIndex: 1,
				hallucinations: {
					types: ["future_api"],
					details: [
						{ type: "future_api", evidence: "test", description: "test" },
					],
				},
			}),
		];

		const metrics = computeMetrics(results);
		expect(metrics.hallucinationRate).toBe(0); // 1/2 reps = not strict majority
	});

	test("version compliance requires all checks passing across all reps", () => {
		const results = [
			mockResult({
				taskId: "task-a",
				runIndex: 0,
				astResults: [
					{
						check: { type: "function_exported", name: "proxy" },
						passed: true,
						message: "ok",
					},
				],
			}),
			mockResult({
				taskId: "task-a",
				runIndex: 1,
				astResults: [
					{
						check: { type: "function_exported", name: "proxy" },
						passed: false,
						message: "missing",
					},
				],
			}),
		];

		const metrics = computeMetrics(results);
		expect(metrics.versionComplianceRate).toBe(0); // rep 1 has a failing check
	});

	test("all tasks passing produces 100% pass rate", () => {
		const results = [
			mockResult({ taskId: "task-a", finalScore: 0.95 }),
			mockResult({ taskId: "task-b", finalScore: 0.85 }),
			mockResult({ taskId: "task-c", finalScore: 0.8 }),
		];

		const metrics = computeMetrics(results);
		expect(metrics.taskPassRate).toBe(1.0);
	});

	test("score formula: 2 pass + 1 fail", () => {
		// 3 different tasks: 2 pass (>= 0.8), 1 fail (< 0.8)
		const results = [
			mockResult({ taskId: "task-a", finalScore: 0.9 }),
			mockResult({ taskId: "task-b", finalScore: 0.85 }),
			mockResult({ taskId: "task-c", finalScore: 0.5 }),
		];

		const metrics = computeMetrics(results);
		expect(metrics.taskPassRate).toBeCloseTo(2 / 3, 5);
		expect(metrics.meanCombinedScore).toBeCloseTo((0.9 + 0.85 + 0.5) / 3, 5);
	});
});

// --- computeHallucinationDistribution tests ---

describe("computeHallucinationDistribution", () => {
	test("counts hallucination types per unique task", () => {
		// 3 different tasks — each contributes independently to counts
		const results = [
			mockResult({
				taskId: "task-a",
				hallucinations: {
					types: ["future_api", "wrong_import_path"],
					details: [],
				},
			}),
			mockResult({
				taskId: "task-b",
				hallucinations: { types: ["future_api"], details: [] },
			}),
			mockResult({
				taskId: "task-c",
				hallucinations: { types: ["outdated_api"], details: [] },
			}),
		];

		const dist = computeHallucinationDistribution(results);

		const futureApi = dist.find((d) => d.type === "future_api");
		expect(futureApi?.count).toBe(2); // task-a + task-b

		const wrongImport = dist.find((d) => d.type === "wrong_import_path");
		expect(wrongImport?.count).toBe(1); // task-a only

		const outdated = dist.find((d) => d.type === "outdated_api");
		expect(outdated?.count).toBe(1); // task-c only

		const invented = dist.find((d) => d.type === "invented_method");
		expect(invented?.count).toBe(0);
	});

	test("deduplicates hallucination types across reps of same task", () => {
		// Same task, 2 reps — both report future_api, so it should count as 1 task
		const results = [
			mockResult({
				taskId: "task-a",
				runIndex: 0,
				hallucinations: { types: ["future_api"], details: [] },
			}),
			mockResult({
				taskId: "task-a",
				runIndex: 1,
				hallucinations: {
					types: ["future_api", "wrong_import_path"],
					details: [],
				},
			}),
		];

		const dist = computeHallucinationDistribution(results);

		const futureApi = dist.find((d) => d.type === "future_api");
		expect(futureApi?.count).toBe(1); // deduplicated: 1 task, not 2 reps

		const wrongImport = dist.find((d) => d.type === "wrong_import_path");
		expect(wrongImport?.count).toBe(1);
	});

	test("returns all types even when no hallucinations", () => {
		const dist = computeHallucinationDistribution([mockResult()]);
		expect(dist.length).toBe(6); // All 6 hallucination types
		expect(dist.every((d) => d.count === 0)).toBe(true);
		expect(dist.every((d) => d.percentage === 0)).toBe(true);
	});

	test("percentages sum to approximately 1.0", () => {
		const results = [
			mockResult({
				hallucinations: { types: ["future_api"], details: [] },
			}),
			mockResult({
				hallucinations: { types: ["outdated_api"], details: [] },
			}),
		];

		const dist = computeHallucinationDistribution(results);
		const totalPct = dist.reduce((sum, d) => sum + d.percentage, 0);
		expect(totalPct).toBeCloseTo(1.0, 5);
	});
});

// --- inferTaskMetadata tests ---

describe("inferTaskMetadata", () => {
	test("infers Next.js bleeding-edge metadata", () => {
		const meta = inferTaskMetadata("nextjs-16-proxy-ts");
		expect(meta.library).toBe("next");
		expect(meta.targetVersion).toBe("16");
		expect(meta.category).toBe("bleeding_edge");
	});

	test("infers React version-locked-write metadata", () => {
		const meta = inferTaskMetadata("react-17-render-entry");
		expect(meta.library).toBe("react");
		expect(meta.targetVersion).toBe("17");
		expect(meta.category).toBe("version_locked_write");
	});

	test("infers audit task metadata", () => {
		const meta = inferTaskMetadata("react-17-audit-v19-code");
		expect(meta.library).toBe("react");
		expect(meta.targetVersion).toBe("17");
		expect(meta.category).toBe("version_locked_audit");
	});

	test("infers AI SDK metadata", () => {
		const meta = inferTaskMetadata("ai-sdk-5-ui-message-stream");
		expect(meta.library).toBe("ai");
		expect(meta.targetVersion).toBe("5");
		expect(meta.category).toBe("bleeding_edge");
	});

	test("infers tRPC metadata", () => {
		const meta = inferTaskMetadata("trpc-10-client-transformer");
		expect(meta.library).toBe("trpc");
		expect(meta.targetVersion).toBe("10");
		expect(meta.category).toBe("version_locked_write");
	});

	test("infers Zod metadata", () => {
		const meta = inferTaskMetadata("zod-3-chained-validators");
		expect(meta.library).toBe("zod");
		expect(meta.targetVersion).toBe("3");
		expect(meta.category).toBe("version_locked_write");
	});

	test("returns unknown for unrecognized task IDs", () => {
		const meta = inferTaskMetadata("unknown-task-123");
		expect(meta.library).toBe("unknown");
		expect(meta.category).toBe("unknown");
	});
});

// --- extractTaskMetadata tests ---

describe("extractTaskMetadata", () => {
	test("uses stored metadata when present", () => {
		const result = mockResult({
			taskId: "nextjs-16-proxy-ts",
			category: "bleeding_edge",
			library: "next",
			targetVersion: "16",
		});
		const meta = extractTaskMetadata(result);
		expect(meta.category).toBe("bleeding_edge");
		expect(meta.library).toBe("next");
		expect(meta.targetVersion).toBe("16");
	});

	test("falls back to inference when metadata fields are empty", () => {
		const result = mockResult({
			taskId: "react-17-render-entry",
			category: "",
			library: "",
			targetVersion: "",
		});
		const meta = extractTaskMetadata(result);
		expect(meta.category).toBe("version_locked_write");
		expect(meta.library).toBe("react");
		expect(meta.targetVersion).toBe("17");
	});
});

// --- buildTaskDetails tests ---

describe("buildTaskDetails", () => {
	test("builds task details with multiple conditions", () => {
		const results = [
			mockResult({
				taskId: "nextjs-16-proxy-ts",
				condition: "baseline",
				finalScore: 0.8,
			}),
			mockResult({
				taskId: "nextjs-16-proxy-ts",
				condition: "nia",
				finalScore: 0.95,
			}),
			mockResult({
				taskId: "nextjs-16-proxy-ts",
				condition: "context7",
				finalScore: 0.9,
			}),
		];

		const details = buildTaskDetails(results);
		expect(details.length).toBe(1);

		const detail = details[0];
		expect(detail?.taskId).toBe("nextjs-16-proxy-ts");
		expect(detail?.category).toBe("bleeding_edge");
		expect(detail?.library).toBe("next");
		expect(detail?.conditions.baseline?.avgFinalScore).toBe(0.8);
		expect(detail?.conditions.nia?.avgFinalScore).toBe(0.95);
		expect(detail?.conditions.context7?.avgFinalScore).toBe(0.9);
	});

	test("averages scores across reps within a condition", () => {
		const results = [
			mockResult({
				taskId: "react-17-render-entry",
				condition: "baseline",
				runIndex: 0,
				finalScore: 0.8,
			}),
			mockResult({
				taskId: "react-17-render-entry",
				condition: "baseline",
				runIndex: 1,
				finalScore: 0.9,
			}),
			mockResult({
				taskId: "react-17-render-entry",
				condition: "baseline",
				runIndex: 2,
				finalScore: 1.0,
			}),
		];

		const details = buildTaskDetails(results);
		expect(details.length).toBe(1);
		expect(details[0]?.conditions.baseline?.avgFinalScore).toBeCloseTo(0.9, 5);
		expect(details[0]?.conditions.baseline?.repCount).toBe(3);
	});

	test("collects hallucination types across reps (deduplicated)", () => {
		const results = [
			mockResult({
				taskId: "task-a",
				condition: "baseline",
				runIndex: 0,
				hallucinations: { types: ["future_api"], details: [] },
			}),
			mockResult({
				taskId: "task-a",
				condition: "baseline",
				runIndex: 1,
				hallucinations: {
					types: ["future_api", "wrong_import_path"],
					details: [],
				},
			}),
		];

		const details = buildTaskDetails(results);
		const types = details[0]?.conditions.baseline?.hallucinationTypes ?? [];
		expect(types).toContain("future_api");
		expect(types).toContain("wrong_import_path");
		expect(types.length).toBe(2); // deduplicated
	});

	test("sorts details by taskId", () => {
		const results = [
			mockResult({ taskId: "zod-3-chained-validators", condition: "baseline" }),
			mockResult({
				taskId: "ai-sdk-5-ui-message-stream",
				condition: "baseline",
			}),
			mockResult({ taskId: "nextjs-16-proxy-ts", condition: "baseline" }),
		];

		const details = buildTaskDetails(results);
		expect(details[0]?.taskId).toBe("ai-sdk-5-ui-message-stream");
		expect(details[1]?.taskId).toBe("nextjs-16-proxy-ts");
		expect(details[2]?.taskId).toBe("zod-3-chained-validators");
	});
});

// --- generateReport integration tests ---

describe("generateReport", () => {
	test("basic report with 2 tasks x 3 conditions x 1 rep", async () => {
		// Task 1: nextjs-16-proxy-ts (bleeding_edge, next)
		// Task 2: react-17-render-entry (version_locked_write, react)
		const allResults: EvaluationResult[] = [
			// Baseline
			mockResult({
				taskId: "nextjs-16-proxy-ts",
				condition: "baseline",
				finalScore: 0.9,
				testScore: 1.0,
				judgeScore: 0.75,
			}),
			mockResult({
				taskId: "react-17-render-entry",
				condition: "baseline",
				finalScore: 0.6,
				testScore: 0.5,
				judgeScore: 0.75,
				hallucinations: {
					types: ["future_api"],
					details: [
						{ type: "future_api", evidence: "test", description: "test" },
					],
				},
			}),
			// Context7
			mockResult({
				taskId: "nextjs-16-proxy-ts",
				condition: "context7",
				finalScore: 0.95,
				testScore: 1.0,
				judgeScore: 0.88,
			}),
			mockResult({
				taskId: "react-17-render-entry",
				condition: "context7",
				finalScore: 0.85,
				testScore: 0.9,
				judgeScore: 0.78,
			}),
			// Nia
			mockResult({
				taskId: "nextjs-16-proxy-ts",
				condition: "nia",
				finalScore: 1.0,
				testScore: 1.0,
				judgeScore: 1.0,
			}),
			mockResult({
				taskId: "react-17-render-entry",
				condition: "nia",
				finalScore: 0.9,
				testScore: 1.0,
				judgeScore: 0.75,
			}),
		];

		for (const r of allResults) {
			await writeResult(tempDir, r);
		}

		const report = await generateReport(tempDir);

		expect(report.totalTasks).toBe(2);
		expect(report.totalResults).toBe(6);
		expect(report.conditions).toEqual(["baseline", "context7", "nia"]);

		// Overall baseline: task-a 0.9 >= 0.8 (pass), task-b 0.6 < 0.8 (fail)
		const baselineOverall = report.overall.find(
			(o) => o.condition === "baseline",
		);
		expect(baselineOverall?.metrics.taskPassRate).toBe(0.5); // 1/2
		expect(baselineOverall?.metrics.meanCombinedScore).toBeCloseTo(0.75, 5);

		// Overall nia: both tasks >= 0.8
		const niaOverall = report.overall.find((o) => o.condition === "nia");
		expect(niaOverall?.metrics.taskPassRate).toBe(1.0);
		expect(niaOverall?.metrics.meanCombinedScore).toBeCloseTo(0.95, 5);
	});

	test("per-category breakdown separates categories correctly", async () => {
		const results: EvaluationResult[] = [
			// bleeding_edge task
			mockResult({
				taskId: "nextjs-16-proxy-ts",
				category: "bleeding_edge",
				library: "next",
				targetVersion: "16",
				condition: "baseline",
				finalScore: 0.9,
			}),
			// version_locked_write task
			mockResult({
				taskId: "react-17-render-entry",
				category: "version_locked_write",
				library: "react",
				targetVersion: "17",
				condition: "baseline",
				finalScore: 0.7,
			}),
		];

		for (const r of results) {
			await writeResult(tempDir, r);
		}

		const report = await generateReport(tempDir);

		expect(report.byCategory.bleeding_edge).toBeDefined();
		expect(report.byCategory.version_locked_write).toBeDefined();

		const bleedingBaseline = report.byCategory.bleeding_edge?.find(
			(c) => c.condition === "baseline",
		);
		expect(bleedingBaseline?.metrics.meanCombinedScore).toBe(0.9);

		const lockedBaseline = report.byCategory.version_locked_write?.find(
			(c) => c.condition === "baseline",
		);
		expect(lockedBaseline?.metrics.meanCombinedScore).toBe(0.7);
	});

	test("handles partial results with only 1 condition", async () => {
		const results: EvaluationResult[] = [
			mockResult({
				taskId: "nextjs-16-proxy-ts",
				condition: "nia",
				finalScore: 0.95,
			}),
			mockResult({
				taskId: "react-17-render-entry",
				condition: "nia",
				finalScore: 0.85,
			}),
		];

		for (const r of results) {
			await writeResult(tempDir, r);
		}

		const report = await generateReport(tempDir);

		expect(report.conditions).toEqual(["nia"]);
		expect(report.overall.length).toBe(1);
		expect(report.overall[0]?.condition).toBe("nia");
		expect(report.overall[0]?.metrics.taskPassRate).toBe(1.0); // both >= 0.8
	});

	test("handles empty results directory gracefully", async () => {
		const report = await generateReport(tempDir);

		expect(report.totalTasks).toBe(0);
		expect(report.totalResults).toBe(0);
		expect(report.conditions).toEqual([]);
		expect(report.overall).toEqual([]);
		expect(report.taskDetails).toEqual([]);
	});

	test("per-library breakdown groups correctly", async () => {
		const results: EvaluationResult[] = [
			mockResult({
				taskId: "nextjs-16-proxy-ts",
				category: "bleeding_edge",
				library: "next",
				targetVersion: "16",
				condition: "baseline",
				finalScore: 0.8,
			}),
			mockResult({
				taskId: "react-17-render-entry",
				category: "version_locked_write",
				library: "react",
				targetVersion: "17",
				condition: "baseline",
				finalScore: 0.9,
			}),
			mockResult({
				taskId: "zod-3-chained-validators",
				category: "version_locked_write",
				library: "zod",
				targetVersion: "3",
				condition: "baseline",
				finalScore: 0.7,
			}),
		];

		for (const r of results) {
			await writeResult(tempDir, r);
		}

		const report = await generateReport(tempDir);

		expect(report.byLibrary.next).toBeDefined();
		expect(report.byLibrary.react).toBeDefined();
		expect(report.byLibrary.zod).toBeDefined();

		const nextBaseline = report.byLibrary.next?.find(
			(c) => c.condition === "baseline",
		);
		expect(nextBaseline?.metrics.meanCombinedScore).toBe(0.8);

		const reactBaseline = report.byLibrary.react?.find(
			(c) => c.condition === "baseline",
		);
		expect(reactBaseline?.metrics.meanCombinedScore).toBe(0.9);
	});
});

// --- Report output tests ---

describe("writeReport", () => {
	test("writes both JSON and text report files", async () => {
		const results: EvaluationResult[] = [
			mockResult({
				taskId: "nextjs-16-proxy-ts",
				condition: "baseline",
				finalScore: 0.9,
			}),
			mockResult({
				taskId: "nextjs-16-proxy-ts",
				condition: "nia",
				finalScore: 0.95,
			}),
		];

		for (const r of results) {
			await writeResult(tempDir, r);
		}

		const report = await generateReport(tempDir);
		await writeReport(tempDir, report);

		// Verify JSON report
		const jsonContent = await readFile(join(tempDir, "report.json"), "utf-8");
		const parsedReport = JSON.parse(jsonContent);
		expect(parsedReport.totalTasks).toBe(1);
		expect(parsedReport.totalResults).toBe(2);
		expect(parsedReport.conditions).toEqual(["baseline", "nia"]);

		// Verify text report
		const textContent = await readFile(join(tempDir, "report.txt"), "utf-8");
		expect(textContent).toContain("NIA-BENCH RESULTS v1.0");
		expect(textContent).toContain("Task Pass Rate");
		expect(textContent).toContain("Mean Combined Score");
	});

	test("JSON report is valid and parseable", async () => {
		const results: EvaluationResult[] = [
			mockResult({ taskId: "nextjs-16-proxy-ts", condition: "baseline" }),
		];
		for (const r of results) {
			await writeResult(tempDir, r);
		}

		const report = await generateReport(tempDir);
		await writeReport(tempDir, report);

		const jsonContent = await readFile(join(tempDir, "report.json"), "utf-8");
		const parsed = JSON.parse(jsonContent);

		// Verify structure
		expect(parsed).toHaveProperty("generatedAt");
		expect(parsed).toHaveProperty("resultsDir");
		expect(parsed).toHaveProperty("totalTasks");
		expect(parsed).toHaveProperty("totalResults");
		expect(parsed).toHaveProperty("conditions");
		expect(parsed).toHaveProperty("overall");
		expect(parsed).toHaveProperty("byCategory");
		expect(parsed).toHaveProperty("byLibrary");
		expect(parsed).toHaveProperty("hallucinationDistribution");
		expect(parsed).toHaveProperty("taskDetails");
	});
});

// --- formatReportText tests ---

describe("formatReportText", () => {
	test("text report matches expected ASCII table format", async () => {
		const results: EvaluationResult[] = [
			mockResult({
				taskId: "nextjs-16-proxy-ts",
				condition: "baseline",
				finalScore: 0.9,
				testScore: 1.0,
				judgeScore: 0.75,
			}),
			mockResult({
				taskId: "nextjs-16-proxy-ts",
				condition: "context7",
				finalScore: 0.95,
				testScore: 1.0,
				judgeScore: 0.88,
			}),
			mockResult({
				taskId: "nextjs-16-proxy-ts",
				condition: "nia",
				finalScore: 1.0,
				testScore: 1.0,
				judgeScore: 1.0,
			}),
		];

		for (const r of results) {
			await writeResult(tempDir, r);
		}

		const report = await generateReport(tempDir);
		const text = formatReportText(report);

		// Check header
		expect(text).toContain("NIA-BENCH RESULTS v1.0");

		// Check column headers
		expect(text).toContain("Baseline");
		expect(text).toContain("Context7");
		expect(text).toContain("Nia");

		// Check metric labels
		expect(text).toContain("Task Pass Rate");
		expect(text).toContain("Hallucination Rate");
		expect(text).toContain("Version Compliance Rate");
		expect(text).toContain("Mean Combined Score");

		// Check category sections
		expect(text).toContain("CATEGORY A: BLEEDING EDGE");

		// Check library section
		expect(text).toContain("PER LIBRARY");
		expect(text).toContain("Next.js");

		// Check per-task breakdown
		expect(text).toContain("PER-TASK BREAKDOWN");
		expect(text).toContain("nextjs-16-proxy-ts");
	});

	test("handles single condition without crashing", () => {
		const report = {
			generatedAt: new Date().toISOString(),
			resultsDir: "/tmp/test",
			totalTasks: 1,
			expectedTotalTasks: null,
			totalResults: 1,
			conditions: ["nia"],
			overall: [
				{
					condition: "nia",
					metrics: {
						taskPassRate: 1.0,
						hallucinationRate: 0,
						versionComplianceRate: 1.0,
						meanCombinedScore: 0.95,
						count: 1,
					},
				},
			],
			byCategory: {},
			byLibrary: {},
			hallucinationDistribution: {},
			toolUsage: {},
			taskDetails: [],
		};

		const text = formatReportText(report);
		expect(text).toContain("Nia");
		expect(text).toContain("100.0%");
		expect(text).toContain("0.95");
	});

	test("shows N/A for conditions with no data in a category", () => {
		const report = {
			generatedAt: new Date().toISOString(),
			resultsDir: "/tmp/test",
			totalTasks: 1,
			expectedTotalTasks: null,
			totalResults: 1,
			conditions: ["baseline", "nia"],
			overall: [
				{
					condition: "baseline",
					metrics: {
						taskPassRate: 0.5,
						hallucinationRate: 0.5,
						versionComplianceRate: 0.5,
						meanCombinedScore: 0.5,
						count: 1,
					},
				},
				{
					condition: "nia",
					metrics: {
						taskPassRate: 0,
						hallucinationRate: 0,
						versionComplianceRate: 0,
						meanCombinedScore: 0,
						count: 0,
					},
				},
			],
			byCategory: {},
			byLibrary: {},
			hallucinationDistribution: {},
			toolUsage: {},
			taskDetails: [],
		};

		const text = formatReportText(report);
		expect(text).toContain("N/A");
	});

	test("empty report produces valid output", () => {
		const report = {
			generatedAt: new Date().toISOString(),
			resultsDir: "/tmp/test",
			totalTasks: 0,
			expectedTotalTasks: null,
			totalResults: 0,
			conditions: [],
			overall: [],
			byCategory: {},
			byLibrary: {},
			hallucinationDistribution: {},
			toolUsage: {},
			taskDetails: [],
		};

		const text = formatReportText(report);
		expect(text).toContain("NIA-BENCH RESULTS v1.0");
	});

	test("renders tool usage section when toolUsage data is present", () => {
		const report = {
			generatedAt: new Date().toISOString(),
			resultsDir: "/tmp/test",
			totalTasks: 1,
			expectedTotalTasks: null,
			totalResults: 3,
			conditions: ["baseline", "context7", "nia"],
			overall: [
				{
					condition: "baseline",
					metrics: {
						taskPassRate: 0.5,
						hallucinationRate: 0,
						versionComplianceRate: 0.5,
						meanCombinedScore: 0.5,
						count: 1,
					},
				},
				{
					condition: "context7",
					metrics: {
						taskPassRate: 0.8,
						hallucinationRate: 0,
						versionComplianceRate: 0.8,
						meanCombinedScore: 0.8,
						count: 1,
					},
				},
				{
					condition: "nia",
					metrics: {
						taskPassRate: 0.9,
						hallucinationRate: 0,
						versionComplianceRate: 0.9,
						meanCombinedScore: 0.9,
						count: 1,
					},
				},
			],
			byCategory: {},
			byLibrary: {},
			hallucinationDistribution: {},
			toolUsage: {
				baseline: {
					toolUsageRate: 0,
					avgToolCallsPerRun: 0,
					totalToolCalls: 0,
					toolBreakdown: {},
					count: 1,
				},
				context7: {
					toolUsageRate: 1.0,
					avgToolCallsPerRun: 3.0,
					totalToolCalls: 3,
					toolBreakdown: { context7: 3 },
					count: 1,
				},
				nia: {
					toolUsageRate: 1.0,
					avgToolCallsPerRun: 5.0,
					totalToolCalls: 5,
					toolBreakdown: { nia: 4, bash: 1 },
					count: 1,
				},
			},
			taskDetails: [],
		};

		const text = formatReportText(report);
		expect(text).toContain("TOOL USAGE");
		expect(text).toContain("Tool Usage Rate");
		expect(text).toContain("Avg Calls/Run");
		expect(text).toContain("Total Tool Calls");
		expect(text).toContain("Tool Breakdown");
	});
});

describe("computeToolUsageMetrics", () => {
	test("returns zeros for empty results", () => {
		const metrics = computeToolUsageMetrics([]);
		expect(metrics.toolUsageRate).toBe(0);
		expect(metrics.avgToolCallsPerRun).toBe(0);
		expect(metrics.totalToolCalls).toBe(0);
		expect(metrics.count).toBe(0);
		expect(Object.keys(metrics.toolBreakdown)).toHaveLength(0);
	});

	test("computes correct metrics when all runs use tools", () => {
		const results = [
			mockResult({
				toolCallCount: 2,
				toolCallSummary: { context7: 2 },
			}),
			mockResult({
				runIndex: 1,
				toolCallCount: 1,
				toolCallSummary: { context7: 1 },
			}),
		];

		const metrics = computeToolUsageMetrics(results);
		expect(metrics.toolUsageRate).toBe(1.0);
		expect(metrics.avgToolCallsPerRun).toBe(1.5); // 3 calls / 2 runs
		expect(metrics.totalToolCalls).toBe(3);
		expect(metrics.toolBreakdown).toEqual({ context7: 3 });
		expect(metrics.count).toBe(2);
	});

	test("computes correct metrics when some runs have no tool calls", () => {
		const results = [
			mockResult({ toolCallCount: 0, toolCallSummary: {} }),
			mockResult({
				runIndex: 1,
				toolCallCount: 1,
				toolCallSummary: { nia: 1 },
			}),
			mockResult({ runIndex: 2, toolCallCount: 0, toolCallSummary: {} }),
		];

		const metrics = computeToolUsageMetrics(results);
		expect(metrics.toolUsageRate).toBeCloseTo(1 / 3);
		expect(metrics.avgToolCallsPerRun).toBeCloseTo(1 / 3);
		expect(metrics.totalToolCalls).toBe(1);
		expect(metrics.count).toBe(3);
	});

	test("computes tool breakdown with multiple tool types", () => {
		const results = [
			mockResult({
				toolCallCount: 3,
				toolCallSummary: { nia: 2, bash: 1 },
			}),
			mockResult({
				runIndex: 1,
				toolCallCount: 2,
				toolCallSummary: { write: 1, nia: 1 },
			}),
		];

		const metrics = computeToolUsageMetrics(results);
		expect(metrics.totalToolCalls).toBe(5);
		expect(metrics.toolBreakdown).toEqual({
			nia: 3,
			bash: 1,
			write: 1,
		});
	});

	test("handles results with missing toolCalls (backward compatibility)", () => {
		// Simulate older result files that don't have toolCalls
		const result = mockResult();
		delete (result as unknown as Record<string, unknown>).toolCalls;

		const metrics = computeToolUsageMetrics([result]);
		expect(metrics.toolUsageRate).toBe(0);
		expect(metrics.totalToolCalls).toBe(0);
		expect(metrics.count).toBe(1);
	});
});
