import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { smokeTestSources } from "../nia-setup";

// --- Helpers ---

/**
 * Creates a minimal IndexResult for testing. The smoke test only reads
 * `sourceId`, `target.displayName`, and `global` from each result.
 */
function makeIndexResult(
	overrides: { sourceId?: string; displayName?: string; global?: boolean } = {},
) {
	return {
		target: {
			type: "docs" as const,
			identifier: "https://example.com/docs",
			displayName: overrides.displayName ?? "Test Docs",
		},
		sourceId: overrides.sourceId ?? "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		status: "indexed",
		global: overrides.global ?? true,
	};
}

/**
 * Builds a mock Response with the given JSON body and status code.
 */
function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

// --- Tests ---

describe("smokeTestSources", () => {
	let fetchSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		fetchSpy = spyOn(globalThis, "fetch");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	test("marks source as healthy when search returns valid content", async () => {
		fetchSpy.mockResolvedValueOnce(
			jsonResponse({
				content: "Here is the API reference for this library.",
				sources: [
					{
						content:
							"## Getting Started\nThis guide walks you through the core API including configuration, client setup, and advanced usage patterns.",
						metadata: { file_path: "https://example.com/docs/intro" },
					},
				],
			}),
		);

		const results = await smokeTestSources("fake-key", [makeIndexResult()]);

		expect(results).toHaveLength(1);
		expect(results[0]?.healthy).toBe(true);
		expect(results[0]?.issue).toBeUndefined();
		expect(results[0]?.latencyMs).toBeGreaterThanOrEqual(0);
		expect(results[0]?.displayName).toBe("Test Docs");
		expect(results[0]?.global).toBe(true);
	});

	test("detects indexed 404 page", async () => {
		fetchSpy.mockResolvedValueOnce(
			jsonResponse({
				content:
					"This information is not available in the provided documentation.",
				sources: [
					{
						content: "# 404\n## This page could not be found.",
						metadata: { file_path: "https://example.com/docs/16" },
					},
				],
			}),
		);

		const results = await smokeTestSources("fake-key", [makeIndexResult()]);

		expect(results).toHaveLength(1);
		expect(results[0]?.healthy).toBe(false);
		expect(results[0]?.issue).toBe("indexed 404 page");
	});

	test("detects empty content (no sources returned)", async () => {
		fetchSpy.mockResolvedValueOnce(
			jsonResponse({
				content: "No relevant results.",
				sources: [],
			}),
		);

		const results = await smokeTestSources("fake-key", [makeIndexResult()]);

		expect(results).toHaveLength(1);
		expect(results[0]?.healthy).toBe(false);
		expect(results[0]?.issue).toBe("no content returned");
	});

	test("detects API-level error (detail field)", async () => {
		fetchSpy.mockResolvedValueOnce(
			jsonResponse({
				detail: "No repositories or data sources were successfully resolved.",
			}),
		);

		const results = await smokeTestSources("fake-key", [makeIndexResult()]);

		expect(results).toHaveLength(1);
		expect(results[0]?.healthy).toBe(false);
		expect(results[0]?.issue).toContain("API error");
		expect(results[0]?.issue).toContain("No repositories");
	});

	test("detects HTTP error status", async () => {
		fetchSpy.mockResolvedValueOnce(
			jsonResponse({ error: "Internal Server Error" }, 500),
		);

		const results = await smokeTestSources("fake-key", [makeIndexResult()]);

		expect(results).toHaveLength(1);
		expect(results[0]?.healthy).toBe(false);
		expect(results[0]?.issue).toBe("query returned HTTP 500");
	});

	test("detects very short content as unhealthy", async () => {
		fetchSpy.mockResolvedValueOnce(
			jsonResponse({
				content: "OK",
				sources: [{ content: "Hi", metadata: {} }],
			}),
		);

		const results = await smokeTestSources("fake-key", [makeIndexResult()]);

		expect(results).toHaveLength(1);
		expect(results[0]?.healthy).toBe(false);
		expect(results[0]?.issue).toMatch(/content too short/);
	});

	test("handles fetch exception (network error)", async () => {
		fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));

		const results = await smokeTestSources("fake-key", [makeIndexResult()]);

		expect(results).toHaveLength(1);
		expect(results[0]?.healthy).toBe(false);
		expect(results[0]?.issue).toContain("ECONNREFUSED");
	});

	test("handles invalid JSON response", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response("not json at all", {
				status: 200,
				headers: { "Content-Type": "text/plain" },
			}),
		);

		const results = await smokeTestSources("fake-key", [makeIndexResult()]);

		expect(results).toHaveLength(1);
		expect(results[0]?.healthy).toBe(false);
		expect(results[0]?.issue).toBe("invalid JSON response");
	});

	test("processes multiple sources in parallel", async () => {
		const sources = [
			makeIndexResult({ sourceId: "id-1", displayName: "Docs A" }),
			makeIndexResult({
				sourceId: "id-2",
				displayName: "Docs B",
				global: false,
			}),
			makeIndexResult({ sourceId: "id-3", displayName: "Docs C" }),
		];

		const validContent =
			"## API Reference\n\nThis library provides the following exports:\n- `createClient()` — Creates a new client instance\n- `configure()` — Sets configuration options";

		// First and third healthy, second is a 404
		fetchSpy
			.mockResolvedValueOnce(
				jsonResponse({
					content: "Valid docs A",
					sources: [{ content: validContent, metadata: {} }],
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					content: "Not found",
					sources: [
						{
							content: "# 404\n## This page could not be found.",
							metadata: {},
						},
					],
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					content: "Valid docs C",
					sources: [{ content: validContent, metadata: {} }],
				}),
			);

		const results = await smokeTestSources("fake-key", sources, 1);

		expect(results).toHaveLength(3);

		// Debug: check what we got
		// console.log(JSON.stringify(results, null, 2));

		// Results are returned in the same order as input
		expect(results[0]?.displayName).toBe("Docs A");
		expect(results[0]?.issue).toBeUndefined();
		expect(results[0]?.healthy).toBe(true);

		expect(results[1]?.displayName).toBe("Docs B");
		expect(results[1]?.healthy).toBe(false);
		expect(results[1]?.issue).toBe("indexed 404 page");
		expect(results[1]?.global).toBe(false);

		expect(results[2]?.displayName).toBe("Docs C");
		expect(results[2]?.healthy).toBe(true);
	});

	test("sends correct request to Nia search API", async () => {
		fetchSpy.mockResolvedValueOnce(
			jsonResponse({
				content: "Some API docs content for the library.",
				sources: [
					{
						content:
							"## API Reference\n\nThis library provides createClient(), configure(), and many other utilities for building applications.",
						metadata: {},
					},
				],
			}),
		);

		const sourceId = "test-uuid-1234";
		await smokeTestSources("my-api-key", [makeIndexResult({ sourceId })]);

		expect(fetchSpy).toHaveBeenCalledTimes(1);

		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://apigcp.trynia.ai/v2/search");
		expect(init.method).toBe("POST");

		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer my-api-key");
		expect(headers["Content-Type"]).toBe("application/json");

		const body = JSON.parse(init.body as string);
		expect(body.data_sources).toEqual([sourceId]);
		expect(body.search_mode).toBe("sources");
		expect(body.stream).toBe(false);
	});

	test("records latency for each source", async () => {
		fetchSpy.mockResolvedValueOnce(
			jsonResponse({
				content: "Some docs",
				sources: [
					{
						content:
							"## API Reference\n\nThis library provides createClient(), configure(), and many other utilities for building applications.",
						metadata: {},
					},
				],
			}),
		);

		const results = await smokeTestSources("fake-key", [makeIndexResult()]);

		expect(results).toHaveLength(1);
		expect(typeof results[0]?.latencyMs).toBe("number");
		expect(results[0]?.latencyMs).toBeGreaterThanOrEqual(0);
	});

	test("returns empty array for empty input", async () => {
		const results = await smokeTestSources("fake-key", []);

		expect(results).toHaveLength(0);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test("detects 'page does not exist' pattern as 404", async () => {
		fetchSpy.mockResolvedValueOnce(
			jsonResponse({
				content: "Error page.",
				sources: [
					{
						content:
							"The page you are looking for does not exist. Please check the URL.",
						metadata: {},
					},
				],
			}),
		);

		const results = await smokeTestSources("fake-key", [makeIndexResult()]);

		expect(results).toHaveLength(1);
		expect(results[0]?.healthy).toBe(false);
		expect(results[0]?.issue).toBe("indexed 404 page");
	});

	test("missing sources field treated as no content", async () => {
		fetchSpy.mockResolvedValueOnce(
			jsonResponse({
				content: "Some response but no sources field",
			}),
		);

		const results = await smokeTestSources("fake-key", [makeIndexResult()]);

		expect(results).toHaveLength(1);
		expect(results[0]?.healthy).toBe(false);
		expect(results[0]?.issue).toBe("no content returned");
	});
});
