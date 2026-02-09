import OpenAI from "openai";

/** Configuration for the OpenRouter-based LLM judge */
export interface JudgeClientConfig {
	/** OpenRouter API key. Defaults to OPENROUTER_API_KEY env var. */
	apiKey?: string;
	/** Model ID on OpenRouter. Defaults to 'openai/gpt-5-mini'. */
	model?: string;
	/** Temperature for judge calls. Defaults to 0.0. */
	temperature?: number;
	/** Maximum tokens for the response. Defaults to 4096. */
	maxTokens?: number;
}

/** Raw response from a single judge criterion */
export interface JudgeCriterionResponse {
	criterion: string;
	verdict: "PASS" | "FAIL";
	evidence: string;
	reasoning: string;
}

/** Result of a single judge call */
export interface JudgeCallResult {
	criteria: JudgeCriterionResponse[];
	rawResponse: string;
	success: boolean;
	error?: string;
}

const DEFAULT_MODEL = "openai/gpt-5-mini";
const DEFAULT_TEMPERATURE = 0.0;
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Creates an OpenRouter client configured for judge calls.
 */
function createClient(config: JudgeClientConfig = {}): OpenAI {
	const apiKey = config.apiKey || process.env.OPENROUTER_API_KEY;
	if (!apiKey) {
		throw new Error(
			"OpenRouter API key not found. Set OPENROUTER_API_KEY environment variable or pass apiKey in config.",
		);
	}

	return new OpenAI({
		baseURL: "https://openrouter.ai/api/v1",
		apiKey,
	});
}

/**
 * Calls the LLM judge via OpenRouter with the given prompt.
 * Returns parsed criterion responses.
 *
 * @param prompt - The full judge prompt (built by buildJudgePrompt)
 * @param config - Client configuration
 * @returns Parsed judge criterion responses
 */
export async function callJudge(
	prompt: string,
	config: JudgeClientConfig = {},
): Promise<JudgeCallResult> {
	const client = createClient(config);
	const model = config.model || DEFAULT_MODEL;
	const temperature = config.temperature ?? DEFAULT_TEMPERATURE;
	const maxTokens = config.maxTokens || DEFAULT_MAX_TOKENS;

	try {
		const response = await client.chat.completions.create({
			model,
			temperature,
			max_tokens: maxTokens,
			messages: [
				{
					role: "user",
					content: prompt,
				},
			],
		});

		const rawResponse = response.choices[0]?.message?.content || "";
		return parseJudgeResponse(rawResponse);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			criteria: [],
			rawResponse: "",
			success: false,
			error: `API call failed: ${message}`,
		};
	}
}

/**
 * Parses the raw LLM judge response into structured criterion responses.
 * Handles both JSON arrays and single JSON objects.
 */
export function parseJudgeResponse(rawResponse: string): JudgeCallResult {
	try {
		// Try to extract JSON from the response (may have surrounding text)
		const jsonMatch = rawResponse.match(/\[[\s\S]*\]/);
		const jsonStr = jsonMatch ? jsonMatch[0] : rawResponse.trim();

		const parsed: unknown = JSON.parse(jsonStr);

		if (!Array.isArray(parsed)) {
			// If it's a single object, wrap in array
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				"criterion" in parsed
			) {
				return {
					criteria: [
						validateCriterionResponse(parsed as Record<string, unknown>),
					],
					rawResponse,
					success: true,
				};
			}
			return {
				criteria: [],
				rawResponse,
				success: false,
				error: "Response is not a JSON array or criterion object",
			};
		}

		const criteria: JudgeCriterionResponse[] = [];
		for (const item of parsed) {
			if (typeof item === "object" && item !== null) {
				criteria.push(
					validateCriterionResponse(item as Record<string, unknown>),
				);
			}
		}

		return {
			criteria,
			rawResponse,
			success: criteria.length > 0,
			error:
				criteria.length === 0
					? "No valid criteria parsed from response"
					: undefined,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			criteria: [],
			rawResponse,
			success: false,
			error: `Failed to parse JSON response: ${message}`,
		};
	}
}

/**
 * Validates and normalizes a single criterion response object.
 */
function validateCriterionResponse(
	obj: Record<string, unknown>,
): JudgeCriterionResponse {
	return {
		criterion: typeof obj.criterion === "string" ? obj.criterion : "unknown",
		verdict:
			typeof obj.verdict === "string" &&
			(obj.verdict === "PASS" || obj.verdict === "FAIL")
				? obj.verdict
				: "FAIL",
		evidence: typeof obj.evidence === "string" ? obj.evidence : "",
		reasoning: typeof obj.reasoning === "string" ? obj.reasoning : "",
	};
}
