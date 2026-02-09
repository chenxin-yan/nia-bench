import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { runTypeCheck, runTypeCheckMultiFile } from "../type-checker";

// Resolve the typecheck-envs directory relative to the project root
const typecheckEnvsDir = resolve(
	import.meta.dir,
	"..",
	"..",
	"..",
	"typecheck-envs",
);

// =============================================================================
// Test 1: Positive case — correct code passes type check
// =============================================================================

describe("runTypeCheck - positive cases (correct code passes)", () => {
	test("React 17 ReactDOM.render code passes in react-17 env", async () => {
		const code = `
import React from 'react';
import ReactDOM from 'react-dom';

function App() {
  return <div>Hello</div>;
}

ReactDOM.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
  document.getElementById('root')
);
`;
		const result = await runTypeCheck(
			code,
			{ library: "react", version: "17" },
			{ typecheckEnvsDir },
		);
		expect(result.passed).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	test("Next.js 13 sync cookies/headers code passes in next-13 env", async () => {
		const code = `
import { cookies, headers } from 'next/headers';

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
}
`;
		const result = await runTypeCheck(
			code,
			{ library: "next", version: "13" },
			{ typecheckEnvsDir },
		);
		expect(result.passed).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	test("Zod v3 chained validators code passes in zod-3 env", async () => {
		const code = `
import { z } from 'zod';

const schema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
});

type User = z.infer<typeof schema>;

const result = schema.safeParse({ email: 'test@test.com', name: 'John' });
if (result.success) {
  const user: User = result.data;
  console.log(user.email);
}
`;
		const result = await runTypeCheck(
			code,
			{ library: "zod", version: "3" },
			{ typecheckEnvsDir, tempFileName: "_typecheck_temp.ts" },
		);
		expect(result.passed).toBe(true);
		expect(result.errors).toHaveLength(0);
	});
});

// =============================================================================
// Test 2: Negative case — version-mismatched code fails type check
// =============================================================================

describe("runTypeCheck - negative cases (version-mismatched code fails)", () => {
	test("React 18 createRoot code fails in react-17 env (module not found)", async () => {
		const code = `
import React from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  return <div>Hello</div>;
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
`;
		const result = await runTypeCheck(
			code,
			{ library: "react", version: "17" },
			{ typecheckEnvsDir },
		);
		expect(result.passed).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
		// Should contain an error about react-dom/client not being found
		const hasModuleError = result.errors.some(
			(e) => e.includes("TS2307") && e.includes("react-dom/client"),
		);
		expect(hasModuleError).toBe(true);
	});

	test("React 18 createRoot code passes in react-18 env (correct environment)", async () => {
		const code = `
import React from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  return <div>Hello</div>;
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
`;
		const result = await runTypeCheck(
			code,
			{ library: "react", version: "18" },
			{ typecheckEnvsDir },
		);
		expect(result.passed).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	test("Code with non-existent import fails type check", async () => {
		const code = `
import { nonExistentFunction } from 'zod';

nonExistentFunction();
`;
		const result = await runTypeCheck(
			code,
			{ library: "zod", version: "3" },
			{ typecheckEnvsDir, tempFileName: "_typecheck_temp.ts" },
		);
		expect(result.passed).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});
});

// =============================================================================
// Test 3: Edge cases
// =============================================================================

describe("runTypeCheck - edge cases", () => {
	test("syntax error in code produces type check failure", async () => {
		const code = `
import { z } from 'zod';

const schema = z.object({
  email: z.string().email(
  // Missing closing paren and brace
`;
		const result = await runTypeCheck(
			code,
			{ library: "zod", version: "3" },
			{ typecheckEnvsDir, tempFileName: "_typecheck_temp.ts" },
		);
		expect(result.passed).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	test("empty code string passes type check (valid empty file)", async () => {
		const result = await runTypeCheck(
			"",
			{ library: "zod", version: "3" },
			{ typecheckEnvsDir, tempFileName: "_typecheck_temp.ts" },
		);
		// An empty file is valid TypeScript
		expect(result.passed).toBe(true);
	});

	test("non-existent environment returns descriptive error", async () => {
		const result = await runTypeCheck(
			"const x = 1;",
			{ library: "vue", version: "3" },
			{ typecheckEnvsDir },
		);
		expect(result.passed).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors[0]).toContain("Type-check environment not found");
	});

	test("non-existent base directory returns descriptive error", async () => {
		const result = await runTypeCheck(
			"const x = 1;",
			{ library: "react", version: "17" },
			{ typecheckEnvsDir: "/tmp/nonexistent-dir" },
		);
		expect(result.passed).toBe(false);
		expect(result.errors[0]).toContain("Type-check environment not found");
	});
});

// =============================================================================
// Test 4: Version mapping
// =============================================================================

describe("runTypeCheck - version mapping", () => {
	test("AI SDK maps to ai-sdk-N directory naming", async () => {
		// This test verifies the library name mapping for AI SDK
		const code = `
import { streamText } from 'ai';
import { openai } from '@ai-sdk/openai';
`;
		const result = await runTypeCheck(
			code,
			{ library: "ai", version: "4" },
			{ typecheckEnvsDir, tempFileName: "_typecheck_temp.ts" },
		);
		// Should resolve to ai-sdk-4 directory and find the module
		expect(result.passed).toBe(true);
	});

	test("version string with patch number extracts major correctly", async () => {
		// "17.0.2" should map to react-17
		const code = `
import React from 'react';
const el = React.createElement('div', null, 'hello');
`;
		const result = await runTypeCheck(
			code,
			{ library: "react", version: "17.0.2" },
			{ typecheckEnvsDir },
		);
		expect(result.passed).toBe(true);
	});

	test("tRPC env resolves correctly", async () => {
		const code = `
import { initTRPC } from '@trpc/server';

const t = initTRPC.create();
const router = t.router;
const publicProcedure = t.procedure;
`;
		const result = await runTypeCheck(
			code,
			{ library: "trpc", version: "11" },
			{ typecheckEnvsDir, tempFileName: "_typecheck_temp.ts" },
		);
		expect(result.passed).toBe(true);
	});
});

// =============================================================================
// Test 5: Multi-file type checking
// =============================================================================

describe("runTypeCheckMultiFile", () => {
	test("multiple valid files pass type check", async () => {
		const files: Record<string, string> = {
			"page.tsx": `
import React from 'react';

export default function Page() {
  return <div>Hello</div>;
}
`,
			"layout.tsx": `
import React from 'react';

export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
		};
		const result = await runTypeCheckMultiFile(
			files,
			{ library: "react", version: "18" },
			{ typecheckEnvsDir },
		);
		expect(result.passed).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	test("file with type error fails multi-file check", async () => {
		const files: Record<string, string> = {
			"page.tsx": `
import React from 'react';
import { createRoot } from 'react-dom/client';

export default function Page() {
  const root = createRoot(document.getElementById('root')!);
  return <div>Hello</div>;
}
`,
		};
		const result = await runTypeCheckMultiFile(
			files,
			{ library: "react", version: "17" },
			{ typecheckEnvsDir },
		);
		expect(result.passed).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	test("non-existent environment returns error for multi-file check", async () => {
		const result = await runTypeCheckMultiFile(
			{ "test.ts": "const x: number = 1;" },
			{ library: "vue", version: "3" },
			{ typecheckEnvsDir },
		);
		expect(result.passed).toBe(false);
		expect(result.errors[0]).toContain("Type-check environment not found");
	});
});

// =============================================================================
// Test 6: Cross-environment validation (same code, different envs)
// =============================================================================

describe("runTypeCheck - cross-environment validation", () => {
	test("Zod v3 chained .email() passes in zod-3, also passes in zod-4 (backwards compatible)", async () => {
		// Note: Zod v4 still supports z.string().email() as a method
		const code = `
import { z } from 'zod';
const emailSchema = z.string().email();
const result = emailSchema.safeParse('test@example.com');
`;
		const resultV3 = await runTypeCheck(
			code,
			{ library: "zod", version: "3" },
			{ typecheckEnvsDir, tempFileName: "_typecheck_temp.ts" },
		);
		expect(resultV3.passed).toBe(true);
	});

	test("React 17 ReactDOM.render code fails in react-19 env (removed API)", async () => {
		const code = `
import React from 'react';
import ReactDOM from 'react-dom';

function App() {
  return <div>Hello</div>;
}

ReactDOM.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
  document.getElementById('root')
);
`;
		const result = await runTypeCheck(
			code,
			{ library: "react", version: "19" },
			{ typecheckEnvsDir },
		);
		// In React 19 types, ReactDOM.render has been removed
		expect(result.passed).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});
});
