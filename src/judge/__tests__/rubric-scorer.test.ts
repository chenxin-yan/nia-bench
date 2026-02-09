import { describe, expect, test } from "bun:test";
import type { Task } from "@/types/task";
import type { JudgeCallResult } from "../openrouter-client";
import { parseJudgeResponse } from "../openrouter-client";
import type { CriterionResult } from "../rubric-scorer";
import { applyMajorityVote, calculateJudgeScore } from "../rubric-scorer";

// --- Mock data ---

const mockTask: Task = {
	id: "test-task",
	category: "bleeding_edge",
	library: "next",
	target_version: "16.0.0",
	prompt: "Test prompt",
	reference_solution: "Test solution",
	test_spec: { ast_checks: [] },
	rubric: {
		criteria: [
			{ name: "criterion_a", weight: 0.3, description: "Check A" },
			{ name: "criterion_b", weight: 0.3, description: "Check B" },
			{ name: "criterion_c", weight: 0.4, description: "Check C" },
		],
	},
	common_hallucinations: ["hallucination 1"],
};

function makeSuccessfulRun(
	verdicts: Record<string, "PASS" | "FAIL">,
): JudgeCallResult {
	return {
		criteria: Object.entries(verdicts).map(([name, verdict]) => ({
			criterion: name,
			verdict,
			evidence: `Evidence for ${name}`,
			reasoning: `Reasoning for ${name} (${verdict})`,
		})),
		rawResponse: JSON.stringify(
			Object.entries(verdicts).map(([name, verdict]) => ({
				criterion: name,
				verdict,
				evidence: `Evidence for ${name}`,
				reasoning: `Reasoning for ${name} (${verdict})`,
			})),
		),
		success: true,
	};
}

function makeFailedRun(error: string): JudgeCallResult {
	return {
		criteria: [],
		rawResponse: "",
		success: false,
		error,
	};
}

// --- Tests ---

describe("applyMajorityVote", () => {
	test("case 1: unanimous PASS — 3 runs all return PASS for a criterion", () => {
		const rawResponses: JudgeCallResult[] = [
			makeSuccessfulRun({
				criterion_a: "PASS",
				criterion_b: "PASS",
				criterion_c: "PASS",
			}),
			makeSuccessfulRun({
				criterion_a: "PASS",
				criterion_b: "PASS",
				criterion_c: "PASS",
			}),
			makeSuccessfulRun({
				criterion_a: "PASS",
				criterion_b: "PASS",
				criterion_c: "PASS",
			}),
		];

		const results = applyMajorityVote(mockTask, rawResponses);

		expect(results).toHaveLength(3);
		const criterionA = results.find((r) => r.name === "criterion_a");
		expect(criterionA?.verdict).toBe("PASS");
		expect(criterionA?.evidence).toBeTruthy();
		expect(criterionA?.reasoning).toContain("PASS");
	});

	test("case 2: majority PASS — 2 PASS + 1 FAIL gives PASS verdict", () => {
		const rawResponses: JudgeCallResult[] = [
			makeSuccessfulRun({
				criterion_a: "PASS",
				criterion_b: "PASS",
				criterion_c: "FAIL",
			}),
			makeSuccessfulRun({
				criterion_a: "PASS",
				criterion_b: "FAIL",
				criterion_c: "FAIL",
			}),
			makeSuccessfulRun({
				criterion_a: "FAIL",
				criterion_b: "PASS",
				criterion_c: "PASS",
			}),
		];

		const results = applyMajorityVote(mockTask, rawResponses);

		// criterion_a: 2 PASS, 1 FAIL -> PASS
		const criterionA = results.find((r) => r.name === "criterion_a");
		expect(criterionA?.verdict).toBe("PASS");
		// Evidence should come from a PASS run
		expect(criterionA?.evidence).toContain("Evidence for criterion_a");
		expect(criterionA?.reasoning).toContain("PASS");

		// criterion_b: 2 PASS, 1 FAIL -> PASS
		const criterionB = results.find((r) => r.name === "criterion_b");
		expect(criterionB?.verdict).toBe("PASS");
	});

	test("case 3: majority FAIL — 1 PASS + 2 FAIL gives FAIL verdict", () => {
		const rawResponses: JudgeCallResult[] = [
			makeSuccessfulRun({
				criterion_a: "PASS",
				criterion_b: "FAIL",
				criterion_c: "FAIL",
			}),
			makeSuccessfulRun({
				criterion_a: "FAIL",
				criterion_b: "FAIL",
				criterion_c: "PASS",
			}),
			makeSuccessfulRun({
				criterion_a: "FAIL",
				criterion_b: "PASS",
				criterion_c: "FAIL",
			}),
		];

		const results = applyMajorityVote(mockTask, rawResponses);

		// criterion_a: 1 PASS, 2 FAIL -> FAIL
		const criterionA = results.find((r) => r.name === "criterion_a");
		expect(criterionA?.verdict).toBe("FAIL");

		// criterion_c: 1 PASS, 2 FAIL -> FAIL
		const criterionC = results.find((r) => r.name === "criterion_c");
		expect(criterionC?.verdict).toBe("FAIL");
	});

	test("preserves criterion weights from task rubric", () => {
		const rawResponses: JudgeCallResult[] = [
			makeSuccessfulRun({
				criterion_a: "PASS",
				criterion_b: "PASS",
				criterion_c: "PASS",
			}),
			makeSuccessfulRun({
				criterion_a: "PASS",
				criterion_b: "PASS",
				criterion_c: "PASS",
			}),
			makeSuccessfulRun({
				criterion_a: "PASS",
				criterion_b: "PASS",
				criterion_c: "PASS",
			}),
		];

		const results = applyMajorityVote(mockTask, rawResponses);

		expect(results.find((r) => r.name === "criterion_a")?.weight).toBe(0.3);
		expect(results.find((r) => r.name === "criterion_b")?.weight).toBe(0.3);
		expect(results.find((r) => r.name === "criterion_c")?.weight).toBe(0.4);
	});

	test("handles failed runs: counts as FAIL for all criteria", () => {
		const rawResponses: JudgeCallResult[] = [
			makeSuccessfulRun({
				criterion_a: "PASS",
				criterion_b: "PASS",
				criterion_c: "PASS",
			}),
			makeFailedRun("API error"),
			makeSuccessfulRun({
				criterion_a: "PASS",
				criterion_b: "FAIL",
				criterion_c: "PASS",
			}),
		];

		const results = applyMajorityVote(mockTask, rawResponses);

		// criterion_a: 2 PASS + 1 FAIL (from failed run) -> PASS (2/3 majority)
		expect(results.find((r) => r.name === "criterion_a")?.verdict).toBe("PASS");

		// criterion_b: 1 PASS + 1 FAIL (real) + 1 FAIL (from failed run) -> FAIL (2/3 majority)
		expect(results.find((r) => r.name === "criterion_b")?.verdict).toBe("FAIL");
	});

	test("handles missing criterion in a run response", () => {
		// Response missing criterion_b
		const partialRun: JudgeCallResult = {
			criteria: [
				{
					criterion: "criterion_a",
					verdict: "PASS",
					evidence: "ev",
					reasoning: "rs",
				},
				// criterion_b missing
				{
					criterion: "criterion_c",
					verdict: "PASS",
					evidence: "ev",
					reasoning: "rs",
				},
			],
			rawResponse: "[]",
			success: true,
		};

		const rawResponses: JudgeCallResult[] = [
			partialRun,
			makeSuccessfulRun({
				criterion_a: "PASS",
				criterion_b: "PASS",
				criterion_c: "PASS",
			}),
			makeSuccessfulRun({
				criterion_a: "PASS",
				criterion_b: "PASS",
				criterion_c: "PASS",
			}),
		];

		const results = applyMajorityVote(mockTask, rawResponses);

		// criterion_b: 2 PASS + 1 FAIL (from missing) -> PASS (2/3 majority)
		expect(results.find((r) => r.name === "criterion_b")?.verdict).toBe("PASS");
	});

	test("all 3 runs failed: all criteria FAIL", () => {
		const rawResponses: JudgeCallResult[] = [
			makeFailedRun("Error 1"),
			makeFailedRun("Error 2"),
			makeFailedRun("Error 3"),
		];

		const results = applyMajorityVote(mockTask, rawResponses);

		for (const criterion of results) {
			expect(criterion.verdict).toBe("FAIL");
		}
	});
});

describe("calculateJudgeScore", () => {
	test("case 4: score calculation — 3 criteria, two pass, one fails", () => {
		// Criteria: A (30%), B (30%), C (40%)
		// A and B pass, C fails -> score = 0.6 / 1.0 = 0.6
		const criteria: CriterionResult[] = [
			{
				name: "criterion_a",
				verdict: "PASS",
				weight: 0.3,
				evidence: "",
				reasoning: "",
			},
			{
				name: "criterion_b",
				verdict: "PASS",
				weight: 0.3,
				evidence: "",
				reasoning: "",
			},
			{
				name: "criterion_c",
				verdict: "FAIL",
				weight: 0.4,
				evidence: "",
				reasoning: "",
			},
		];

		const score = calculateJudgeScore(criteria);
		expect(score).toBeCloseTo(0.6);
	});

	test("all criteria pass: score = 1.0", () => {
		const criteria: CriterionResult[] = [
			{
				name: "a",
				verdict: "PASS",
				weight: 0.5,
				evidence: "",
				reasoning: "",
			},
			{
				name: "b",
				verdict: "PASS",
				weight: 0.5,
				evidence: "",
				reasoning: "",
			},
		];

		expect(calculateJudgeScore(criteria)).toBe(1.0);
	});

	test("all criteria fail: score = 0.0", () => {
		const criteria: CriterionResult[] = [
			{
				name: "a",
				verdict: "FAIL",
				weight: 0.5,
				evidence: "",
				reasoning: "",
			},
			{
				name: "b",
				verdict: "FAIL",
				weight: 0.5,
				evidence: "",
				reasoning: "",
			},
		];

		expect(calculateJudgeScore(criteria)).toBe(0.0);
	});

	test("empty criteria array: score = 0", () => {
		expect(calculateJudgeScore([])).toBe(0);
	});

	test("uneven weights: score is weighted correctly", () => {
		// 10% pass, 90% fail -> score = 0.1
		const criteria: CriterionResult[] = [
			{
				name: "minor",
				verdict: "PASS",
				weight: 0.1,
				evidence: "",
				reasoning: "",
			},
			{
				name: "major",
				verdict: "FAIL",
				weight: 0.9,
				evidence: "",
				reasoning: "",
			},
		];

		expect(calculateJudgeScore(criteria)).toBeCloseTo(0.1);
	});
});

describe("parseJudgeResponse", () => {
	test("case 5: parses valid JSON array response", () => {
		const rawResponse = JSON.stringify([
			{
				criterion: "proxy_filename",
				verdict: "PASS",
				evidence: "File is proxy.ts",
				reasoning: "Correctly named",
			},
			{
				criterion: "no_edge_runtime",
				verdict: "FAIL",
				evidence: "runtime: edge found",
				reasoning: "Should not have edge runtime",
			},
		]);

		const result = parseJudgeResponse(rawResponse);
		expect(result.success).toBe(true);
		expect(result.criteria).toHaveLength(2);
		expect(result.criteria[0]?.criterion).toBe("proxy_filename");
		expect(result.criteria[0]?.verdict).toBe("PASS");
		expect(result.criteria[1]?.criterion).toBe("no_edge_runtime");
		expect(result.criteria[1]?.verdict).toBe("FAIL");
	});

	test("handles JSON array embedded in surrounding text", () => {
		const rawResponse = `Here are my evaluations:
[
  {
    "criterion": "proxy_filename",
    "verdict": "PASS",
    "evidence": "File is proxy.ts",
    "reasoning": "Correct"
  }
]
That's my assessment.`;

		const result = parseJudgeResponse(rawResponse);
		expect(result.success).toBe(true);
		expect(result.criteria).toHaveLength(1);
		expect(result.criteria[0]?.criterion).toBe("proxy_filename");
	});

	test("case 5 (JSON parse error handling): invalid JSON returns error", () => {
		const rawResponse = "This is not JSON at all";
		const result = parseJudgeResponse(rawResponse);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Failed to parse JSON");
		expect(result.criteria).toHaveLength(0);
	});

	test("handles single criterion object (not array)", () => {
		const rawResponse = JSON.stringify({
			criterion: "proxy_filename",
			verdict: "PASS",
			evidence: "Correct",
			reasoning: "Correct",
		});

		const result = parseJudgeResponse(rawResponse);
		expect(result.success).toBe(true);
		expect(result.criteria).toHaveLength(1);
		expect(result.criteria[0]?.criterion).toBe("proxy_filename");
	});

	test("normalizes invalid verdict to FAIL", () => {
		const rawResponse = JSON.stringify([
			{
				criterion: "test",
				verdict: "MAYBE",
				evidence: "",
				reasoning: "",
			},
		]);

		const result = parseJudgeResponse(rawResponse);
		expect(result.success).toBe(true);
		expect(result.criteria[0]?.verdict).toBe("FAIL");
	});

	test("handles empty array", () => {
		const rawResponse = "[]";
		const result = parseJudgeResponse(rawResponse);
		expect(result.success).toBe(false);
		expect(result.error).toContain("No valid criteria");
	});

	test("handles missing fields gracefully", () => {
		const rawResponse = JSON.stringify([
			{
				criterion: "test",
				// missing verdict, evidence, reasoning
			},
		]);

		const result = parseJudgeResponse(rawResponse);
		expect(result.success).toBe(true);
		expect(result.criteria[0]?.criterion).toBe("test");
		expect(result.criteria[0]?.verdict).toBe("FAIL"); // defaults to FAIL
		expect(result.criteria[0]?.evidence).toBe("");
		expect(result.criteria[0]?.reasoning).toBe("");
	});
});

describe("integration: majority vote + score calculation", () => {
	test("full workflow: 3 runs with mixed verdicts produce correct final score", () => {
		// criterion_a (30%): 2 PASS, 1 FAIL -> PASS
		// criterion_b (30%): 1 PASS, 2 FAIL -> FAIL
		// criterion_c (40%): 3 PASS, 0 FAIL -> PASS
		// Expected score: (0.3 + 0.4) / 1.0 = 0.7
		const rawResponses: JudgeCallResult[] = [
			makeSuccessfulRun({
				criterion_a: "PASS",
				criterion_b: "PASS",
				criterion_c: "PASS",
			}),
			makeSuccessfulRun({
				criterion_a: "PASS",
				criterion_b: "FAIL",
				criterion_c: "PASS",
			}),
			makeSuccessfulRun({
				criterion_a: "FAIL",
				criterion_b: "FAIL",
				criterion_c: "PASS",
			}),
		];

		const criteria = applyMajorityVote(mockTask, rawResponses);
		const score = calculateJudgeScore(criteria);

		expect(criteria.find((c) => c.name === "criterion_a")?.verdict).toBe(
			"PASS",
		);
		expect(criteria.find((c) => c.name === "criterion_b")?.verdict).toBe(
			"FAIL",
		);
		expect(criteria.find((c) => c.name === "criterion_c")?.verdict).toBe(
			"PASS",
		);
		expect(score).toBeCloseTo(0.7);
	});

	test("all runs fail: score is 0.0", () => {
		const rawResponses: JudgeCallResult[] = [
			makeFailedRun("Error 1"),
			makeFailedRun("Error 2"),
			makeFailedRun("Error 3"),
		];

		const criteria = applyMajorityVote(mockTask, rawResponses);
		const score = calculateJudgeScore(criteria);

		expect(score).toBe(0.0);
		for (const c of criteria) {
			expect(c.verdict).toBe("FAIL");
		}
	});

	test("single run (runs=1): no voting needed", () => {
		const rawResponses: JudgeCallResult[] = [
			makeSuccessfulRun({
				criterion_a: "PASS",
				criterion_b: "FAIL",
				criterion_c: "PASS",
			}),
		];

		const criteria = applyMajorityVote(mockTask, rawResponses);
		const score = calculateJudgeScore(criteria);

		expect(criteria.find((c) => c.name === "criterion_a")?.verdict).toBe(
			"PASS",
		);
		expect(criteria.find((c) => c.name === "criterion_b")?.verdict).toBe(
			"FAIL",
		);
		expect(criteria.find((c) => c.name === "criterion_c")?.verdict).toBe(
			"PASS",
		);
		// (0.3 + 0.4) / 1.0 = 0.7
		expect(score).toBeCloseTo(0.7);
	});
});
