import type { AstCheckResult } from "@/tests/ast-checker";
import type { Task } from "@/types/task";
import type { CriterionResult, JudgeResult } from "./rubric-scorer";

// --- Hallucination Types ---

/**
 * Hallucination taxonomy as defined in BENCHMARK.md Section 5.4.
 * Each type describes a specific category of incorrect API usage.
 */
export type HallucinationType =
	| "invented_method"
	| "wrong_parameter"
	| "outdated_api"
	| "future_api"
	| "wrong_import_path"
	| "version_mismatch";

/**
 * A single classified hallucination with evidence.
 */
export interface HallucinationDetail {
	type: HallucinationType;
	evidence: string;
	description: string;
}

/**
 * Full hallucination classification result for a single code sample.
 */
export interface HallucinationResult {
	types: HallucinationType[];
	details: HallucinationDetail[];
}

// --- Classification from AST check failures ---

/**
 * Maps a failed AST check to zero or more hallucination types based on
 * the check type, the task category, and the task's common_hallucinations hints.
 */
function classifyAstFailure(
	task: Task,
	result: AstCheckResult,
): HallucinationDetail[] {
	if (result.passed) return [];

	const check = result.check;
	const details: HallucinationDetail[] = [];
	const category = task.category;

	switch (check.type) {
		case "import_exists": {
			// A required import is missing — could be wrong_import_path if the import
			// exists elsewhere, or version_mismatch if they used a different version's import
			details.push({
				type: "wrong_import_path",
				evidence: result.message,
				description: `Missing required import: { ${check.name} } from '${check.from}'`,
			});
			break;
		}

		case "import_absent": {
			// An import that should NOT exist is present
			// Determine if it's from a newer or older version
			const hallucinationType = inferVersionDirection(
				task,
				check.name,
				category,
			);
			details.push({
				type: hallucinationType,
				evidence: result.message,
				description: `Unwanted import '${check.name}' is present${check.from ? ` from '${check.from}'` : ""}`,
			});
			break;
		}

		case "module_import_absent": {
			// Importing from a module that shouldn't be used for this version
			details.push({
				type: "wrong_import_path",
				evidence: result.message,
				description: `Imports from forbidden module '${check.module}'`,
			});
			break;
		}

		case "function_exported": {
			// A required exported function is missing — could be version_mismatch
			details.push({
				type: "version_mismatch",
				evidence: result.message,
				description: `Required exported function '${check.name}' is missing`,
			});
			break;
		}

		case "function_absent": {
			// A function that should NOT be exported is present
			const hallucinationType = inferVersionDirection(
				task,
				check.name,
				category,
			);
			details.push({
				type: hallucinationType,
				evidence: result.message,
				description: `Unwanted exported function '${check.name}' is present`,
			});
			break;
		}

		case "await_present": {
			// A call that should be awaited is NOT awaited
			// This usually means using a sync version when async is required (outdated pattern)
			details.push({
				type: "outdated_api",
				evidence: result.message,
				description: `'${check.call}' should be awaited but is not — using sync pattern from older version`,
			});
			break;
		}

		case "await_absent": {
			// A call that should NOT be awaited IS awaited
			// This means using an async pattern from a newer version
			details.push({
				type: "future_api",
				evidence: result.message,
				description: `'${check.call}' should not be awaited — using async pattern from newer version`,
			});
			break;
		}

		case "call_exists": {
			// A required call is missing — could indicate version_mismatch or invented_method
			details.push({
				type: "version_mismatch",
				evidence: result.message,
				description: `Required call/usage '${check.call}' is missing`,
			});
			break;
		}

		case "call_absent": {
			// A call that should NOT exist is present
			const hallucinationType = inferVersionDirection(
				task,
				check.call,
				category,
			);
			details.push({
				type: hallucinationType,
				evidence: result.message,
				description: `Unwanted call '${check.call}' is present`,
			});
			break;
		}

		case "directive_present": {
			// A required directive is missing
			details.push({
				type: "version_mismatch",
				evidence: result.message,
				description: `Required directive '${check.directive}' is missing`,
			});
			break;
		}

		case "property_location": {
			// A property is not inside the expected call expression
			details.push({
				type: "wrong_parameter",
				evidence: result.message,
				description: `Property '${check.property}' not found inside '${check.insideCall}()'`,
			});
			break;
		}

		case "async_function": {
			// A function that should be async is not
			details.push({
				type: "version_mismatch",
				evidence: result.message,
				description: `Function${check.name ? ` '${check.name}'` : ""} should be async`,
			});
			break;
		}

		case "async_generator": {
			// A function that should be an async generator is not
			details.push({
				type: "version_mismatch",
				evidence: result.message,
				description: `Function${check.name ? ` '${check.name}'` : ""} should be an async generator`,
			});
			break;
		}

		case "yield_present": {
			// yield keyword is missing where expected
			details.push({
				type: "version_mismatch",
				evidence: result.message,
				description: `yield keyword not found${check.name ? ` in function '${check.name}'` : ""}`,
			});
			break;
		}

		case "type_annotation": {
			// Wrong type annotation on a parameter
			details.push({
				type: "wrong_parameter",
				evidence: result.message,
				description: `Parameter '${check.parameter}' has wrong type annotation (expected '${check.annotation}')`,
			});
			break;
		}

		case "property_absent": {
			// A property that should NOT exist is present
			const hallucinationType = inferVersionDirection(
				task,
				check.property,
				category,
			);
			details.push({
				type: hallucinationType,
				evidence: result.message,
				description: `Unwanted property '${check.property}' is present${check.inObject ? ` in '${check.inObject}'` : ""}`,
			});
			break;
		}

		default: {
			const _exhaustive: never = check;
			void _exhaustive;
		}
	}

	return details;
}

/**
 * Infers whether a wrong API usage is from a newer version (future_api) or
 * older version (outdated_api) based on the task category.
 *
 * - bleeding_edge tasks target the newest version, so wrong APIs are typically outdated
 * - version_locked_write tasks target an older version, so wrong APIs are typically from the future
 * - version_locked_audit tasks can have either direction
 */
function inferVersionDirection(
	task: Task,
	apiName: string,
	category: Task["category"],
): HallucinationType {
	// Check common_hallucinations for hints about version direction
	const commonHallucinations = task.common_hallucinations
		.join(" ")
		.toLowerCase();
	const lowerApiName = apiName.toLowerCase();

	// Look for explicit version direction hints in common hallucinations
	if (
		commonHallucinations.includes("v15") ||
		commonHallucinations.includes("v14") ||
		commonHallucinations.includes("v13") ||
		commonHallucinations.includes("older") ||
		commonHallucinations.includes("earlier")
	) {
		// Common hallucinations mention older version patterns
		if (category === "bleeding_edge") {
			return "outdated_api";
		}
	}

	if (
		commonHallucinations.includes("newer") ||
		commonHallucinations.includes("future")
	) {
		if (category === "version_locked_write") {
			return "future_api";
		}
	}

	// Check if the API name appears in common hallucinations with version context
	for (const hint of task.common_hallucinations) {
		const lowerHint = hint.toLowerCase();
		if (lowerHint.includes(lowerApiName)) {
			// If the hallucination hint mentions a newer version pattern
			if (
				lowerHint.includes("v15") ||
				lowerHint.includes("v16") ||
				lowerHint.includes("v19") ||
				lowerHint.includes("v18") ||
				lowerHint.includes("newer") ||
				lowerHint.includes("future")
			) {
				return "future_api";
			}
			// If the hallucination hint mentions an older version pattern
			if (
				lowerHint.includes("v13") ||
				lowerHint.includes("v14") ||
				lowerHint.includes("v17") ||
				lowerHint.includes("older") ||
				lowerHint.includes("earlier") ||
				lowerHint.includes("deprecated")
			) {
				return "outdated_api";
			}
		}
	}

	// Default based on category
	switch (category) {
		case "bleeding_edge":
			// Bleeding-edge tasks target newest version — wrong APIs are typically from older versions
			return "outdated_api";
		case "version_locked_write":
			// Version-locked tasks target older versions — wrong APIs are typically from newer versions
			return "future_api";
		case "version_locked_audit":
			// Audit tasks can go either way — default to version_mismatch
			return "version_mismatch";
		default:
			return "version_mismatch";
	}
}

// --- Classification from judge results ---

/**
 * Extracts hallucination signals from judge criterion results.
 * Specifically looks at `no_hallucination` criteria that received FAIL verdicts.
 *
 * To avoid inflating hallucination counts from supplementary code the agent
 * writes beyond the task scope (e.g. a UI component for a route-handler task),
 * we only count judge-sourced hallucinations when at least one non-hallucination
 * rubric criterion also failed. If all core criteria pass, a lone
 * `no_hallucination` FAIL is likely triggered by extra code and is excluded.
 */
function classifyFromJudgeResults(
	_task: Task,
	judgeResult: JudgeResult,
): HallucinationDetail[] {
	const details: HallucinationDetail[] = [];

	// Check whether any core (non-hallucination) criterion failed
	const hasCoreFailure = judgeResult.criteria.some(
		(c) => c.verdict === "FAIL" && !isHallucinationCriterion(c.name),
	);

	for (const criterion of judgeResult.criteria) {
		if (
			criterion.verdict === "FAIL" &&
			isHallucinationCriterion(criterion.name)
		) {
			// Only count judge-sourced hallucinations when the core task also has
			// failures. A lone no_hallucination FAIL with all other criteria passing
			// typically means the agent wrote correct core code but added
			// supplementary code the judge flagged — not a true hallucination.
			if (!hasCoreFailure) {
				continue;
			}

			// The judge identified a hallucination — classify based on evidence
			const hallucinationType = inferTypeFromJudgeEvidence(criterion);
			details.push({
				type: hallucinationType,
				evidence: criterion.evidence,
				description: `Judge identified hallucination: ${criterion.reasoning || criterion.evidence}`,
			});
		}
	}

	return details;
}

/**
 * Checks if a criterion name relates to hallucination detection.
 */
function isHallucinationCriterion(name: string): boolean {
	const lower = name.toLowerCase();
	return (
		lower.includes("hallucination") ||
		lower.includes("no_hallucination") ||
		lower.includes("invented") ||
		lower.includes("no_invented")
	);
}

/**
 * Infers a hallucination type from judge criterion evidence/reasoning text.
 * Falls back to `invented_method` when the specific type can't be determined.
 */
function inferTypeFromJudgeEvidence(
	criterion: CriterionResult,
): HallucinationType {
	const text = `${criterion.evidence} ${criterion.reasoning}`.toLowerCase();

	if (
		text.includes("import") &&
		(text.includes("wrong") ||
			text.includes("incorrect") ||
			text.includes("path"))
	) {
		return "wrong_import_path";
	}
	if (
		text.includes("parameter") ||
		text.includes("argument") ||
		text.includes("param")
	) {
		return "wrong_parameter";
	}
	if (
		text.includes("deprecated") ||
		text.includes("removed") ||
		text.includes("older") ||
		text.includes("outdated")
	) {
		return "outdated_api";
	}
	if (
		text.includes("future") ||
		text.includes("newer") ||
		text.includes("not yet") ||
		text.includes("not available")
	) {
		return "future_api";
	}
	if (
		text.includes("mixed") ||
		text.includes("different version") ||
		text.includes("mismatch")
	) {
		return "version_mismatch";
	}

	// Default: if the judge says there's a hallucination but we can't determine the type
	return "invented_method";
}

// --- Cross-reference with common hallucinations ---

/**
 * Cross-references detected hallucination details against the task's
 * known `common_hallucinations` list to provide better labels and descriptions.
 */
function crossReferenceCommonHallucinations(
	task: Task,
	details: HallucinationDetail[],
): HallucinationDetail[] {
	if (task.common_hallucinations.length === 0) return details;

	return details.map((detail) => {
		// Check if any common hallucination pattern matches the evidence
		for (const commonPattern of task.common_hallucinations) {
			const lowerPattern = commonPattern.toLowerCase();
			const lowerEvidence = detail.evidence.toLowerCase();
			const lowerDescription = detail.description.toLowerCase();

			// Check for keyword overlap between the detected hallucination and known patterns
			const patternWords = lowerPattern
				.split(/\s+/)
				.filter((w) => w.length > 3);
			const matchCount = patternWords.filter(
				(word) =>
					lowerEvidence.includes(word) || lowerDescription.includes(word),
			).length;

			// If significant overlap, enhance the description with the known pattern
			if (matchCount >= 2 || (patternWords.length <= 3 && matchCount >= 1)) {
				return {
					...detail,
					description: `${detail.description} (matches known pattern: "${commonPattern}")`,
				};
			}
		}

		return detail;
	});
}

// --- Main classifier function ---

/**
 * Classifies hallucinations in generated code by combining signals from:
 * 1. Failed AST checks (mapped to hallucination types)
 * 2. LLM judge results (FAIL verdicts on hallucination-related criteria)
 * 3. Cross-reference with the task's known `common_hallucinations` list
 *
 * A single code sample can have multiple hallucination types simultaneously.
 *
 * @param task - The benchmark task definition
 * @param generatedCode - The code generated by the agent (unused directly, but available for future analysis)
 * @param astResults - Results from AST checks
 * @param judgeResult - Results from the LLM judge evaluation
 * @returns Classification result with hallucination types and detailed evidence
 */
export function classifyHallucinations(
	task: Task,
	_generatedCode: string,
	astResults: AstCheckResult[],
	judgeResult: JudgeResult,
): HallucinationResult {
	// Step 1: Classify from failed AST checks
	const astDetails: HallucinationDetail[] = [];
	for (const result of astResults) {
		const classified = classifyAstFailure(task, result);
		astDetails.push(...classified);
	}

	// Step 2: Classify from judge results
	const judgeDetails = classifyFromJudgeResults(task, judgeResult);

	// Step 3: Combine all details
	let allDetails = [...astDetails, ...judgeDetails];

	// Step 4: Cross-reference with common hallucinations for better labels
	allDetails = crossReferenceCommonHallucinations(task, allDetails);

	// Step 5: Deduplicate types
	const uniqueTypes = [...new Set(allDetails.map((d) => d.type))];

	return {
		types: uniqueTypes,
		details: allDetails,
	};
}
