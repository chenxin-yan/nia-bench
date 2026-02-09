import { describe, expect, test } from "bun:test";
import type { VersionApiSurface } from "@/types/reference";
import type { Task } from "@/types/task";
import { buildJudgePrompt } from "../prompt-template";

// --- Mock data ---

const mockTask: Task = {
	id: "nextjs-16-proxy-ts",
	category: "bleeding_edge",
	library: "next",
	target_version: "16.0.0",
	prompt: "Using Next.js 16, create a proxy file that handles authentication.",
	reference_solution:
		"// proxy.ts\nexport function proxy(request: NextRequest) {\n  // ...\n}",
	test_spec: {
		ast_checks: [
			{ type: "function_exported", name: "proxy" },
			{ type: "function_absent", name: "middleware" },
		],
	},
	rubric: {
		criteria: [
			{
				name: "proxy_filename",
				weight: 0.25,
				description: "File is `proxy.ts`, not `middleware.ts`",
			},
			{
				name: "proxy_function_name",
				weight: 0.25,
				description: "Exports `function proxy()`, not `function middleware()`",
			},
			{
				name: "no_edge_runtime",
				weight: 0.15,
				description: "Does not set `runtime: 'edge'` in config",
			},
			{
				name: "correct_api_usage",
				weight: 0.2,
				description:
					"Correctly uses `NextResponse`, `NextRequest`, cookies, redirects",
			},
			{
				name: "no_hallucination",
				weight: 0.15,
				description: "No v15 middleware patterns, no invented APIs",
			},
		],
	},
	common_hallucinations: [
		"Creating `middleware.ts` instead of `proxy.ts`",
		"export function middleware(request: NextRequest)",
		"Setting `runtime: 'edge'` in config",
	],
};

const mockReferenceDoc: VersionApiSurface = {
	library: "next",
	version: "16",
	sync_apis: [],
	async_apis: ["cookies", "headers", "draftMode"],
	params_type: "promise",
	proxy_file: "proxy.ts",
	proxy_function: "proxy",
	available_imports: {
		"next/headers": ["cookies", "headers", "draftMode"],
		"next/server": ["NextResponse", "NextRequest", "after"],
	},
	unavailable_apis: [
		"middleware.ts (renamed to proxy.ts)",
		"middleware (function, renamed to proxy)",
	],
	removed_from_previous: [
		"middleware.ts (renamed to proxy.ts)",
		"export function middleware() (renamed to export function proxy())",
	],
	available_hooks: [],
	unavailable_hooks: [],
	available_types: [],
	unavailable_types: [],
	key_features: [
		"proxy.ts replaces middleware.ts",
		"Enforced async cookies(), headers()",
	],
	breaking_changes: [
		"middleware.ts renamed to proxy.ts",
		"Sync access to cookies/headers removed",
	],
	notes: [
		"proxy.ts is the ONLY correct file name",
		"runtime: 'edge' is NOT supported in proxy.ts",
	],
};

const generatedCode = `// proxy.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  const token = request.cookies.get('auth-token');
  if (!token) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: '/dashboard/:path*',
};`;

// --- Tests ---

describe("buildJudgePrompt", () => {
	test("includes the task prompt", () => {
		const prompt = buildJudgePrompt(mockTask, generatedCode, mockReferenceDoc);
		expect(prompt).toContain(mockTask.prompt);
	});

	test("includes the target library version", () => {
		const prompt = buildJudgePrompt(mockTask, generatedCode, mockReferenceDoc);
		expect(prompt).toContain("next v16.0.0");
	});

	test("includes reference documentation", () => {
		const prompt = buildJudgePrompt(mockTask, generatedCode, mockReferenceDoc);
		expect(prompt).toContain("next v16 API Surface");
		expect(prompt).toContain("cookies");
		expect(prompt).toContain("headers");
		expect(prompt).toContain("proxy.ts");
	});

	test("includes reference solution", () => {
		const prompt = buildJudgePrompt(mockTask, generatedCode, mockReferenceDoc);
		expect(prompt).toContain(mockTask.reference_solution);
	});

	test("includes generated code", () => {
		const prompt = buildJudgePrompt(mockTask, generatedCode, mockReferenceDoc);
		expect(prompt).toContain(generatedCode);
	});

	test("includes all rubric criteria with names, weights, and descriptions", () => {
		const prompt = buildJudgePrompt(mockTask, generatedCode, mockReferenceDoc);
		expect(prompt).toContain("proxy_filename");
		expect(prompt).toContain("25%");
		expect(prompt).toContain("File is `proxy.ts`, not `middleware.ts`");
		expect(prompt).toContain("proxy_function_name");
		expect(prompt).toContain("no_edge_runtime");
		expect(prompt).toContain("15%");
		expect(prompt).toContain("correct_api_usage");
		expect(prompt).toContain("20%");
		expect(prompt).toContain("no_hallucination");
	});

	test("includes known hallucination patterns", () => {
		const prompt = buildJudgePrompt(mockTask, generatedCode, mockReferenceDoc);
		expect(prompt).toContain("Creating `middleware.ts` instead of `proxy.ts`");
		expect(prompt).toContain(
			"export function middleware(request: NextRequest)",
		);
		expect(prompt).toContain("Setting `runtime: 'edge'` in config");
	});

	test("includes the ONLY use reference documentation instruction", () => {
		const prompt = buildJudgePrompt(mockTask, generatedCode, mockReferenceDoc);
		expect(prompt).toContain(
			"Judge ONLY based on the reference documentation and reference solution provided below",
		);
		expect(prompt).toContain("Do NOT use your own knowledge of the library");
		expect(prompt).toContain(
			'A method is "correct" ONLY if it appears in the reference documentation above',
		);
	});

	test("includes reference doc sections: sync APIs, async APIs, available imports", () => {
		const prompt = buildJudgePrompt(mockTask, generatedCode, mockReferenceDoc);
		expect(prompt).toContain("Async APIs (require await)");
		expect(prompt).toContain("cookies, headers, draftMode");
		expect(prompt).toContain("Available Imports");
		expect(prompt).toContain("next/headers");
		expect(prompt).toContain("NextResponse, NextRequest, after");
	});

	test("includes reference doc sections: unavailable APIs, breaking changes, notes", () => {
		const prompt = buildJudgePrompt(mockTask, generatedCode, mockReferenceDoc);
		expect(prompt).toContain("Unavailable APIs (NOT in this version)");
		expect(prompt).toContain("middleware.ts (renamed to proxy.ts)");
		expect(prompt).toContain("Breaking Changes");
		expect(prompt).toContain("Sync access to cookies/headers removed");
		expect(prompt).toContain("Notes");
		expect(prompt).toContain("proxy.ts is the ONLY correct file name");
	});

	test("includes reference doc sections: key features", () => {
		const prompt = buildJudgePrompt(mockTask, generatedCode, mockReferenceDoc);
		expect(prompt).toContain("Key Features");
		expect(prompt).toContain("proxy.ts replaces middleware.ts");
	});

	test("includes proxy file and function from reference doc", () => {
		const prompt = buildJudgePrompt(mockTask, generatedCode, mockReferenceDoc);
		expect(prompt).toContain("Proxy/Middleware file");
		expect(prompt).toContain("proxy.ts");
		expect(prompt).toContain("Proxy/Middleware function");
		expect(prompt).toContain("proxy");
	});

	test("handles null reference doc gracefully", () => {
		const prompt = buildJudgePrompt(mockTask, generatedCode, null);
		expect(prompt).toContain(
			"No reference documentation available for this library version.",
		);
		// Should still include all other sections
		expect(prompt).toContain(mockTask.prompt);
		expect(prompt).toContain(generatedCode);
		expect(prompt).toContain("proxy_filename");
	});

	test("requests JSON array response format", () => {
		const prompt = buildJudgePrompt(mockTask, generatedCode, mockReferenceDoc);
		expect(prompt).toContain("respond with a JSON array");
		expect(prompt).toContain('"criterion"');
		expect(prompt).toContain('"verdict"');
		expect(prompt).toContain('"evidence"');
		expect(prompt).toContain('"reasoning"');
	});

	test("handles reference doc with rendering info (React-specific)", () => {
		const reactRef: VersionApiSurface = {
			library: "react",
			version: "17",
			sync_apis: [],
			async_apis: [],
			available_imports: {},
			unavailable_apis: [],
			removed_from_previous: [],
			available_hooks: ["useState", "useEffect", "useRef"],
			unavailable_hooks: ["useId", "use"],
			available_types: [],
			unavailable_types: [],
			key_features: [],
			breaking_changes: [],
			notes: [],
			rendering: {
				entry_api: "ReactDOM.render",
				import_path: "react-dom",
				deprecated: [],
			},
		};

		const prompt = buildJudgePrompt(mockTask, generatedCode, reactRef);
		expect(prompt).toContain("Rendering");
		expect(prompt).toContain("ReactDOM.render");
		expect(prompt).toContain("react-dom");
		expect(prompt).toContain("Available Hooks");
		expect(prompt).toContain("useState, useEffect, useRef");
		expect(prompt).toContain("Unavailable Hooks");
		expect(prompt).toContain("useId, use");
	});

	test("handles reference doc with params_type n/a (no params section shown)", () => {
		const ref: VersionApiSurface = {
			library: "zod",
			version: "3",
			sync_apis: [],
			async_apis: [],
			params_type: "n/a",
			available_imports: {},
			unavailable_apis: [],
			removed_from_previous: [],
			available_hooks: [],
			unavailable_hooks: [],
			available_types: [],
			unavailable_types: [],
			key_features: [],
			breaking_changes: [],
			notes: [],
		};

		const prompt = buildJudgePrompt(mockTask, generatedCode, ref);
		// params_type 'n/a' should be omitted
		expect(prompt).not.toContain("Params type: n/a");
	});

	test("prompt structure has all required sections in correct order", () => {
		const prompt = buildJudgePrompt(mockTask, generatedCode, mockReferenceDoc);

		// Verify section headers exist and are in order
		const sections = [
			"## Task",
			"## Target Library Version",
			"## Reference Documentation (ground truth)",
			"## Reference Solution",
			"## Generated Code (to evaluate)",
			"## Rubric Criteria",
			"## Known Hallucination Patterns (watch for these)",
		];

		let lastIndex = -1;
		for (const section of sections) {
			const idx = prompt.indexOf(section);
			expect(idx).toBeGreaterThan(lastIndex);
			lastIndex = idx;
		}
	});
});
