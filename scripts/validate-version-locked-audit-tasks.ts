/**
 * Validation script to verify all 9 version-locked audit task JSON files
 * load correctly and meet structural requirements.
 *
 * Audit tasks have:
 * - test_spec.ast_checks = [] (empty array — no AST checks, 100% judge evaluation)
 * - Non-empty rubric criteria
 * - Rubric criteria weights summing to approximately 1.0
 * - context.package_json with pinned library versions
 */

import { join } from "node:path";
import { loadTasks } from "../src/loader";

const tasksDir = join(import.meta.dir, "..", "tasks");

async function main() {
	console.log("Loading all tasks from:", tasksDir);
	const result = await loadTasks(tasksDir);

	console.log(`\nLoaded ${result.tasks.length} tasks successfully.`);
	if (result.errors.length > 0) {
		console.error(`\n${result.errors.length} errors found:`);
		for (const err of result.errors) {
			console.error(`  - ${err.filePath}: ${err.error}`);
		}
		process.exit(1);
	}

	// Filter to version_locked_audit only
	const auditTasks = result.tasks.filter(
		(t) => t.category === "version_locked_audit",
	);
	console.log(`\nVersion-locked audit tasks: ${auditTasks.length}`);

	// Expected 9 audit tasks (1 pilot + 8 new)
	const expectedIds = [
		"react-17-audit-v19-code",
		"nextjs-13-audit-v16-code",
		"nextjs-16-audit-v15-code",
		"nextjs-16-audit-parallel-routes",
		"react-19-audit-removed-apis",
		"react-18-audit-missed-features",
		"zod-4-audit-v3-code",
		"trpc-11-audit-v10-code",
		"ai-sdk-4-audit-v3-code",
	];

	if (auditTasks.length !== expectedIds.length) {
		console.error(
			`\nExpected ${expectedIds.length} audit tasks, found ${auditTasks.length}`,
		);
		const foundIds = auditTasks.map((t) => t.id);
		const missing = expectedIds.filter((id) => !foundIds.includes(id));
		const extra = foundIds.filter((id) => !expectedIds.includes(id));
		if (missing.length > 0) console.error(`  Missing: ${missing.join(", ")}`);
		if (extra.length > 0) console.error(`  Extra: ${extra.join(", ")}`);
		process.exit(1);
	}

	console.log("\nVerifying all 9 version-locked audit tasks:");
	let allPassed = true;

	for (const id of expectedIds) {
		const task = auditTasks.find((t) => t.id === id);
		if (!task) {
			console.error(`  ✗ ${id} — NOT FOUND!`);
			allPassed = false;
			continue;
		}

		console.log(`  ✓ ${id} (${task.library} v${task.target_version})`);

		// Verify ast_checks is empty
		if (task.test_spec.ast_checks.length !== 0) {
			console.error(
				`    ✗ ast_checks should be empty for audit tasks, found ${task.test_spec.ast_checks.length} checks`,
			);
			allPassed = false;
		} else {
			console.log(`    AST checks: [] (correct — audit task)`);
		}

		// Verify rubric criteria is non-empty
		if (task.rubric.criteria.length === 0) {
			console.error(
				`    ✗ Rubric criteria should be non-empty for audit tasks (100% judge evaluation)`,
			);
			allPassed = false;
		} else {
			console.log(`    Rubric criteria: ${task.rubric.criteria.length}`);
		}

		// Verify rubric weights sum to approximately 1.0
		const totalWeight = task.rubric.criteria.reduce(
			(sum, c) => sum + c.weight,
			0,
		);
		console.log(`    Rubric weight sum: ${totalWeight.toFixed(2)}`);
		if (Math.abs(totalWeight - 1.0) > 0.01) {
			console.error(
				`    ✗ Weight sum is ${totalWeight.toFixed(4)}, expected ~1.0!`,
			);
			allPassed = false;
		}

		// Verify reference_solution is non-empty
		if (
			!task.reference_solution ||
			task.reference_solution.trim().length === 0
		) {
			console.error(`    ✗ reference_solution should be non-empty`);
			allPassed = false;
		} else {
			console.log(
				`    Reference solution: ${task.reference_solution.length} chars`,
			);
		}

		// Verify common_hallucinations is non-empty
		if (
			!task.common_hallucinations ||
			task.common_hallucinations.length === 0
		) {
			console.error(`    ✗ common_hallucinations should be non-empty`);
			allPassed = false;
		} else {
			console.log(
				`    Common hallucinations: ${task.common_hallucinations.length}`,
			);
		}

		// Verify context.package_json is present
		if (!task.context?.package_json) {
			console.error(
				`    ✗ context.package_json should be present for version-locked tasks`,
			);
			allPassed = false;
		} else {
			console.log(`    Context: package_json present`);
		}

		// Verify prompt is non-empty and contains code to audit
		if (!task.prompt || task.prompt.trim().length === 0) {
			console.error(`    ✗ prompt should be non-empty`);
			allPassed = false;
		} else {
			console.log(`    Prompt: ${task.prompt.length} chars`);
		}
	}

	// Summary by library
	console.log("\n--- Summary by Library ---");
	const libraries = [...new Set(auditTasks.map((t) => t.library))];
	for (const lib of libraries) {
		const libTasks = auditTasks.filter((t) => t.library === lib);
		console.log(
			`  ${lib}: ${libTasks.length} tasks (${libTasks.map((t) => t.id).join(", ")})`,
		);
	}

	if (allPassed) {
		console.log(
			`\n✓ All ${expectedIds.length} version-locked audit tasks validated successfully!`,
		);
		console.log("  - All tasks load from JSON");
		console.log(
			"  - All tasks have empty ast_checks (correct for audit tasks)",
		);
		console.log("  - All tasks have non-empty rubric criteria");
		console.log("  - All rubric weights sum to 1.0");
		console.log("  - All tasks have non-empty reference solutions");
		console.log("  - All tasks have context.package_json");
	} else {
		console.error("\n✗ Some validations FAILED! See errors above.");
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("Validation failed:", err);
	process.exit(1);
});
