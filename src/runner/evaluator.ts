import type { HallucinationResult, JudgeResult, ScorerConfig } from "@/judge";
import { classifyHallucinations, scoreWithRubric } from "@/judge";
import type { AstCheckResult, TypeCheckResult } from "@/tests";
import { runAstChecks, runTypeCheck, runTypeCheckMultiFile } from "@/tests";
import type { AstCheck, Task } from "@/types/task";

// --- Types ---

/**
 * Configuration for the evaluator.
 */
export interface EvaluatorConfig {
	/** Skip the LLM judge evaluation (for faster iteration during development) */
	skipJudge?: boolean;
	/** Configuration for the LLM judge scorer */
	scorerConfig?: ScorerConfig;
	/** Base directory for typecheck environments */
	typecheckEnvsDir?: string;
}

/**
 * Full evaluation result for a single code sample.
 */
export interface EvaluationResult {
	/** Task ID from the task definition */
	taskId: string;
	/** Which condition was used (baseline, context7, nia) */
	condition: string;
	/** Repetition index (0-based) */
	runIndex: number;
	/** Automated test score (AST checks + optional type check) as 0.0-1.0 */
	testScore: number;
	/** LLM judge score as 0.0-1.0 */
	judgeScore: number;
	/** Combined final score: 0.6 * testScore + 0.4 * judgeScore */
	finalScore: number;
	/** Individual AST check results */
	astResults: AstCheckResult[];
	/** Type check result (null if type_check is false or not applicable) */
	typeCheckResult: TypeCheckResult | null;
	/** LLM judge evaluation result (null if judge was skipped) */
	judgeResult: JudgeResult | null;
	/** Hallucination classification */
	hallucinations: HallucinationResult;
	/** The extracted code files that were evaluated */
	extractedFiles: Record<string, string>;
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

// --- Main Evaluator ---

/**
 * Evaluates extracted code files for a given task by running all evaluation layers:
 *
 * Layer 1: AST checks (programmatic assertion checking)
 *   - Runs checks on appropriate files (respecting the `file` field on each check)
 *   - Computes testScore = passedChecks / totalChecks
 *
 * Layer 1b: Type checking (optional, if task.test_spec.type_check is true)
 *   - Runs tsc --noEmit against the version-specific environment
 *   - Adds one more pass/fail assertion to the test score
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
 * @returns Full evaluation result
 */
export async function evaluateCode(
	task: Task,
	extractedFiles: Record<string, string>,
	condition: string,
	runIndex: number,
	config: EvaluatorConfig = {},
): Promise<EvaluationResult> {
	// --- Layer 1: AST Checks ---
	const astChecks = task.test_spec.ast_checks;
	const allAstResults: AstCheckResult[] = [];

	if (astChecks.length > 0) {
		// Group checks by file
		const checksByFile = groupChecksByFile(astChecks);

		for (const [fileKey, checks] of checksByFile) {
			const code = resolveCodeForFile(fileKey, extractedFiles);

			if (code === null) {
				// No code found for this file — all checks fail
				for (const check of checks) {
					allAstResults.push({
						check,
						passed: false,
						message: fileKey
							? `No code found for file '${fileKey}'`
							: "No code files extracted from agent output",
					});
				}
			} else {
				const results = runAstChecks(code, checks);
				allAstResults.push(...results);
			}
		}
	}

	// --- Layer 1b: Type Checking ---
	let typeCheckResult: TypeCheckResult | null = null;

	if (task.test_spec.type_check) {
		const libraryVersion = {
			library: task.library,
			version: task.target_version,
		};

		const filenames = Object.keys(extractedFiles);

		if (filenames.length === 0) {
			typeCheckResult = {
				passed: false,
				errors: ["No code files extracted from agent output"],
			};
		} else if (filenames.length === 1) {
			const key = filenames[0];
			const code = key ? (extractedFiles[key] ?? "") : "";
			typeCheckResult = await runTypeCheck(code, libraryVersion, {
				typecheckEnvsDir: config.typecheckEnvsDir,
			});
		} else {
			typeCheckResult = await runTypeCheckMultiFile(
				extractedFiles,
				libraryVersion,
				{
					typecheckEnvsDir: config.typecheckEnvsDir,
				},
			);
		}
	}

	// --- Compute test score ---
	let totalAssertions = allAstResults.length;
	let passedAssertions = allAstResults.filter((r) => r.passed).length;

	// Include type check as an additional assertion if it was run
	if (typeCheckResult !== null) {
		totalAssertions += 1;
		if (typeCheckResult.passed) {
			passedAssertions += 1;
		}
	}

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
	const hasAstChecks = astChecks.length > 0 || task.test_spec.type_check;
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
		testScore,
		judgeScore,
		finalScore,
		astResults: allAstResults,
		typeCheckResult,
		judgeResult,
		hallucinations,
		extractedFiles,
	};
}
