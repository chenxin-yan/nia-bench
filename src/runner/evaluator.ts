import type { HallucinationResult, JudgeResult, ScorerConfig } from "@/judge";
import { classifyHallucinations, scoreWithRubric } from "@/judge";
import type { AstCheckResult } from "@/tests";
import { runAstChecks } from "@/tests";
import type { AstCheck, Task } from "@/types/task";
import type { AgentError } from "./agent";

// --- Types ---

/**
 * Configuration for the evaluator.
 */
export interface EvaluatorConfig {
	/** Skip the LLM judge evaluation (for faster iteration during development) */
	skipJudge?: boolean;
	/** Configuration for the LLM judge scorer */
	scorerConfig?: ScorerConfig;
}

/**
 * Full evaluation result for a single code sample.
 *
 * This is the lean "scorecard" stored as run-{index}.json. Verbose artifacts
 * (full agent transcript, tool call details with outputs, working directory
 * snapshot) are stored as separate files alongside this JSON. See result-store.ts
 * for the full artifact layout.
 */
export interface EvaluationResult {
	/** Task ID from the task definition */
	taskId: string;
	/** Which condition was used (baseline, context7, nia) */
	condition: string;
	/** Repetition index (0-based) */
	runIndex: number;
	/** Task category from the task definition */
	category: string;
	/** Library name from the task definition */
	library: string;
	/** Target version from the task definition */
	targetVersion: string;
	/** Automated test score (AST checks) as 0.0-1.0 */
	testScore: number;
	/** LLM judge score as 0.0-1.0 */
	judgeScore: number;
	/** Combined final score: 0.6 * testScore + 0.4 * judgeScore */
	finalScore: number;
	/** Individual AST check results */
	astResults: AstCheckResult[];
	/** LLM judge evaluation result (null if judge was skipped) */
	judgeResult: JudgeResult | null;
	/** Hallucination classification */
	hallucinations: HallucinationResult;
	/** The extracted code files that were evaluated */
	extractedFiles: Record<string, string>;
	/** The full prompt sent to the agent (task prompt + condition suffix) */
	prompt: string;
	/** Agent execution duration in milliseconds */
	durationMs: number;
	/** Agent error if the agent failed to execute (null on success) */
	agentError: AgentError | null;
	/** Number of agent execution attempts (1 = succeeded first try, >1 = required retries) */
	attempts: number;
	/** Total number of tool calls made by the agent (details in tool-calls-{index}.json) */
	toolCallCount: number;
	/** Tool call summary: tool name → invocation count (for reporting without loading full tool-calls file) */
	toolCallSummary: Record<string, number>;
}

// --- Helper Functions ---

/**
 * Groups AST checks by the `file` field. Checks without a `file` field
 * are grouped under the empty string key (primary file).
 */
function groupChecksByFile(checks: AstCheck[]): Map<string, AstCheck[]> {
	const groups = new Map<string, AstCheck[]>();

	for (const check of checks) {
		const fileKey = "file" in check && check.file ? check.file : "";
		const existing = groups.get(fileKey) ?? [];
		existing.push(check);
		groups.set(fileKey, existing);
	}

	return groups;
}

/**
 * Determines which code string to use for a given file key from the extracted files.
 *
 * Resolution order:
 * 1. Exact match on the file key
 * 2. Partial match (file key appears at the end of a path, e.g., "page.tsx" matches "app/page.tsx")
 * 3. If the file key is empty (primary file), use the first file, or concatenate all files
 */
function resolveCodeForFile(
	fileKey: string,
	extractedFiles: Record<string, string>,
): string | null {
	const filenames = Object.keys(extractedFiles);

	if (fileKey === "") {
		// Primary file — use the first file if only one, or concatenate all
		if (filenames.length === 0) return null;
		if (filenames.length === 1) {
			const key = filenames[0];
			return key ? (extractedFiles[key] ?? null) : null;
		}
		// Multiple files — concatenate all for primary checks
		return Object.values(extractedFiles).join("\n\n");
	}

	// Exact match
	if (extractedFiles[fileKey] !== undefined) {
		return extractedFiles[fileKey] ?? null;
	}

	// Partial match: fileKey at end of a path
	for (const filename of filenames) {
		if (filename.endsWith(fileKey) || filename.endsWith(`/${fileKey}`)) {
			return extractedFiles[filename] ?? null;
		}
	}

	return null;
}

/**
 * Concatenates all extracted files with filename headers for the LLM judge.
 * The judge needs full context across all files.
 */
function concatenateFilesForJudge(
	extractedFiles: Record<string, string>,
): string {
	const entries = Object.entries(extractedFiles);

	if (entries.length === 0) return "";
	if (entries.length === 1) {
		const entry = entries[0];
		return entry ? entry[1] : "";
	}

	return entries
		.map(([filename, code]) => `// --- ${filename} ---\n${code}`)
		.join("\n\n");
}

/**
 * Returns true if the AST check type asserts the ABSENCE of something.
 * When there is no code at all, absence checks are trivially satisfied
 * (nothing can be present if nothing was generated).
 */
function isAbsenceCheckType(type: AstCheck["type"]): boolean {
	switch (type) {
		case "import_absent":
		case "module_import_absent":
		case "call_absent":
		case "function_absent":
		case "property_absent":
		case "await_absent":
			return true;
		default:
			return false;
	}
}

// --- Main Evaluator ---

/**
 * Evaluates extracted code files for a given task by running all evaluation layers:
 *
 * Layer 1: AST checks (programmatic assertion checking)
 *   - Runs checks on appropriate files (respecting the `file` field on each check)
 *   - Computes testScore = passedChecks / totalChecks
 *
 * Layer 2: LLM judge (rubric evaluation via OpenRouter)
 *   - Scores generated code against the task's rubric criteria
 *   - Returns judgeScore (0.0-1.0)
 *
 * Combined score: finalScore = 0.6 * testScore + 0.4 * judgeScore
 *
 * Special case for audit tasks: when no AST checks exist,
 * finalScore = judgeScore (100% judge weight).
 *
 * @param task - The benchmark task definition
 * @param extractedFiles - Map of filename -> code content from the agent
 * @param condition - Which condition was used (for result metadata)
 * @param runIndex - Repetition index (for result metadata)
 * @param config - Evaluator configuration
 * @param agentMeta - Agent execution metadata (prompt, duration, tool counts, error, attempts)
 * @returns Full evaluation result
 */
export async function evaluateCode(
	task: Task,
	extractedFiles: Record<string, string>,
	condition: string,
	runIndex: number,
	config: EvaluatorConfig = {},
	agentMeta: {
		prompt: string;
		durationMs: number;
		toolCallCount: number;
		toolCallSummary: Record<string, number>;
		agentError: AgentError | null;
		attempts: number;
	} = {
		prompt: "",
		durationMs: 0,
		toolCallCount: 0,
		toolCallSummary: {},
		agentError: null,
		attempts: 1,
	},
): Promise<EvaluationResult> {
	const astChecks = task.test_spec.ast_checks;
	const hasExtractedCode = Object.keys(extractedFiles).length > 0;
	const isAgentCrash = agentMeta.agentError !== null && !hasExtractedCode;

	// --- Early exit for agent crashes with no code ---
	// When the agent crashes (e.g., SIGTERM/timeout) and produces no code,
	// running AST checks and hallucination classification generates misleading
	// results (phantom hallucinations, incorrect absence-check failures).
	// Instead, we record a clean zero-score result without false signals.
	if (isAgentCrash) {
		const crashMessage = `Agent crashed: ${agentMeta.agentError?.name}: ${agentMeta.agentError?.message}`;

		// All AST checks get a descriptive crash message without false hallucination signals
		const crashAstResults: AstCheckResult[] = astChecks.map((check) => ({
			check,
			passed: false,
			message: crashMessage,
		}));

		return {
			taskId: task.id,
			condition,
			runIndex,
			category: task.category,
			library: task.library,
			targetVersion: task.target_version,
			testScore: 0,
			judgeScore: 0,
			finalScore: 0,
			astResults: crashAstResults,
			judgeResult: null,
			hallucinations: { types: [], details: [] },
			extractedFiles,
			prompt: agentMeta.prompt,
			durationMs: agentMeta.durationMs,
			agentError: agentMeta.agentError,
			attempts: agentMeta.attempts,
			toolCallCount: agentMeta.toolCallCount,
			toolCallSummary: agentMeta.toolCallSummary,
		};
	}

	// --- Layer 1: AST Checks ---
	const allAstResults: AstCheckResult[] = [];

	// Build a descriptive "no code" message that includes the agent error if available
	const noCodeMessage = agentMeta.agentError
		? `Agent error: ${agentMeta.agentError.name}: ${agentMeta.agentError.message}`
		: "No code files extracted from agent output";

	if (astChecks.length > 0) {
		// Group checks by file
		const checksByFile = groupChecksByFile(astChecks);

		for (const [fileKey, checks] of checksByFile) {
			const code = resolveCodeForFile(fileKey, extractedFiles);

			if (code === null) {
				// No code found for this file — handle absence checks correctly.
				// "Absent" checks (import_absent, call_absent, etc.) are trivially
				// satisfied when there is no code — nothing can be present if nothing
				// was generated. Only "exists"/"present" checks should fail.
				for (const check of checks) {
					const isAbsenceCheck = isAbsenceCheckType(check.type);
					allAstResults.push({
						check,
						passed: isAbsenceCheck,
						message: isAbsenceCheck
							? `Trivially passed: no code to contain the unwanted pattern`
							: fileKey
								? `No code found for file '${fileKey}'${agentMeta.agentError ? ` (${noCodeMessage})` : ""}`
								: noCodeMessage,
					});
				}
			} else {
				const results = runAstChecks(code, checks);
				allAstResults.push(...results);
			}
		}
	}

	// --- Compute test score ---
	const totalAssertions = allAstResults.length;
	const passedAssertions = allAstResults.filter((r) => r.passed).length;

	const testScore =
		totalAssertions > 0 ? passedAssertions / totalAssertions : 0;

	// --- Layer 2: LLM Judge ---
	let judgeResult: JudgeResult | null = null;
	let judgeScore = 0;

	if (!config.skipJudge) {
		// Concatenate all files for the judge
		const codeForJudge = concatenateFilesForJudge(extractedFiles);
		judgeResult = await scoreWithRubric(
			task,
			codeForJudge,
			config.scorerConfig,
		);
		judgeScore = judgeResult.judgeScore;
	}

	// --- Compute combined score ---
	const hasAstChecks = astChecks.length > 0;
	let finalScore: number;

	if (!hasAstChecks) {
		// Audit tasks (no AST checks) — 100% judge weight
		finalScore = judgeScore;
	} else if (config.skipJudge) {
		// Skip-judge mode — 100% test weight
		finalScore = testScore;
	} else {
		// Standard formula: 60% test + 40% judge
		finalScore = 0.6 * testScore + 0.4 * judgeScore;
	}

	// --- Hallucination Classification ---
	// Need a JudgeResult for the classifier — create a dummy if judge was skipped
	const judgeResultForClassifier: JudgeResult = judgeResult ?? {
		criteria: [],
		judgeScore: 0,
		rawResponses: [],
	};

	const codeForClassifier = concatenateFilesForJudge(extractedFiles);
	const hallucinations = classifyHallucinations(
		task,
		codeForClassifier,
		allAstResults,
		judgeResultForClassifier,
	);

	return {
		taskId: task.id,
		condition,
		runIndex,
		category: task.category,
		library: task.library,
		targetVersion: task.target_version,
		testScore,
		judgeScore,
		finalScore,
		astResults: allAstResults,
		judgeResult,
		hallucinations,
		extractedFiles,
		prompt: agentMeta.prompt,
		durationMs: agentMeta.durationMs,
		agentError: agentMeta.agentError,
		attempts: agentMeta.attempts,
		toolCallCount: agentMeta.toolCallCount,
		toolCallSummary: agentMeta.toolCallSummary,
	};
}
