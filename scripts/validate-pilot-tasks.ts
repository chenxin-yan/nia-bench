/**
 * Quick validation script to verify all 5 pilot task JSON files
 * load correctly via the task loader.
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

	// Expected 5 pilot tasks
	const expectedIds = [
		"nextjs-16-proxy-ts",
		"react-19-use-hook",
		"nextjs-13-sync-request-apis",
		"react-17-render-entry",
		"react-17-audit-v19-code",
	];

	console.log("\nVerifying all 5 pilot tasks are present:");
	for (const id of expectedIds) {
		const task = result.tasks.find((t) => t.id === id);
		if (task) {
			console.log(
				`  ✓ ${id} (${task.category}, ${task.library} v${task.target_version})`,
			);
			console.log(`    AST checks: ${task.test_spec.ast_checks.length}`);
			console.log(`    Rubric criteria: ${task.rubric.criteria.length}`);
			const totalWeight = task.rubric.criteria.reduce(
				(sum, c) => sum + c.weight,
				0,
			);
			console.log(`    Rubric weight sum: ${totalWeight.toFixed(2)}`);
		} else {
			console.error(`  ✗ ${id} — NOT FOUND!`);
			process.exit(1);
		}
	}

	console.log(
		`\nAll ${expectedIds.length} pilot tasks validated successfully!`,
	);
}

main().catch((err) => {
	console.error("Validation failed:", err);
	process.exit(1);
});
