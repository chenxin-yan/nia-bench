/**
 * Validation script to verify all 13 bleeding-edge task JSON files
 * load correctly and their reference solutions pass all AST checks.
 */

import { join } from "node:path";
import { loadTasks } from "../src/loader";
import { runAstChecks } from "../src/tests/ast-checker";

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

	// Filter to bleeding_edge only
	const bleedingEdge = result.tasks.filter(
		(t) => t.category === "bleeding_edge",
	);
	console.log(`\nBleeding-edge tasks: ${bleedingEdge.length}`);

	// Expected 13 bleeding-edge tasks
	const expectedIds = [
		"nextjs-16-proxy-ts",
		"nextjs-16-enforced-async",
		"nextjs-16-cache-components",
		"react-19-use-hook",
		"react-19-form-actions",
		"react-19-ref-as-prop",
		"ai-sdk-6-output-api",
		"ai-sdk-6-tool-loop-agent",
		"trpc-11-transformer-link",
		"trpc-11-sse-subscriptions",
		"trpc-11-shorthand-streaming",
		"zod-4-top-level-validators",
		"zod-4-error-api",
	];

	if (bleedingEdge.length !== expectedIds.length) {
		console.error(
			`\nExpected ${expectedIds.length} bleeding-edge tasks, found ${bleedingEdge.length}`,
		);
		process.exit(1);
	}

	console.log("\nVerifying all 13 bleeding-edge tasks:");
	let allPassed = true;

	for (const id of expectedIds) {
		const task = bleedingEdge.find((t) => t.id === id);
		if (!task) {
			console.error(`  ✗ ${id} — NOT FOUND!`);
			allPassed = false;
			continue;
		}

		console.log(`  ✓ ${id} (${task.library} v${task.target_version})`);
		console.log(`    AST checks: ${task.test_spec.ast_checks.length}`);
		const totalWeight = task.rubric.criteria.reduce(
			(sum, c) => sum + c.weight,
			0,
		);
		console.log(`    Rubric weight sum: ${totalWeight.toFixed(2)}`);
		if (Math.abs(totalWeight - 1.0) > 0.01) {
			console.error(`    ⚠ Weight sum is not 1.0!`);
			allPassed = false;
		}

		// Run AST checks on reference solution (only for non-multi-file tasks with AST checks)
		if (task.test_spec.ast_checks.length > 0) {
			// For multi-file tasks, we need to check each file separately
			const hasFileSpecificChecks = task.test_spec.ast_checks.some(
				(c) => "file" in c && c.file,
			);

			if (hasFileSpecificChecks) {
				// Parse reference solution into files
				const files = parseMultiFileReference(task.reference_solution);
				console.log(`    Multi-file: ${Object.keys(files).join(", ")}`);

				for (const check of task.test_spec.ast_checks) {
					const fileHint = "file" in check ? check.file : undefined;
					if (fileHint) {
						// Find matching file
						const matchingFile = Object.entries(files).find(
							([name]) =>
								name.endsWith(fileHint) ||
								fileHint.endsWith(name) ||
								name.includes(fileHint),
						);
						if (matchingFile) {
							const results = runAstChecks(matchingFile[1], [check]);
							if (!results[0]?.passed) {
								console.error(
									`    ✗ AST check FAILED on ${matchingFile[0]}: ${results[0]?.message}`,
								);
								console.error(`      Check: ${JSON.stringify(check)}`);
								allPassed = false;
							}
						} else {
							console.warn(
								`    ⚠ No file matching "${fileHint}" found in reference solution`,
							);
						}
					}
				}

				// Run non-file-specific checks against concatenated code
				const nonFileChecks = task.test_spec.ast_checks.filter(
					(c) => !("file" in c && c.file),
				);
				if (nonFileChecks.length > 0) {
					const fullCode = Object.values(files).join("\n\n");
					const results = runAstChecks(fullCode, nonFileChecks);
					for (const r of results) {
						if (!r.passed) {
							console.error(`    ✗ AST check FAILED (no file): ${r.message}`);
							console.error(`      Check: ${JSON.stringify(r.check)}`);
							allPassed = false;
						}
					}
				}
			} else {
				// Single file - run all checks against the full reference solution
				const results = runAstChecks(
					task.reference_solution,
					task.test_spec.ast_checks,
				);
				const passed = results.filter((r) => r.passed).length;
				const total = results.length;
				console.log(`    AST results: ${passed}/${total} passed`);
				for (const r of results) {
					if (!r.passed) {
						console.error(`    ✗ FAILED: ${r.message}`);
						console.error(`      Check: ${JSON.stringify(r.check)}`);
						allPassed = false;
					}
				}
			}
		}
	}

	if (allPassed) {
		console.log(
			`\n✓ All ${expectedIds.length} bleeding-edge tasks validated successfully!`,
		);
		console.log("  - All tasks load from JSON");
		console.log("  - All rubric weights sum to 1.0");
		console.log("  - All reference solutions pass their AST checks");
	} else {
		console.error("\n✗ Some validations FAILED! See errors above.");
		process.exit(1);
	}
}

function parseMultiFileReference(solution: string): Record<string, string> {
	const files: Record<string, string> = {};
	// Split on file comment markers like "// app/dashboard/[id]/page.tsx" or "// actions.ts"
	const filePattern = /\/\/\s*([\w@/.[\]-]+\.[jt]sx?)\s*\n/g;
	let match: RegExpExecArray | null;
	const markers: { name: string; index: number }[] = [];

	// biome-ignore lint/suspicious/noAssignInExpressions: intentional regex exec loop
	while ((match = filePattern.exec(solution)) !== null) {
		markers.push({ name: match[1], index: match.index });
	}

	if (markers.length === 0) {
		// No file markers found, treat as single file
		files["main.ts"] = solution;
		return files;
	}

	for (let i = 0; i < markers.length; i++) {
		const start =
			markers[i].index + solution.substring(markers[i].index).indexOf("\n") + 1;
		const end = i + 1 < markers.length ? markers[i + 1].index : solution.length;
		files[markers[i].name] = solution.substring(start, end).trim();
	}

	return files;
}

main().catch((err) => {
	console.error("Validation failed:", err);
	process.exit(1);
});
