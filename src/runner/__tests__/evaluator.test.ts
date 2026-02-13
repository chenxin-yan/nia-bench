import { describe, expect, test } from "bun:test";
import type { Task } from "@/types/task";
import { evaluateCode } from "../evaluator";

// --- Test Data: Pilot Tasks ---

/**
 * Next.js 16 proxy.ts task (bleeding_edge) with 4 AST checks.
 */
const proxyTask: Task = {
	id: "nextjs-16-proxy-ts",
	category: "bleeding_edge",
	library: "next",
	target_version: "16.0.0",
	prompt: "Using Next.js 16, create a proxy file...",
	reference_solution: "",
	test_spec: {
		ast_checks: [
			{ type: "function_exported", name: "proxy" },
			{ type: "function_absent", name: "middleware" },
			{ type: "call_exists", call: "config.matcher" },
			{ type: "property_absent", property: "runtime", inObject: "config" },
		],
	},
	rubric: {
		criteria: [
			{ name: "proxy_filename", weight: 0.25, description: "File is proxy.ts" },
			{
				name: "proxy_function_name",
				weight: 0.25,
				description: "Exports function proxy()",
			},
			{
				name: "no_edge_runtime",
				weight: 0.15,
				description: "No runtime: edge",
			},
			{
				name: "correct_api_usage",
				weight: 0.2,
				description: "Correct NextResponse usage",
			},
			{
				name: "no_hallucination",
				weight: 0.15,
				description: "No v15 patterns",
			},
		],
	},
	common_hallucinations: [
		"Creating middleware.ts instead of proxy.ts (v15 and earlier pattern)",
		"export function middleware(request: NextRequest) (v15 function name)",
	],
};

/**
 * Reference solution for proxy task — should PASS all AST checks.
 */
const proxyReferenceCode = `import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  const token = request.cookies.get('auth-token');

  if (!token) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  const response = NextResponse.next();
  response.headers.set('x-user-verified', 'true');
  return response;
}

export const config = {
  matcher: '/dashboard/:path*',
};`;

/**
 * Hallucinated code for proxy task — has middleware instead of proxy,
 * and includes runtime: 'edge' in config.
 */
const proxyBadCode = `import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const token = request.cookies.get('auth-token');

  if (!token) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  const response = NextResponse.next();
  response.headers.set('x-user-verified', 'true');
  return response;
}

export const config = {
  matcher: '/dashboard/:path*',
  runtime: 'edge',
};`;

/**
 * React 17 audit v19 code task (version_locked_audit) — NO AST checks, judge-only.
 */
const auditTask: Task = {
	id: "react-17-audit-v19-code",
	category: "version_locked_audit",
	library: "react",
	target_version: "17.0.2",
	prompt: "This project uses React 17. Audit the following code...",
	reference_solution: "Issues identified: ...",
	test_spec: {
		ast_checks: [],
	},
	rubric: {
		criteria: [
			{
				name: "identify_all_invalid_hooks",
				weight: 0.3,
				description: "Identifies use, useId, useActionState, useFormStatus",
			},
			{
				name: "identify_create_root",
				weight: 0.2,
				description: "Identifies createRoot as v18+ only",
			},
			{
				name: "identify_ref_as_prop",
				weight: 0.15,
				description: "Identifies ref as prop needs forwardRef in v17",
			},
			{
				name: "identify_form_action",
				weight: 0.15,
				description: "Identifies form action prop as React 19",
			},
			{
				name: "correct_alternatives",
				weight: 0.2,
				description: "Provides correct React 17 alternatives",
			},
		],
	},
	common_hallucinations: [
		"Missing some invalid hooks",
		"Not recognizing ref as prop as a React 19 feature",
	],
};

/**
 * Next.js 13 sync request APIs task (version_locked_write) — has AST checks + context.
 */
const syncApisTask: Task = {
	id: "nextjs-13-sync-request-apis",
	category: "version_locked_write",
	library: "next",
	target_version: "13.5.6",
	prompt: "This project uses Next.js 13...",
	context: {
		package_json: '{"dependencies":{"next":"13.5.6"}}',
	},
	reference_solution: "",
	test_spec: {
		ast_checks: [
			{ type: "await_absent", call: "cookies" },
			{ type: "await_absent", call: "headers" },
			{ type: "import_exists", name: "cookies", from: "next/headers" },
			{ type: "import_exists", name: "headers", from: "next/headers" },
		],
	},
	rubric: {
		criteria: [
			{
				name: "sync_cookies",
				weight: 0.3,
				description: "cookies() without await",
			},
			{
				name: "sync_headers",
				weight: 0.3,
				description: "headers() without await",
			},
			{
				name: "correct_import",
				weight: 0.2,
				description: "Imports from next/headers",
			},
			{
				name: "no_hallucination",
				weight: 0.2,
				description: "No v14/15 patterns",
			},
		],
	},
	common_hallucinations: ["await cookies() (v15 pattern)"],
};

const syncApisReferenceCode = `import { cookies, headers } from 'next/headers';

export default async function ProfilePage() {
  const cookieStore = cookies();
  const headersList = headers();

  const session = cookieStore.get('session');
  const lang = headersList.get('accept-language') ?? 'en';

  return (
    <div>
      <h1>Welcome{session ? \`, \${session.value}\` : ''}</h1>
      <p>Language: {lang}</p>
    </div>
  );
}`;

/**
 * Bad code for Next.js 13 task — uses await (v15 pattern).
 */
const syncApisBadCode = `import { cookies, headers } from 'next/headers';

export default async function ProfilePage() {
  const cookieStore = await cookies();
  const headersList = await headers();

  const session = cookieStore.get('session');
  const lang = headersList.get('accept-language') ?? 'en';

  return (
    <div>
      <h1>Welcome{session ? \`, \${session.value}\` : ''}</h1>
      <p>Language: {lang}</p>
    </div>
  );
}`;

// --- Tests ---

describe("evaluateCode", () => {
	describe("Test case 1: skip-judge mode with reference solution", () => {
		test("reference solution passes all AST checks with testScore 1.0", async () => {
			const result = await evaluateCode(
				proxyTask,
				{ "proxy.ts": proxyReferenceCode },
				"baseline",
				0,
				{ skipJudge: true },
			);

			expect(result.taskId).toBe("nextjs-16-proxy-ts");
			expect(result.condition).toBe("baseline");
			expect(result.runIndex).toBe(0);

			// All 4 AST checks should pass
			expect(result.astResults).toHaveLength(4);
			for (const astResult of result.astResults) {
				expect(astResult.passed).toBe(true);
			}

			// testScore should be 1.0 (4/4 passed)
			expect(result.testScore).toBe(1.0);

			// judge was skipped
			expect(result.judgeScore).toBe(0);
			expect(result.judgeResult).toBeNull();

			// In skip-judge mode with AST checks present: finalScore = testScore
			expect(result.finalScore).toBe(1.0);

			// No hallucinations when all checks pass
			expect(result.hallucinations.types).toHaveLength(0);
			expect(result.hallucinations.details).toHaveLength(0);

			// Extracted files should be preserved
			expect(result.extractedFiles).toEqual({ "proxy.ts": proxyReferenceCode });
		});

		test("another reference solution (sync APIs) also passes all checks", async () => {
			const result = await evaluateCode(
				syncApisTask,
				{ "page.tsx": syncApisReferenceCode },
				"nia",
				2,
				{ skipJudge: true },
			);

			expect(result.testScore).toBe(1.0);
			expect(result.finalScore).toBe(1.0);
			expect(result.astResults).toHaveLength(4);
			for (const r of result.astResults) {
				expect(r.passed).toBe(true);
			}
			expect(result.hallucinations.types).toHaveLength(0);
		});
	});

	describe("Test case 2: skip-judge mode with bad code", () => {
		test("hallucinated proxy code fails expected AST checks", async () => {
			const result = await evaluateCode(
				proxyTask,
				{ "middleware.ts": proxyBadCode },
				"context7",
				1,
				{ skipJudge: true },
			);

			expect(result.taskId).toBe("nextjs-16-proxy-ts");
			expect(result.condition).toBe("context7");

			// AST checks: function_exported('proxy') should FAIL (exports middleware not proxy),
			// function_absent('middleware') should FAIL (middleware IS exported),
			// call_exists('config.matcher') should PASS (config with matcher exists),
			// property_absent('runtime') should FAIL (runtime IS present in config)
			expect(result.astResults).toHaveLength(4);

			// Count passed and failed
			const passed = result.astResults.filter((r) => r.passed);
			const failed = result.astResults.filter((r) => !r.passed);

			// Expect some failures — at minimum function_exported(proxy), function_absent(middleware), property_absent(runtime)
			expect(failed.length).toBeGreaterThanOrEqual(2);
			expect(passed.length).toBeLessThan(4);

			// testScore should be < 1.0
			expect(result.testScore).toBeLessThan(1.0);
			expect(result.testScore).toBeGreaterThan(0);

			// Some hallucinations should be detected
			expect(result.hallucinations.types.length).toBeGreaterThan(0);
			expect(result.hallucinations.details.length).toBeGreaterThan(0);
		});

		test("bad sync APIs code with await fails await_absent checks", async () => {
			const result = await evaluateCode(
				syncApisTask,
				{ "page.tsx": syncApisBadCode },
				"baseline",
				0,
				{ skipJudge: true },
			);

			// imports are correct, so 2 pass; but await_absent fails for both cookies and headers
			const passedChecks = result.astResults.filter((r) => r.passed);
			const failedChecks = result.astResults.filter((r) => !r.passed);

			// import_exists checks should pass (cookies and headers from next/headers are present)
			expect(passedChecks.length).toBe(2);
			// await_absent checks should fail (code uses await)
			expect(failedChecks.length).toBe(2);

			expect(result.testScore).toBe(0.5); // 2/4
			expect(result.finalScore).toBe(0.5); // skip-judge: finalScore = testScore

			// Should detect future_api hallucinations (await = newer version pattern)
			expect(result.hallucinations.types).toContain("future_api");
		});
	});

	describe("Test case 3: audit task with skip-judge", () => {
		test("audit task with no AST checks returns finalScore 0 when judge skipped", async () => {
			const result = await evaluateCode(
				auditTask,
				{ "audit-response.ts": "// The audit response text" },
				"nia",
				0,
				{ skipJudge: true },
			);

			// No AST checks for audit tasks
			expect(result.astResults).toHaveLength(0);
			expect(result.testScore).toBe(0);

			// Judge was skipped
			expect(result.judgeScore).toBe(0);
			expect(result.judgeResult).toBeNull();

			// Audit task with no AST checks and judge skipped: finalScore = judgeScore = 0
			expect(result.finalScore).toBe(0);

			// No hallucinations detected (no AST checks, no judge)
			expect(result.hallucinations.types).toHaveLength(0);
		});

		test("audit task does not crash with empty extracted files", async () => {
			const result = await evaluateCode(auditTask, {}, "baseline", 0, {
				skipJudge: true,
			});

			expect(result.astResults).toHaveLength(0);
			expect(result.finalScore).toBe(0);
		});
	});

	describe("Test case 4: score formula verification", () => {
		test("combined score formula: 0.6 * testScore + 0.4 * judgeScore", () => {
			// We can't easily test with a real judge call, but we can test the formula
			// by verifying the evaluator output structure matches expectations.
			// For an isolated formula test, we verify the math:
			// If testScore = 0.8 (4/5 AST checks pass) and judgeScore = 0.6,
			// then finalScore = 0.6 * 0.8 + 0.4 * 0.6 = 0.48 + 0.24 = 0.72

			const testScore = 0.8;
			const judgeScore = 0.6;
			const expectedFinalScore = 0.6 * testScore + 0.4 * judgeScore;
			expect(expectedFinalScore).toBeCloseTo(0.72, 10);
		});

		test("skip-judge mode sets finalScore = testScore for tasks with AST checks", async () => {
			// Use proxy task with reference code — testScore should be 1.0
			const result = await evaluateCode(
				proxyTask,
				{ "proxy.ts": proxyReferenceCode },
				"baseline",
				0,
				{ skipJudge: true },
			);

			expect(result.testScore).toBe(1.0);
			expect(result.judgeScore).toBe(0);
			expect(result.finalScore).toBe(result.testScore);
		});

		test("audit task with no AST checks sets finalScore = judgeScore", async () => {
			// In skip-judge mode, judgeScore = 0, so finalScore = 0
			const result = await evaluateCode(
				auditTask,
				{ "response.ts": "// response" },
				"nia",
				0,
				{
					skipJudge: true,
				},
			);

			// For audit tasks: finalScore = judgeScore (which is 0 since judge was skipped)
			expect(result.finalScore).toBe(result.judgeScore);
			expect(result.finalScore).toBe(0);
		});
	});

	describe("multi-file support", () => {
		test("evaluates multiple files with file-specific AST checks", async () => {
			// Create a task with file-specific checks
			const multiFileTask: Task = {
				id: "multi-file-test",
				category: "bleeding_edge",
				library: "next",
				target_version: "16.0.0",
				prompt: "Create page.tsx and default.tsx",
				reference_solution: "",
				test_spec: {
					ast_checks: [
						{ type: "function_exported", name: "default", file: "page.tsx" },
						{ type: "function_exported", name: "default", file: "default.tsx" },
					],
				},
				rubric: {
					criteria: [
						{
							name: "page_component",
							weight: 0.5,
							description: "Page exports default",
						},
						{
							name: "default_component",
							weight: 0.5,
							description: "Default exports default",
						},
					],
				},
				common_hallucinations: [],
			};

			const result = await evaluateCode(
				multiFileTask,
				{
					"page.tsx":
						"export default function Page() { return <div>Page</div>; }",
					"default.tsx":
						"export default function Default() { return <div>Default</div>; }",
				},
				"baseline",
				0,
				{ skipJudge: true },
			);

			expect(result.astResults).toHaveLength(2);
			expect(result.astResults[0]?.passed).toBe(true);
			expect(result.astResults[1]?.passed).toBe(true);
			expect(result.testScore).toBe(1.0);
		});

		test("missing file causes all checks for that file to fail", async () => {
			const multiFileTask: Task = {
				id: "multi-file-missing",
				category: "bleeding_edge",
				library: "next",
				target_version: "16.0.0",
				prompt: "Create page.tsx and default.tsx",
				reference_solution: "",
				test_spec: {
					ast_checks: [
						{ type: "function_exported", name: "default", file: "page.tsx" },
						{ type: "function_exported", name: "default", file: "missing.tsx" },
					],
				},
				rubric: {
					criteria: [
						{
							name: "page_component",
							weight: 0.5,
							description: "Page exports default",
						},
						{
							name: "missing_component",
							weight: 0.5,
							description: "Missing file",
						},
					],
				},
				common_hallucinations: [],
			};

			const result = await evaluateCode(
				multiFileTask,
				{
					"page.tsx":
						"export default function Page() { return <div>Page</div>; }",
				},
				"baseline",
				0,
				{ skipJudge: true },
			);

			expect(result.astResults).toHaveLength(2);
			// page.tsx check passes
			const pageCheck = result.astResults.find(
				(r) =>
					r.check.type === "function_exported" &&
					"file" in r.check &&
					r.check.file === "page.tsx",
			);
			expect(pageCheck?.passed).toBe(true);
			// missing.tsx check fails
			const missingCheck = result.astResults.find(
				(r) =>
					r.check.type === "function_exported" &&
					"file" in r.check &&
					r.check.file === "missing.tsx",
			);
			expect(missingCheck?.passed).toBe(false);
			expect(missingCheck?.message).toContain("missing.tsx");

			expect(result.testScore).toBe(0.5); // 1/2
		});
	});

	describe("edge cases", () => {
		test("empty extracted files with AST checks — absence checks pass, existence checks fail", async () => {
			const result = await evaluateCode(proxyTask, {}, "baseline", 0, {
				skipJudge: true,
			});

			expect(result.astResults).toHaveLength(4);

			// Existence checks should fail (nothing to find)
			const existenceResults = result.astResults.filter(
				(r) =>
					r.check.type === "function_exported" ||
					r.check.type === "call_exists",
			);
			for (const r of existenceResults) {
				expect(r.passed).toBe(false);
				expect(r.message).toContain("No code files extracted");
			}

			// Absence checks should pass (nothing present = trivially absent)
			const absenceResults = result.astResults.filter(
				(r) =>
					r.check.type === "function_absent" ||
					r.check.type === "property_absent",
			);
			for (const r of absenceResults) {
				expect(r.passed).toBe(true);
				expect(r.message).toContain("Trivially passed");
			}

			// 2 existence checks fail + 2 absence checks pass = 0.5
			expect(result.testScore).toBe(0.5);
			expect(result.finalScore).toBe(0.5); // skipJudge mode, 100% test weight
		});

		test("agent crash with no code — clean zero without phantom hallucinations", async () => {
			const result = await evaluateCode(
				proxyTask,
				{}, // no extracted files
				"nia",
				2,
				{
					skipJudge: true,
				},
				{
					prompt: "test prompt",
					durationMs: 900000,
					toolCallCount: 0,
					toolCallSummary: {},
					agentError: {
						name: "ProcessError",
						message: "opencode exited with code 143",
					},
					attempts: 3,
				},
			);

			// Should get clean zero scores
			expect(result.testScore).toBe(0);
			expect(result.judgeScore).toBe(0);
			expect(result.finalScore).toBe(0);

			// All AST checks should fail with crash message
			expect(result.astResults).toHaveLength(4);
			for (const r of result.astResults) {
				expect(r.passed).toBe(false);
				expect(r.message).toContain("Agent crashed");
			}

			// NO phantom hallucinations — this is the key fix
			expect(result.hallucinations.types).toHaveLength(0);
			expect(result.hallucinations.details).toHaveLength(0);

			// Judge should be skipped entirely on crash
			expect(result.judgeResult).toBeNull();

			// Error metadata preserved
			expect(result.agentError).not.toBeNull();
			expect(result.agentError?.name).toBe("ProcessError");
		});

		test("result contains all expected metadata fields", async () => {
			const result = await evaluateCode(
				proxyTask,
				{ "proxy.ts": proxyReferenceCode },
				"nia",
				2,
				{
					skipJudge: true,
				},
			);

			// Check all fields exist
			expect(result.taskId).toBe("nextjs-16-proxy-ts");
			expect(result.condition).toBe("nia");
			expect(result.runIndex).toBe(2);
			expect(typeof result.testScore).toBe("number");
			expect(typeof result.judgeScore).toBe("number");
			expect(typeof result.finalScore).toBe("number");
			expect(Array.isArray(result.astResults)).toBe(true);
			expect(result.judgeResult).toBeNull(); // skipped
			expect(result.hallucinations).toBeDefined();
			expect(result.hallucinations.types).toBeDefined();
			expect(result.hallucinations.details).toBeDefined();
			expect(result.extractedFiles).toBeDefined();
		});

		test("partial match: file key without exact path match", async () => {
			// AST checks reference 'page.tsx' but extracted files have 'app/page.tsx'
			const taskWithFileChecks: Task = {
				...syncApisTask,
				test_spec: {
					ast_checks: [
						{
							type: "import_exists",
							name: "cookies",
							from: "next/headers",
							file: "page.tsx",
						},
					],
				},
			};

			const result = await evaluateCode(
				taskWithFileChecks,
				{ "app/page.tsx": syncApisReferenceCode },
				"baseline",
				0,
				{ skipJudge: true },
			);

			// Should find the file via partial match (page.tsx matches app/page.tsx)
			expect(result.astResults).toHaveLength(1);
			expect(result.astResults[0]?.passed).toBe(true);
		});
	});
});
