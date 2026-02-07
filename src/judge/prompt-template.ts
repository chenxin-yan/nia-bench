import type { VersionApiSurface } from '@/types/reference';
import type { Task } from '@/types/task';

/**
 * Builds the LLM judge prompt from the task, generated code, and reference documentation.
 * Follows the template defined in BENCHMARK.md Section 5.2.
 */
export function buildJudgePrompt(
  task: Task,
  generatedCode: string,
  referenceDoc: VersionApiSurface | null,
): string {
  const referenceDocSection = referenceDoc
    ? formatReferenceDoc(referenceDoc)
    : 'No reference documentation available for this library version.';

  const rubricCriteriaSection = task.rubric.criteria
    .map((c) => `- **${c.name}** (weight: ${(c.weight * 100).toFixed(0)}%): ${c.description}`)
    .join('\n');

  const hallucinationsSection = task.common_hallucinations.map((h) => `- ${h}`).join('\n');

  return `You are a code correctness evaluator. Judge ONLY based on the reference documentation and reference solution provided below. Do NOT use your own knowledge of the library.

## Task
${task.prompt}

## Target Library Version
${task.library} v${task.target_version}

## Reference Documentation (ground truth)
${referenceDocSection}

## Reference Solution
${task.reference_solution}

## Generated Code (to evaluate)
${generatedCode}

## Rubric Criteria
${rubricCriteriaSection}

## Known Hallucination Patterns (watch for these)
${hallucinationsSection}

For EACH criterion, respond with a JSON array where each element has this structure:
{
  "criterion": "<name>",
  "verdict": "PASS" or "FAIL",
  "evidence": "<exact line(s) from generated code>",
  "reasoning": "<1-2 sentences>"
}

Respond ONLY with a valid JSON array. Do not include any text before or after the JSON array.

IMPORTANT: A method is "correct" ONLY if it appears in the reference documentation above. If you cannot find it in the docs, mark as FAIL even if you believe it exists from your own knowledge.`;
}

/**
 * Formats a VersionApiSurface reference document into a human-readable string
 * suitable for inclusion in the judge prompt.
 */
function formatReferenceDoc(ref: VersionApiSurface): string {
  const sections: string[] = [];

  sections.push(`### ${ref.library} v${ref.version} API Surface`);

  if (ref.sync_apis.length > 0) {
    sections.push(`**Synchronous APIs:** ${ref.sync_apis.join(', ')}`);
  }

  if (ref.async_apis.length > 0) {
    sections.push(`**Async APIs (require await):** ${ref.async_apis.join(', ')}`);
  }

  if (ref.params_type && ref.params_type !== 'n/a') {
    sections.push(`**Params type:** ${ref.params_type}`);
  }

  if (ref.proxy_file) {
    sections.push(`**Proxy/Middleware file:** ${ref.proxy_file}`);
  }

  if (ref.proxy_function) {
    sections.push(`**Proxy/Middleware function:** ${ref.proxy_function}`);
  }

  if (Object.keys(ref.available_imports).length > 0) {
    const importLines = Object.entries(ref.available_imports)
      .map(([path, exports]) => `  - \`${path}\`: ${exports.join(', ')}`)
      .join('\n');
    sections.push(`**Available Imports:**\n${importLines}`);
  }

  if (ref.unavailable_apis.length > 0) {
    sections.push(
      `**Unavailable APIs (NOT in this version):**\n${ref.unavailable_apis.map((a) => `  - ${a}`).join('\n')}`,
    );
  }

  if (ref.removed_from_previous.length > 0) {
    sections.push(
      `**Removed from previous version:**\n${ref.removed_from_previous.map((a) => `  - ${a}`).join('\n')}`,
    );
  }

  if (ref.available_hooks.length > 0) {
    sections.push(`**Available Hooks:** ${ref.available_hooks.join(', ')}`);
  }

  if (ref.unavailable_hooks.length > 0) {
    sections.push(`**Unavailable Hooks:** ${ref.unavailable_hooks.join(', ')}`);
  }

  if (ref.available_types.length > 0) {
    sections.push(`**Available Types:** ${ref.available_types.join(', ')}`);
  }

  if (ref.unavailable_types.length > 0) {
    sections.push(`**Unavailable Types:** ${ref.unavailable_types.join(', ')}`);
  }

  if (ref.rendering) {
    sections.push(
      `**Rendering:** Entry API: \`${ref.rendering.entry_api}\`, import from \`${ref.rendering.import_path}\``,
    );
    if (ref.rendering.deprecated.length > 0) {
      sections.push(`  Deprecated: ${ref.rendering.deprecated.join(', ')}`);
    }
  }

  if (ref.key_features.length > 0) {
    sections.push(`**Key Features:**\n${ref.key_features.map((f) => `  - ${f}`).join('\n')}`);
  }

  if (ref.breaking_changes.length > 0) {
    sections.push(
      `**Breaking Changes:**\n${ref.breaking_changes.map((c) => `  - ${c}`).join('\n')}`,
    );
  }

  if (ref.notes.length > 0) {
    sections.push(`**Notes:**\n${ref.notes.map((n) => `  - ${n}`).join('\n')}`);
  }

  return sections.join('\n\n');
}
