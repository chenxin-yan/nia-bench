/**
 * Validation script to verify all 14 version-locked-write task JSON files
 * load correctly and their reference solutions pass all AST checks.
 */
import { loadTasks } from '../src/loader';
import { runAstChecks } from '../src/tests/ast-checker';
import { join } from 'node:path';

const tasksDir = join(import.meta.dir, '..', 'tasks');

async function main() {
  console.log('Loading all tasks from:', tasksDir);
  const result = await loadTasks(tasksDir);

  console.log(`\nLoaded ${result.tasks.length} tasks successfully.`);
  if (result.errors.length > 0) {
    console.error(`\n${result.errors.length} errors found:`);
    for (const err of result.errors) {
      console.error(`  - ${err.filePath}: ${err.error}`);
    }
    process.exit(1);
  }

  // Filter to version_locked_write only
  const versionLockedWrite = result.tasks.filter((t) => t.category === 'version_locked_write');
  console.log(`\nVersion-locked-write tasks: ${versionLockedWrite.length}`);

  // Expected 14 version-locked-write tasks
  const expectedIds = [
    'nextjs-13-sync-request-apis',
    'nextjs-14-direct-params',
    'nextjs-15-middleware-ts',
    'react-17-data-fetching',
    'react-17-render-entry',
    'react-18-forward-ref',
    'ai-sdk-3-async-stream',
    'ai-sdk-3-type-names',
    'trpc-10-client-transformer',
    'trpc-10-middleware-raw-input',
    'trpc-10-ssg-helpers',
    'zod-3-chained-validators',
    'zod-3-error-message',
    'zod-3-record-single-arg',
  ];

  if (versionLockedWrite.length !== expectedIds.length) {
    console.error(
      `\nExpected ${expectedIds.length} version-locked-write tasks, found ${versionLockedWrite.length}`,
    );
    const foundIds = versionLockedWrite.map((t) => t.id);
    const missing = expectedIds.filter((id) => !foundIds.includes(id));
    const extra = foundIds.filter((id) => !expectedIds.includes(id));
    if (missing.length > 0) console.error('  Missing:', missing);
    if (extra.length > 0) console.error('  Extra:', extra);
    process.exit(1);
  }

  console.log('\nVerifying all 14 version-locked-write tasks:');
  let allPassed = true;

  for (const id of expectedIds) {
    const task = versionLockedWrite.find((t) => t.id === id);
    if (!task) {
      console.error(`  ✗ ${id} — NOT FOUND!`);
      allPassed = false;
      continue;
    }

    console.log(`  ✓ ${id} (${task.library} v${task.target_version})`);
    console.log(`    AST checks: ${task.test_spec.ast_checks.length}`);
    const totalWeight = task.rubric.criteria.reduce((sum, c) => sum + c.weight, 0);
    console.log(`    Rubric weight sum: ${totalWeight.toFixed(2)}`);
    if (Math.abs(totalWeight - 1.0) > 0.01) {
      console.error(`    ⚠ Weight sum is not 1.0!`);
      allPassed = false;
    }

    // Verify context is present for version-locked tasks
    if (!task.context?.package_json) {
      console.error(`    ⚠ Missing context.package_json for version-locked task!`);
      allPassed = false;
    }

    // Run AST checks on reference solution
    if (task.test_spec.ast_checks.length > 0) {
      const hasFileSpecificChecks = task.test_spec.ast_checks.some((c: any) => c.file);

      if (hasFileSpecificChecks) {
        // Parse reference solution into files
        const files = parseMultiFileReference(task.reference_solution);
        console.log(`    Multi-file: ${Object.keys(files).join(', ')}`);

        for (const check of task.test_spec.ast_checks) {
          const fileHint = (check as any).file;
          if (fileHint) {
            const matchingFile = Object.entries(files).find(
              ([name]) =>
                name.endsWith(fileHint) || fileHint.endsWith(name) || name.includes(fileHint),
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
              console.warn(`    ⚠ No file matching "${fileHint}" found in reference solution`);
            }
          }
        }

        // Run non-file-specific checks against concatenated code
        const nonFileChecks = task.test_spec.ast_checks.filter((c: any) => !c.file);
        if (nonFileChecks.length > 0) {
          const fullCode = Object.values(files).join('\n\n');
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
        const results = runAstChecks(task.reference_solution, task.test_spec.ast_checks);
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
    console.log(`\n✓ All ${expectedIds.length} version-locked-write tasks validated successfully!`);
    console.log('  - All tasks load from JSON');
    console.log('  - All rubric weights sum to 1.0');
    console.log('  - All tasks have context.package_json');
    console.log('  - All reference solutions pass their AST checks');
  } else {
    console.error('\n✗ Some validations FAILED! See errors above.');
    process.exit(1);
  }
}

function parseMultiFileReference(solution: string): Record<string, string> {
  const files: Record<string, string> = {};
  const filePattern = /\/\/\s*([\w@/.[\]-]+\.[jt]sx?)\s*\n/g;
  let match: RegExpExecArray | null;
  const markers: { name: string; index: number }[] = [];

  // biome-ignore lint/suspicious/noAssignInExpressions: intentional regex exec loop
  while ((match = filePattern.exec(solution)) !== null) {
    markers.push({ name: match[1], index: match.index });
  }

  if (markers.length === 0) {
    files['main.ts'] = solution;
    return files;
  }

  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].index + solution.substring(markers[i].index).indexOf('\n') + 1;
    const end = i + 1 < markers.length ? markers[i + 1].index : solution.length;
    files[markers[i].name] = solution.substring(start, end).trim();
  }

  return files;
}

main().catch((err) => {
  console.error('Validation failed:', err);
  process.exit(1);
});
