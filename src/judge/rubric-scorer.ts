import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { VersionApiSurface } from '@/types/reference';
import { VersionApiSurfaceSchema } from '@/types/reference';
import type { Task } from '@/types/task';
import type { JudgeCallResult, JudgeClientConfig } from './openrouter-client';
import { callJudge } from './openrouter-client';
import { buildJudgePrompt } from './prompt-template';

// --- Types ---

/** Result for a single rubric criterion after majority voting */
export interface CriterionResult {
  name: string;
  verdict: 'PASS' | 'FAIL';
  weight: number;
  evidence: string;
  reasoning: string;
}

/** Full result from the rubric evaluation (3x majority vote) */
export interface JudgeResult {
  criteria: CriterionResult[];
  judgeScore: number;
  rawResponses: JudgeCallResult[];
}

/** Configuration for scoring */
export interface ScorerConfig {
  /** Number of judge runs for majority vote. Defaults to 3. */
  runs?: number;
  /** OpenRouter client configuration */
  clientConfig?: JudgeClientConfig;
  /** Base directory for reference files. Defaults to <projectRoot>/reference */
  referenceDir?: string;
  /** Project root directory */
  projectRoot?: string;
}

// --- Library directory mapping ---

const LIBRARY_DIR_MAP: Record<string, string> = {
  next: 'next',
  react: 'react',
  ai: 'ai-sdk',
  trpc: 'trpc',
  zod: 'zod',
};

// --- Reference loading ---

/**
 * Loads the version API surface reference file for a given task.
 * Returns null if the reference file doesn't exist.
 */
export async function loadReferenceDoc(
  task: Task,
  referenceDir?: string,
): Promise<VersionApiSurface | null> {
  const baseDir = referenceDir || join(import.meta.dir, '..', '..', 'reference');

  const libDir = LIBRARY_DIR_MAP[task.library] || task.library;
  // Extract major version from target_version (e.g., "16.0.0" -> "16", "3" -> "3")
  const majorVersion = task.target_version.split('.')[0];
  const filePath = join(baseDir, libDir, `v${majorVersion}.json`);

  try {
    const raw = await readFile(filePath, 'utf-8');
    const json: unknown = JSON.parse(raw);
    const result = VersionApiSurfaceSchema.safeParse(json);
    if (result.success) {
      return result.data;
    }
    console.warn(`Reference file ${filePath} failed validation: ${result.error.message}`);
    return null;
  } catch {
    // File doesn't exist or can't be read
    return null;
  }
}

// --- Majority voting ---

/**
 * Applies majority voting across multiple judge runs for each criterion.
 * For each criterion, the verdict is PASS if >= ceil(runs/2) runs say PASS.
 * Evidence and reasoning are taken from the majority side.
 */
export function applyMajorityVote(task: Task, rawResponses: JudgeCallResult[]): CriterionResult[] {
  const criterionNames = task.rubric.criteria.map((c) => c.name);
  const criterionWeights = new Map(task.rubric.criteria.map((c) => [c.name, c.weight]));

  return criterionNames.map((name) => {
    const weight = criterionWeights.get(name) || 0;

    // Collect all verdicts for this criterion across runs
    const verdicts: {
      verdict: 'PASS' | 'FAIL';
      evidence: string;
      reasoning: string;
    }[] = [];

    for (const response of rawResponses) {
      if (!response.success) {
        // Failed run — count as all FAIL
        verdicts.push({
          verdict: 'FAIL',
          evidence: '',
          reasoning: `Judge run failed: ${response.error || 'unknown error'}`,
        });
        continue;
      }

      const matchingCriterion = response.criteria.find((c) => c.criterion === name);

      if (matchingCriterion) {
        verdicts.push({
          verdict: matchingCriterion.verdict,
          evidence: matchingCriterion.evidence,
          reasoning: matchingCriterion.reasoning,
        });
      } else {
        // Criterion not found in this run's response — count as FAIL
        verdicts.push({
          verdict: 'FAIL',
          evidence: '',
          reasoning: `Criterion "${name}" not found in judge response`,
        });
      }
    }

    // Majority vote: PASS if >= ceil(runs/2) say PASS
    const passCount = verdicts.filter((v) => v.verdict === 'PASS').length;
    const majority = Math.ceil(verdicts.length / 2);
    const finalVerdict: 'PASS' | 'FAIL' = passCount >= majority ? 'PASS' : 'FAIL';

    // Pick evidence/reasoning from the majority side
    const majorityVerdicts = verdicts.filter((v) => v.verdict === finalVerdict);
    const representative = majorityVerdicts[0] || {
      evidence: '',
      reasoning: '',
    };

    return {
      name,
      verdict: finalVerdict,
      weight,
      evidence: representative.evidence,
      reasoning: representative.reasoning,
    };
  });
}

/**
 * Calculates the weighted judge score from criterion results.
 * Score = sum(passed_criterion.weight) / sum(all_criterion.weight)
 */
export function calculateJudgeScore(criteria: CriterionResult[]): number {
  const totalWeight = criteria.reduce((sum, c) => sum + c.weight, 0);
  if (totalWeight === 0) return 0;

  const passedWeight = criteria
    .filter((c) => c.verdict === 'PASS')
    .reduce((sum, c) => sum + c.weight, 0);

  return passedWeight / totalWeight;
}

// --- Main scorer ---

/**
 * Scores generated code against a task's rubric using the LLM judge.
 * Calls the judge multiple times (default 3x) and applies majority vote per criterion.
 *
 * @param task - The benchmark task definition
 * @param generatedCode - The code generated by the agent
 * @param config - Scorer configuration
 * @returns Judge result with per-criterion verdicts and overall score
 */
export async function scoreWithRubric(
  task: Task,
  generatedCode: string,
  config: ScorerConfig = {},
): Promise<JudgeResult> {
  const runs = config.runs || 3;

  // Load reference documentation
  const referenceDoc = await loadReferenceDoc(task, config.referenceDir);

  // Build the judge prompt
  const prompt = buildJudgePrompt(task, generatedCode, referenceDoc);

  // Run the judge multiple times
  const rawResponses: JudgeCallResult[] = [];
  for (let i = 0; i < runs; i++) {
    let result = await callJudge(prompt, config.clientConfig);

    // If the first attempt fails to parse JSON, retry once
    if (!result.success && result.error?.includes('Failed to parse JSON')) {
      result = await callJudge(prompt, config.clientConfig);
    }

    rawResponses.push(result);
  }

  // Apply majority voting
  const criteria = applyMajorityVote(task, rawResponses);

  // Calculate weighted score
  const judgeScore = calculateJudgeScore(criteria);

  return {
    criteria,
    judgeScore,
    rawResponses,
  };
}
