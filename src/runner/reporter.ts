import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HallucinationType } from "@/judge";
import type { EvaluationResult } from "./evaluator";

// --- Types ---

/**
 * Metrics computed for a group of results (overall, per-category, per-library, etc.)
 */
export interface MetricsGroup {
	/** % of tasks with final_score >= 0.8 */
	taskPassRate: number;
	/** % of tasks with >= 1 hallucination */
	hallucinationRate: number;
	/** % of tasks where ALL AST checks pass (version-correct APIs) */
	versionComplianceRate: number;
	/** Average final_score across all tasks */
	meanCombinedScore: number;
	/** Total number of result entries in this group */
	count: number;
}

/**
 * Per-condition metrics with optional condition name.
 */
export interface ConditionMetrics {
	condition: string;
	metrics: MetricsGroup;
}

/**
 * Hallucination type count and percentage.
 */
export interface HallucinationDistribution {
	type: HallucinationType;
	count: number;
	percentage: number;
}

/**
 * Per-task detail for the comparison view.
 */
export interface TaskDetail {
	taskId: string;
	category: string;
	library: string;
	targetVersion: string;
	/** Condition -> average scores across reps */
	conditions: Record<
		string,
		{
			avgFinalScore: number;
			avgTestScore: number;
			avgJudgeScore: number;
			hallucinationTypes: HallucinationType[];
			repCount: number;
		}
	>;
}

/**
 * Full report structure.
 */
export interface Report {
	/** ISO timestamp when the report was generated */
	generatedAt: string;
	/** Source results directory */
	resultsDir: string;
	/** Total unique tasks in the results */
	totalTasks: number;
	/** Total result files processed */
	totalResults: number;
	/** Conditions found in the results */
	conditions: string[];
	/** Overall metrics per condition */
	overall: ConditionMetrics[];
	/** Metrics per category per condition */
	byCategory: Record<string, ConditionMetrics[]>;
	/** Metrics per library per condition */
	byLibrary: Record<string, ConditionMetrics[]>;
	/** Hallucination type distribution per condition */
	hallucinationDistribution: Record<string, HallucinationDistribution[]>;
	/** Per-task detail view */
	taskDetails: TaskDetail[];
}

// --- Result Loading ---

/**
 * Loads all EvaluationResult JSON files from a results run directory.
 *
 * Expected structure: {runDir}/{taskId}/{condition}/run-{index}.json
 */
export async function loadResults(runDir: string): Promise<EvaluationResult[]> {
	const results: EvaluationResult[] = [];

	let taskDirs: string[];
	try {
		taskDirs = await readdir(runDir);
	} catch {
		return results;
	}

	for (const taskDir of taskDirs) {
		// Skip non-directory entries and metadata files
		if (
			taskDir === "run-meta.json" ||
			taskDir === "report.json" ||
			taskDir === "report.txt"
		) {
			continue;
		}

		const taskPath = join(runDir, taskDir);
		let conditionDirs: string[];
		try {
			conditionDirs = await readdir(taskPath);
		} catch {
			continue; // Skip if not a directory
		}

		for (const conditionDir of conditionDirs) {
			const conditionPath = join(taskPath, conditionDir);
			let runFiles: string[];
			try {
				runFiles = await readdir(conditionPath);
			} catch {
				continue; // Skip if not a directory
			}

			for (const runFile of runFiles) {
				if (!runFile.endsWith(".json")) continue;

				try {
					const filePath = join(conditionPath, runFile);
					const content = await readFile(filePath, "utf-8");
					const result = JSON.parse(content) as EvaluationResult;
					results.push(result);
				} catch {
					// Skip malformed result files
				}
			}
		}
	}

	return results;
}

// --- Metrics Computation ---

/**
 * Computes aggregate metrics for a group of evaluation results.
 */
export function computeMetrics(results: EvaluationResult[]): MetricsGroup {
	if (results.length === 0) {
		return {
			taskPassRate: 0,
			hallucinationRate: 0,
			versionComplianceRate: 0,
			meanCombinedScore: 0,
			count: 0,
		};
	}

	// Group results by taskId to compute task-level metrics (averaging across reps)
	const taskGroups = groupByTask(results);
	const taskCount = taskGroups.size;

	let passedTasks = 0;
	let hallucinatedTasks = 0;
	let compliantTasks = 0;
	let totalScore = 0;

	for (const taskResults of taskGroups.values()) {
		// Average final score across reps for this task
		const avgFinalScore =
			taskResults.reduce((sum, r) => sum + r.finalScore, 0) /
			taskResults.length;
		totalScore += avgFinalScore;

		// Task passes if average final_score >= 0.8
		if (avgFinalScore >= 0.8) {
			passedTasks++;
		}

		// Task has hallucinations if ANY rep has >= 1 hallucination
		const hasHallucination = taskResults.some(
			(r) => r.hallucinations.types.length > 0,
		);
		if (hasHallucination) {
			hallucinatedTasks++;
		}

		// Task is version-compliant if ALL reps have ALL AST checks passing
		const isCompliant = taskResults.every((r) =>
			r.astResults.every((check) => check.passed),
		);
		if (isCompliant) {
			compliantTasks++;
		}
	}

	return {
		taskPassRate: taskCount > 0 ? passedTasks / taskCount : 0,
		hallucinationRate: taskCount > 0 ? hallucinatedTasks / taskCount : 0,
		versionComplianceRate: taskCount > 0 ? compliantTasks / taskCount : 0,
		meanCombinedScore: taskCount > 0 ? totalScore / taskCount : 0,
		count: results.length,
	};
}

/**
 * Groups results by taskId.
 */
function groupByTask(
	results: EvaluationResult[],
): Map<string, EvaluationResult[]> {
	const groups = new Map<string, EvaluationResult[]>();
	for (const result of results) {
		const existing = groups.get(result.taskId) ?? [];
		existing.push(result);
		groups.set(result.taskId, existing);
	}
	return groups;
}

/**
 * Groups results by a given key extractor.
 */
function groupBy(
	results: EvaluationResult[],
	keyFn: (r: EvaluationResult) => string,
): Map<string, EvaluationResult[]> {
	const groups = new Map<string, EvaluationResult[]>();
	for (const result of results) {
		const key = keyFn(result);
		const existing = groups.get(key) ?? [];
		existing.push(result);
		groups.set(key, existing);
	}
	return groups;
}

/**
 * Computes hallucination type distribution for a set of results.
 */
export function computeHallucinationDistribution(
	results: EvaluationResult[],
): HallucinationDistribution[] {
	const typeCounts = new Map<HallucinationType, number>();
	const allTypes: HallucinationType[] = [
		"invented_method",
		"wrong_parameter",
		"outdated_api",
		"future_api",
		"wrong_import_path",
		"version_mismatch",
	];

	// Initialize all types with 0
	for (const type of allTypes) {
		typeCounts.set(type, 0);
	}

	// Count occurrences across all results
	let totalHallucinations = 0;
	for (const result of results) {
		for (const type of result.hallucinations.types) {
			const current = typeCounts.get(type) ?? 0;
			typeCounts.set(type, current + 1);
			totalHallucinations++;
		}
	}

	return allTypes.map((type) => ({
		type,
		count: typeCounts.get(type) ?? 0,
		percentage:
			totalHallucinations > 0
				? (typeCounts.get(type) ?? 0) / totalHallucinations
				: 0,
	}));
}

// --- Task Detail Extraction ---

/**
 * Extracts the task category and library from result data.
 * Since EvaluationResult doesn't store category/library directly,
 * we infer from the taskId pattern or from additional task data.
 */
interface TaskMetadata {
	category: string;
	library: string;
	targetVersion: string;
}

/**
 * Infers task metadata from the taskId.
 *
 * Task ID patterns:
 * - nextjs-16-proxy-ts, nextjs-13-sync-request-apis, nextjs-16-audit-v15-code
 * - react-19-use-hook, react-17-render-entry, react-17-audit-v19-code
 * - ai-sdk-5-ui-message-stream, ai-sdk-3-async-stream, ai-sdk-4-audit-v3-code
 * - trpc-11-transformer-link, trpc-10-client-transformer, trpc-11-audit-v10-code
 * - zod-4-top-level-validators, zod-3-chained-validators, zod-4-audit-v3-code
 */
export function inferTaskMetadata(
	taskId: string,
	resultsDir?: string,
): TaskMetadata {
	// Default values
	let category = "unknown";
	let library = "unknown";
	let targetVersion = "unknown";

	// Infer library from taskId prefix
	if (taskId.startsWith("nextjs-")) {
		library = "next";
		const versionMatch = taskId.match(/^nextjs-(\d+)/);
		if (versionMatch?.[1]) targetVersion = versionMatch[1];
	} else if (taskId.startsWith("react-")) {
		library = "react";
		const versionMatch = taskId.match(/^react-(\d+)/);
		if (versionMatch?.[1]) targetVersion = versionMatch[1];
	} else if (taskId.startsWith("ai-sdk-")) {
		library = "ai";
		const versionMatch = taskId.match(/^ai-sdk-(\d+)/);
		if (versionMatch?.[1]) targetVersion = versionMatch[1];
	} else if (taskId.startsWith("trpc-")) {
		library = "trpc";
		const versionMatch = taskId.match(/^trpc-(\d+)/);
		if (versionMatch?.[1]) targetVersion = versionMatch[1];
	} else if (taskId.startsWith("zod-")) {
		library = "zod";
		const versionMatch = taskId.match(/^zod-(\d+)/);
		if (versionMatch?.[1]) targetVersion = versionMatch[1];
	}

	// Infer category from taskId patterns
	if (taskId.includes("audit")) {
		category = "version_locked_audit";
	} else {
		// Determine by checking the results directory structure
		// If we can't determine from the taskId alone, try to infer from known patterns
		category = inferCategoryFromTaskId(taskId);
	}

	void resultsDir; // Reserved for future use (loading task JSON files)

	return { category, library, targetVersion };
}

/**
 * Infers category from known task ID patterns.
 * Bleeding-edge tasks target the latest version; version-locked tasks target older versions.
 */
function inferCategoryFromTaskId(taskId: string): string {
	// Audit tasks are clear from the name
	if (taskId.includes("audit")) return "version_locked_audit";

	// Known bleeding-edge task patterns (latest version per library)
	const bleedingEdgePatterns = [
		"nextjs-16-",
		"react-19-",
		"ai-sdk-5-",
		"ai-sdk-4-sync-stream-text", // AI SDK v4 bleeding edge
		"trpc-11-",
		"zod-4-",
	];

	for (const pattern of bleedingEdgePatterns) {
		if (taskId.startsWith(pattern)) return "bleeding_edge";
	}

	// Known version-locked-write task patterns (older versions)
	const versionLockedPatterns = [
		"nextjs-13-",
		"nextjs-14-",
		"nextjs-15-",
		"react-17-",
		"react-18-",
		"ai-sdk-3-",
		"trpc-10-",
		"zod-3-",
	];

	for (const pattern of versionLockedPatterns) {
		if (taskId.startsWith(pattern)) return "version_locked_write";
	}

	return "unknown";
}

/**
 * Builds per-task detail view showing all conditions side-by-side.
 */
export function buildTaskDetails(results: EvaluationResult[]): TaskDetail[] {
	// Group by taskId
	const taskGroups = groupByTask(results);
	const details: TaskDetail[] = [];

	for (const [taskId, taskResults] of taskGroups) {
		const metadata = inferTaskMetadata(taskId);

		// Group by condition within this task
		const conditionGroups = groupBy(taskResults, (r) => r.condition);

		const conditions: TaskDetail["conditions"] = {};

		for (const [condition, condResults] of conditionGroups) {
			const avgFinalScore =
				condResults.reduce((sum, r) => sum + r.finalScore, 0) /
				condResults.length;
			const avgTestScore =
				condResults.reduce((sum, r) => sum + r.testScore, 0) /
				condResults.length;
			const avgJudgeScore =
				condResults.reduce((sum, r) => sum + r.judgeScore, 0) /
				condResults.length;

			// Collect all hallucination types across reps (deduplicated)
			const allTypes = new Set<HallucinationType>();
			for (const r of condResults) {
				for (const t of r.hallucinations.types) {
					allTypes.add(t);
				}
			}

			conditions[condition] = {
				avgFinalScore,
				avgTestScore,
				avgJudgeScore,
				hallucinationTypes: [...allTypes],
				repCount: condResults.length,
			};
		}

		details.push({
			taskId,
			category: metadata.category,
			library: metadata.library,
			targetVersion: metadata.targetVersion,
			conditions,
		});
	}

	// Sort by taskId for consistent ordering
	details.sort((a, b) => a.taskId.localeCompare(b.taskId));

	return details;
}

// --- Report Generation ---

/**
 * Generates a full report from a results run directory.
 *
 * Reads all result JSON files, computes metrics across dimensions
 * (overall, per-category, per-library, per-task), and returns a
 * structured Report object.
 *
 * @param runDir - Path to the results run directory (e.g., results/2025-01-15T10-30-00-000Z/)
 * @returns Full report with all metrics and breakdowns
 */
export async function generateReport(runDir: string): Promise<Report> {
	const results = await loadResults(runDir);

	if (results.length === 0) {
		return {
			generatedAt: new Date().toISOString(),
			resultsDir: runDir,
			totalTasks: 0,
			totalResults: 0,
			conditions: [],
			overall: [],
			byCategory: {},
			byLibrary: {},
			hallucinationDistribution: {},
			taskDetails: [],
		};
	}

	// Determine unique conditions and task count
	const conditions = [...new Set(results.map((r) => r.condition))].sort();
	const uniqueTaskIds = new Set(results.map((r) => r.taskId));

	// --- Overall metrics per condition ---
	const overall: ConditionMetrics[] = [];
	const conditionResults = groupBy(results, (r) => r.condition);

	for (const condition of conditions) {
		const condResults = conditionResults.get(condition) ?? [];
		overall.push({
			condition,
			metrics: computeMetrics(condResults),
		});
	}

	// --- Per-category breakdown ---
	const byCategory: Record<string, ConditionMetrics[]> = {};
	// Infer category for each result
	const resultsByCategory = new Map<string, EvaluationResult[]>();

	for (const result of results) {
		const metadata = inferTaskMetadata(result.taskId);
		const key = metadata.category;
		const existing = resultsByCategory.get(key) ?? [];
		existing.push(result);
		resultsByCategory.set(key, existing);
	}

	for (const [category, categoryResults] of resultsByCategory) {
		const categoryConditions: ConditionMetrics[] = [];
		const condGroups = groupBy(categoryResults, (r) => r.condition);

		for (const condition of conditions) {
			const condResults = condGroups.get(condition) ?? [];
			categoryConditions.push({
				condition,
				metrics: computeMetrics(condResults),
			});
		}

		byCategory[category] = categoryConditions;
	}

	// --- Per-library breakdown ---
	const byLibrary: Record<string, ConditionMetrics[]> = {};
	const resultsByLibrary = new Map<string, EvaluationResult[]>();

	for (const result of results) {
		const metadata = inferTaskMetadata(result.taskId);
		const key = metadata.library;
		const existing = resultsByLibrary.get(key) ?? [];
		existing.push(result);
		resultsByLibrary.set(key, existing);
	}

	for (const [library, libraryResults] of resultsByLibrary) {
		const libraryConditions: ConditionMetrics[] = [];
		const condGroups = groupBy(libraryResults, (r) => r.condition);

		for (const condition of conditions) {
			const condResults = condGroups.get(condition) ?? [];
			libraryConditions.push({
				condition,
				metrics: computeMetrics(condResults),
			});
		}

		byLibrary[library] = libraryConditions;
	}

	// --- Hallucination type distribution per condition ---
	const hallucinationDistribution: Record<string, HallucinationDistribution[]> =
		{};

	for (const condition of conditions) {
		const condResults = conditionResults.get(condition) ?? [];
		hallucinationDistribution[condition] =
			computeHallucinationDistribution(condResults);
	}

	// --- Per-task details ---
	const taskDetails = buildTaskDetails(results);

	return {
		generatedAt: new Date().toISOString(),
		resultsDir: runDir,
		totalTasks: uniqueTaskIds.size,
		totalResults: results.length,
		conditions,
		overall,
		byCategory,
		byLibrary,
		hallucinationDistribution,
		taskDetails,
	};
}

// --- Formatting ---

/**
 * Library display name mapping for the report table.
 */
const LIBRARY_DISPLAY_NAMES: Record<string, string> = {
	next: "Next.js",
	react: "React",
	ai: "Vercel AI SDK",
	trpc: "tRPC",
	zod: "Zod",
};

/**
 * Category display name mapping.
 */
const CATEGORY_DISPLAY_NAMES: Record<string, string> = {
	bleeding_edge: "CATEGORY A: BLEEDING EDGE",
	version_locked_write: "CATEGORY B1: VERSION-LOCKED WRITE",
	version_locked_audit: "CATEGORY B2: VERSION-LOCKED AUDIT",
};

/**
 * Formats a percentage (0.0-1.0) to a display string like "82.3%".
 */
function formatPercent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

/**
 * Formats a score (0.0-1.0) to a display string like "0.82".
 */
function formatScore(value: number): string {
	return value.toFixed(2);
}

/**
 * Formats a metric value for display, showing "N/A" when no data is available.
 */
function formatMetricValue(
	value: number,
	count: number,
	asPercent: boolean,
): string {
	if (count === 0) return "N/A";
	return asPercent ? formatPercent(value) : formatScore(value);
}

/**
 * Pads a string to a fixed width, right-aligned for numbers.
 */
function padRight(str: string, width: number): string {
	return str.padEnd(width);
}

/**
 * Pads a string to a fixed width, right-aligned.
 */
function padLeft(str: string, width: number): string {
	return str.padStart(width);
}

/**
 * Generates the formatted ASCII table output matching BENCHMARK.md Section 7.3.
 */
export function formatReportText(report: Report): string {
	const lines: string[] = [];
	const separator = "=".repeat(64);
	const dashSeparator = "-".repeat(64);

	// Determine column widths based on conditions present
	const conditions = report.conditions;
	const labelWidth = 26;
	const colWidth = 11;

	lines.push(separator);
	lines.push("                     NIA-BENCH RESULTS v1.0");
	lines.push(separator);

	// Header row
	let headerLine = padRight(" Metric", labelWidth);
	for (const cond of conditions) {
		headerLine += padLeft(
			cond.charAt(0).toUpperCase() + cond.slice(1),
			colWidth,
		);
	}
	lines.push(headerLine);

	lines.push(dashSeparator);

	// Overall metrics
	for (const metricName of [
		"Task Pass Rate",
		"Hallucination Rate",
		"Version Compliance Rate",
		"Mean Combined Score",
	] as const) {
		let line = padRight(` ${metricName}`, labelWidth);

		for (const cond of conditions) {
			const condMetrics = report.overall.find((o) => o.condition === cond);
			const metrics = condMetrics?.metrics;
			const count = metrics?.count ?? 0;

			let value: string;
			if (!metrics || count === 0) {
				value = "N/A";
			} else {
				switch (metricName) {
					case "Task Pass Rate":
						value = formatMetricValue(metrics.taskPassRate, count, true);
						break;
					case "Hallucination Rate":
						value = formatMetricValue(metrics.hallucinationRate, count, true);
						break;
					case "Version Compliance Rate":
						value = formatMetricValue(
							metrics.versionComplianceRate,
							count,
							true,
						);
						break;
					case "Mean Combined Score":
						value = formatMetricValue(metrics.meanCombinedScore, count, false);
						break;
				}
			}

			line += padLeft(value, colWidth);
		}

		lines.push(line);
	}

	// Per-category breakdowns
	const categoryOrder = [
		"bleeding_edge",
		"version_locked_write",
		"version_locked_audit",
	];

	for (const category of categoryOrder) {
		const categoryMetrics = report.byCategory[category];
		if (!categoryMetrics) continue;

		lines.push(separator);

		const displayName = CATEGORY_DISPLAY_NAMES[category] ?? category;
		lines.push(` ${displayName}`);

		// Determine which metrics to show per category
		const metricsToShow: Array<{
			label: string;
			key: keyof MetricsGroup;
			asPercent: boolean;
		}> = [{ label: "Task Pass Rate", key: "taskPassRate", asPercent: true }];

		if (category === "bleeding_edge") {
			metricsToShow.push({
				label: "Hallucination Rate",
				key: "hallucinationRate",
				asPercent: true,
			});
		} else if (category === "version_locked_write") {
			metricsToShow.push({
				label: "Version Compliance Rate",
				key: "versionComplianceRate",
				asPercent: true,
			});
		} else if (category === "version_locked_audit") {
			metricsToShow.push({
				label: "Mean Combined Score",
				key: "meanCombinedScore",
				asPercent: false,
			});
		}

		for (const metric of metricsToShow) {
			let line = padRight(` ${metric.label}`, labelWidth);

			for (const cond of conditions) {
				const condMetrics = categoryMetrics.find((m) => m.condition === cond);
				const metrics = condMetrics?.metrics;
				const count = metrics?.count ?? 0;
				const value = metrics
					? formatMetricValue(metrics[metric.key], count, metric.asPercent)
					: "N/A";
				line += padLeft(value, colWidth);
			}

			lines.push(line);
		}
	}

	// Per-library breakdown
	lines.push(separator);
	lines.push(" PER LIBRARY");

	const libraryOrder = ["next", "react", "ai", "trpc", "zod"];

	for (const library of libraryOrder) {
		const libraryMetrics = report.byLibrary[library];
		if (!libraryMetrics) continue;

		const displayName = LIBRARY_DISPLAY_NAMES[library] ?? library;
		let line = padRight(` ${displayName}`, labelWidth);

		for (const cond of conditions) {
			const condMetrics = libraryMetrics.find((m) => m.condition === cond);
			const metrics = condMetrics?.metrics;
			const count = metrics?.count ?? 0;
			const value = metrics
				? formatMetricValue(metrics.meanCombinedScore, count, false)
				: "N/A";
			line += padLeft(value, colWidth);
		}

		lines.push(line);
	}

	lines.push(separator);

	// Hallucination type distribution (bonus section not in BENCHMARK.md but useful)
	if (Object.keys(report.hallucinationDistribution).length > 0) {
		lines.push("");
		lines.push(" HALLUCINATION TYPE DISTRIBUTION");
		lines.push(dashSeparator);

		let headerLine2 = padRight(" Type", labelWidth);
		for (const cond of conditions) {
			headerLine2 += padLeft(
				cond.charAt(0).toUpperCase() + cond.slice(1),
				colWidth,
			);
		}
		lines.push(headerLine2);
		lines.push(dashSeparator);

		const typeLabels: Record<string, string> = {
			invented_method: "Invented Method",
			wrong_parameter: "Wrong Parameter",
			outdated_api: "Outdated API",
			future_api: "Future API",
			wrong_import_path: "Wrong Import Path",
			version_mismatch: "Version Mismatch",
		};

		for (const [type, label] of Object.entries(typeLabels)) {
			let line = padRight(` ${label}`, labelWidth);

			for (const cond of conditions) {
				const dist = report.hallucinationDistribution[cond];
				const entry = dist?.find((d) => d.type === type);
				const value = entry ? `${entry.count}` : "0";
				line += padLeft(value, colWidth);
			}

			lines.push(line);
		}

		lines.push(separator);
	}

	// Per-task detail table
	if (report.taskDetails.length > 0) {
		lines.push("");
		lines.push(" PER-TASK BREAKDOWN");
		lines.push(dashSeparator);

		const taskColWidth = 38;
		let taskHeader = padRight(" Task ID", taskColWidth);
		for (const cond of conditions) {
			taskHeader += padLeft(
				cond.charAt(0).toUpperCase() + cond.slice(1),
				colWidth,
			);
		}
		lines.push(taskHeader);
		lines.push(dashSeparator);

		for (const detail of report.taskDetails) {
			let line = padRight(` ${detail.taskId}`, taskColWidth);

			for (const cond of conditions) {
				const condData = detail.conditions[cond];
				const value = condData ? formatScore(condData.avgFinalScore) : "N/A";
				line += padLeft(value, colWidth);
			}

			lines.push(line);
		}

		lines.push(separator);
	}

	return lines.join("\n");
}

// --- Report Writing ---

/**
 * Writes the report to both JSON and text files in the run directory.
 *
 * Output files:
 * - {runDir}/report.json — Full structured report for programmatic access
 * - {runDir}/report.txt — Human-readable ASCII table
 */
export async function writeReport(
	runDir: string,
	report: Report,
): Promise<void> {
	// Write JSON report
	const jsonPath = join(runDir, "report.json");
	await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf-8");

	// Write text report
	const textPath = join(runDir, "report.txt");
	const formattedText = formatReportText(report);
	await writeFile(textPath, formattedText, "utf-8");
}

/**
 * Full report pipeline: load results, generate report, write output files,
 * and print the formatted table to console.
 *
 * @param runDir - Path to the results run directory
 * @returns The generated report
 */
export async function generateAndWriteReport(runDir: string): Promise<Report> {
	const report = await generateReport(runDir);

	if (report.totalResults === 0) {
		console.log("No results found in the specified directory.");
		return report;
	}

	// Write report files
	await writeReport(runDir, report);

	// Print to console
	const formattedText = formatReportText(report);
	console.log(formattedText);

	console.log(`\nReport written to:`);
	console.log(`  JSON: ${join(runDir, "report.json")}`);
	console.log(`  Text: ${join(runDir, "report.txt")}`);

	return report;
}
