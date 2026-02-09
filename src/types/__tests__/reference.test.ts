import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type VersionApiSurface, VersionApiSurfaceSchema } from "../reference";

const REFERENCE_DIR = resolve(import.meta.dirname, "../../../reference");

// Helper: Load all reference JSON files from the reference directory
async function loadAllReferenceFiles(): Promise<
	{ path: string; data: unknown; parsed?: VersionApiSurface }[]
> {
	const results: { path: string; data: unknown; parsed?: VersionApiSurface }[] =
		[];
	const libraryDirs = await readdir(REFERENCE_DIR);

	for (const libDir of libraryDirs) {
		const libPath = join(REFERENCE_DIR, libDir);
		const files = await readdir(libPath);

		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			const filePath = join(libPath, file);
			const content = await readFile(filePath, "utf-8");
			const data = JSON.parse(content);
			const parseResult = VersionApiSurfaceSchema.safeParse(data);

			results.push({
				path: filePath,
				data,
				parsed: parseResult.success ? parseResult.data : undefined,
			});
		}
	}

	return results;
}

// Helper: Get all parsed reference files grouped by library
function groupByLibrary(
	files: { path: string; parsed?: VersionApiSurface }[],
): Record<string, VersionApiSurface[]> {
	const groups: Record<string, VersionApiSurface[]> = {};
	for (const file of files) {
		if (!file.parsed) continue;
		const lib = file.parsed.library;
		if (!groups[lib]) groups[lib] = [];
		groups[lib].push(file.parsed);
	}
	return groups;
}

describe("Reference JSON Schema Validation", () => {
	it("should find all 14 reference files", async () => {
		const files = await loadAllReferenceFiles();
		expect(files.length).toBe(14);
	});

	it("should parse all reference files against the Zod schema", async () => {
		const files = await loadAllReferenceFiles();

		for (const file of files) {
			const result = VersionApiSurfaceSchema.safeParse(file.data);
			if (!result.success) {
				console.error(`Schema validation failed for: ${file.path}`);
				console.error(result.error.format());
			}
			expect(result.success).toBe(true);
		}
	});

	it("should cover all expected libraries", async () => {
		const files = await loadAllReferenceFiles();
		const libraries = new Set(
			files.filter((f) => f.parsed).map((f) => f.parsed?.library),
		);
		expect(libraries).toContain("next");
		expect(libraries).toContain("react");
		expect(libraries).toContain("ai");
		expect(libraries).toContain("trpc");
		expect(libraries).toContain("zod");
		expect(libraries.size).toBe(5);
	});

	it("should have correct number of versions per library", async () => {
		const files = await loadAllReferenceFiles();
		const grouped = groupByLibrary(files);

		expect(grouped.next?.length).toBe(4); // v13, v14, v15, v16
		expect(grouped.react?.length).toBe(3); // v17, v18, v19
		expect(grouped.ai?.length).toBe(3); // v3, v4, v5
		expect(grouped.trpc?.length).toBe(2); // v10, v11
		expect(grouped.zod?.length).toBe(2); // v3, v4
	});

	it("should have unique version strings within each library", async () => {
		const files = await loadAllReferenceFiles();
		const grouped = groupByLibrary(files);

		for (const [lib, versions] of Object.entries(grouped)) {
			const versionStrings = versions.map((v) => v.version);
			const uniqueVersions = new Set(versionStrings);
			expect(
				uniqueVersions.size,
				`Duplicate versions in ${lib}: ${versionStrings.join(", ")}`,
			).toBe(versionStrings.length);
		}
	});
});

describe("Cross-Version Consistency Checks", () => {
	it("Next.js: sync_apis and async_apis should not overlap within a version", async () => {
		const files = await loadAllReferenceFiles();
		const nextVersions = files
			.filter(
				(f): f is typeof f & { parsed: VersionApiSurface } =>
					f.parsed?.library === "next",
			)
			.map((f) => f.parsed);

		for (const version of nextVersions) {
			const overlap = version.sync_apis.filter((api) =>
				version.async_apis.includes(api),
			);
			expect(
				overlap,
				`Next.js v${version.version} has overlapping sync/async APIs: ${overlap.join(", ")}`,
			).toEqual([]);
		}
	});

	it("Next.js v13/v14: cookies and headers should be sync, not async", async () => {
		const files = await loadAllReferenceFiles();

		for (const ver of ["13", "14"]) {
			const ref = files.find(
				(f) => f.parsed?.library === "next" && f.parsed?.version === ver,
			)?.parsed;
			expect(ref).toBeDefined();
			expect(ref?.sync_apis).toContain("cookies");
			expect(ref?.sync_apis).toContain("headers");
			expect(ref?.async_apis).not.toContain("cookies");
			expect(ref?.async_apis).not.toContain("headers");
		}
	});

	it("Next.js v15/v16: cookies and headers should be async, not sync", async () => {
		const files = await loadAllReferenceFiles();

		for (const ver of ["15", "16"]) {
			const ref = files.find(
				(f) => f.parsed?.library === "next" && f.parsed?.version === ver,
			)?.parsed;
			expect(ref).toBeDefined();
			expect(ref?.async_apis).toContain("cookies");
			expect(ref?.async_apis).toContain("headers");
			expect(ref?.sync_apis).not.toContain("cookies");
			expect(ref?.sync_apis).not.toContain("headers");
		}
	});

	it("Next.js v13/v14: params should be direct, v15/v16: promise", async () => {
		const files = await loadAllReferenceFiles();

		for (const ver of ["13", "14"]) {
			const ref = files.find(
				(f) => f.parsed?.library === "next" && f.parsed?.version === ver,
			)?.parsed;
			expect(ref?.params_type).toBe("direct");
		}

		for (const ver of ["15", "16"]) {
			const ref = files.find(
				(f) => f.parsed?.library === "next" && f.parsed?.version === ver,
			)?.parsed;
			expect(ref?.params_type).toBe("promise");
		}
	});

	it("Next.js v13-v15: uses middleware.ts, v16: uses proxy.ts", async () => {
		const files = await loadAllReferenceFiles();

		for (const ver of ["13", "14", "15"]) {
			const ref = files.find(
				(f) => f.parsed?.library === "next" && f.parsed?.version === ver,
			)?.parsed;
			expect(ref?.proxy_file).toBe("middleware.ts");
			expect(ref?.proxy_function).toBe("middleware");
		}

		const v16 = files.find(
			(f) => f.parsed?.library === "next" && f.parsed?.version === "16",
		)?.parsed;
		expect(v16?.proxy_file).toBe("proxy.ts");
		expect(v16?.proxy_function).toBe("proxy");
	});

	it("Next.js v16: cacheTag, cacheLife, updateTag should be available, not in v13/v14", async () => {
		const files = await loadAllReferenceFiles();

		const v16 = files.find(
			(f) => f.parsed?.library === "next" && f.parsed?.version === "16",
		)?.parsed;
		const cacheImports = v16?.available_imports["next/cache"] ?? [];
		expect(cacheImports).toContain("cacheTag");
		expect(cacheImports).toContain("cacheLife");
		expect(cacheImports).toContain("updateTag");

		for (const ver of ["13", "14"]) {
			const ref = files.find(
				(f) => f.parsed?.library === "next" && f.parsed?.version === ver,
			)?.parsed;
			const unavailable = ref?.unavailable_apis;
			expect(unavailable).toContain("cacheTag");
			expect(unavailable).toContain("cacheLife");
			expect(unavailable).toContain("updateTag");
		}
	});

	it("React: use() hook should be available in v19, unavailable in v17/v18", async () => {
		const files = await loadAllReferenceFiles();

		const v19 = files.find(
			(f) => f.parsed?.library === "react" && f.parsed?.version === "19",
		)?.parsed;
		expect(v19?.available_hooks).toContain("use");

		for (const ver of ["17", "18"]) {
			const ref = files.find(
				(f) => f.parsed?.library === "react" && f.parsed?.version === ver,
			)?.parsed;
			expect(ref?.unavailable_hooks).toContain("use");
			expect(ref?.available_hooks).not.toContain("use");
		}
	});

	it("React: useActionState should be available in v19, unavailable in v17/v18", async () => {
		const files = await loadAllReferenceFiles();

		const v19 = files.find(
			(f) => f.parsed?.library === "react" && f.parsed?.version === "19",
		)?.parsed;
		expect(v19?.available_hooks).toContain("useActionState");

		for (const ver of ["17", "18"]) {
			const ref = files.find(
				(f) => f.parsed?.library === "react" && f.parsed?.version === ver,
			)?.parsed;
			expect(ref?.unavailable_hooks).toContain("useActionState");
		}
	});

	it("React: useId should be available in v18/v19, unavailable in v17", async () => {
		const files = await loadAllReferenceFiles();

		const v17 = files.find(
			(f) => f.parsed?.library === "react" && f.parsed?.version === "17",
		)?.parsed;
		expect(v17?.unavailable_hooks).toContain("useId");
		expect(v17?.available_hooks).not.toContain("useId");

		for (const ver of ["18", "19"]) {
			const ref = files.find(
				(f) => f.parsed?.library === "react" && f.parsed?.version === ver,
			)?.parsed;
			expect(ref?.available_hooks).toContain("useId");
		}
	});

	it("React v17: should use ReactDOM.render, v18/v19: should use createRoot", async () => {
		const files = await loadAllReferenceFiles();

		const v17 = files.find(
			(f) => f.parsed?.library === "react" && f.parsed?.version === "17",
		)?.parsed;
		expect(v17?.rendering?.entry_api).toBe("ReactDOM.render");
		expect(v17?.rendering?.import_path).toBe("react-dom");

		for (const ver of ["18", "19"]) {
			const ref = files.find(
				(f) => f.parsed?.library === "react" && f.parsed?.version === ver,
			)?.parsed;
			expect(ref?.rendering?.entry_api).toBe("createRoot");
			expect(ref?.rendering?.import_path).toBe("react-dom/client");
		}
	});

	it("AI SDK v3: should have experimental_ prefix, v4/v5: should not", async () => {
		const files = await loadAllReferenceFiles();

		const v3 = files.find(
			(f) => f.parsed?.library === "ai" && f.parsed?.version === "3",
		)?.parsed;
		expect(v3?.async_apis).toContain("experimental_streamText");
		const v3Imports = v3?.available_imports.ai ?? [];
		expect(v3Imports).toContain("experimental_streamText");

		for (const ver of ["4", "5"]) {
			const ref = files.find(
				(f) => f.parsed?.library === "ai" && f.parsed?.version === ver,
			)?.parsed;
			const imports = ref?.available_imports.ai ?? [];
			expect(imports).toContain("streamText");
			expect(imports).not.toContain("experimental_streamText");
		}
	});

	it("AI SDK v4: streamText should be sync, v3: should be async", async () => {
		const files = await loadAllReferenceFiles();

		const v3 = files.find(
			(f) => f.parsed?.library === "ai" && f.parsed?.version === "3",
		)?.parsed;
		expect(v3?.async_apis).toContain("experimental_streamText");

		const v4 = files.find(
			(f) => f.parsed?.library === "ai" && f.parsed?.version === "4",
		)?.parsed;
		expect(v4?.sync_apis).toContain("streamText");
		expect(v4?.async_apis).not.toContain("streamText");
	});

	it("AI SDK v5: should have createUIMessageStream, v3/v4: should not", async () => {
		const files = await loadAllReferenceFiles();

		const v5 = files.find(
			(f) => f.parsed?.library === "ai" && f.parsed?.version === "5",
		)?.parsed;
		const v5Imports = v5?.available_imports.ai ?? [];
		expect(v5Imports).toContain("createUIMessageStream");
		expect(v5Imports).toContain("createUIMessageStreamResponse");

		for (const ver of ["3", "4"]) {
			const ref = files.find(
				(f) => f.parsed?.library === "ai" && f.parsed?.version === ver,
			)?.parsed;
			const unavailable = ref?.unavailable_apis ?? [];
			const hasUnavailable = unavailable.some((api) =>
				api.includes("createUIMessageStream"),
			);
			expect(
				hasUnavailable,
				`AI SDK v${ver} should list createUIMessageStream as unavailable`,
			).toBe(true);
		}
	});

	it("tRPC v10: createTRPCProxyClient, v11: createTRPCClient", async () => {
		const files = await loadAllReferenceFiles();

		const v10 = files.find(
			(f) => f.parsed?.library === "trpc" && f.parsed?.version === "10",
		)?.parsed;
		const v10Imports = v10?.available_imports["@trpc/client"] ?? [];
		expect(v10Imports).toContain("createTRPCProxyClient");
		expect(v10Imports).not.toContain("createTRPCClient");

		const v11 = files.find(
			(f) => f.parsed?.library === "trpc" && f.parsed?.version === "11",
		)?.parsed;
		const v11Imports = v11?.available_imports["@trpc/client"] ?? [];
		expect(v11Imports).toContain("createTRPCClient");
		expect(v11Imports).not.toContain("createTRPCProxyClient");
	});

	it("tRPC v10: createProxySSGHelpers, v11: renamed", async () => {
		const files = await loadAllReferenceFiles();

		const v10 = files.find(
			(f) => f.parsed?.library === "trpc" && f.parsed?.version === "10",
		)?.parsed;
		const v10SsgImports = v10?.available_imports["@trpc/react-query/ssg"] ?? [];
		expect(v10SsgImports).toContain("createProxySSGHelpers");

		const v11 = files.find(
			(f) => f.parsed?.library === "trpc" && f.parsed?.version === "11",
		)?.parsed;
		const v11Unavailable = v11?.unavailable_apis ?? [];
		const hasRenamedSsg = v11Unavailable.some((api) =>
			api.includes("createProxySSGHelpers"),
		);
		expect(hasRenamedSsg).toBe(true);
	});

	it("Zod v3: z.string().email() pattern, v4: z.email() pattern", async () => {
		const files = await loadAllReferenceFiles();

		const v3 = files.find(
			(f) => f.parsed?.library === "zod" && f.parsed?.version === "3",
		)?.parsed;
		// v3 should list top-level validators as unavailable
		const v3Unavailable = v3?.unavailable_apis ?? [];
		expect(v3Unavailable.some((api) => api.includes("z.email()"))).toBe(true);

		const v4 = files.find(
			(f) => f.parsed?.library === "zod" && f.parsed?.version === "4",
		)?.parsed;
		// v4 should list chained validators as unavailable/deprecated
		const v4Unavailable = v4?.unavailable_apis ?? [];
		expect(
			v4Unavailable.some((api) => api.includes("z.string().email()")),
		).toBe(true);
	});

	it("Zod v3: required_error/invalid_type_error available, v4: removed", async () => {
		const files = await loadAllReferenceFiles();

		const v3 = files.find(
			(f) => f.parsed?.library === "zod" && f.parsed?.version === "3",
		)?.parsed;
		const v3Features = v3?.key_features ?? [];
		expect(v3Features.some((f) => f.includes("required_error"))).toBe(true);

		const v4 = files.find(
			(f) => f.parsed?.library === "zod" && f.parsed?.version === "4",
		)?.parsed;
		const v4Unavailable = v4?.unavailable_apis ?? [];
		expect(v4Unavailable.some((api) => api.includes("required_error"))).toBe(
			true,
		);
		expect(
			v4Unavailable.some((api) => api.includes("invalid_type_error")),
		).toBe(true);
	});
});

describe("No Contradictions Within Versions", () => {
	it("no API should be both available and unavailable within the same version", async () => {
		const files = await loadAllReferenceFiles();

		for (const file of files) {
			if (!file.parsed) continue;
			const ref = file.parsed;

			// Collect all available API names (normalized)
			const availableSet = new Set<string>();

			// From available_imports
			for (const [, exports] of Object.entries(ref.available_imports)) {
				for (const exp of exports) {
					if (exp !== "*") availableSet.add(exp);
				}
			}

			// From available_hooks
			for (const hook of ref.available_hooks) {
				availableSet.add(hook);
			}

			// From available_types
			for (const type of ref.available_types) {
				availableSet.add(type);
			}

			// From sync_apis and async_apis
			for (const api of ref.sync_apis) availableSet.add(api);
			for (const api of ref.async_apis) availableSet.add(api);

			// Check that unavailable APIs (normalized simple name) don't appear in available
			for (const unavailableEntry of ref.unavailable_apis) {
				// Extract the simple API name (before parenthetical notes)
				const simpleName = (unavailableEntry.split(" ")[0] ?? "").replace(
					/[()]/g,
					"",
				);
				// Skip entries with complex descriptions that aren't simple API names
				if (simpleName.includes(".") || simpleName.includes("/")) continue;
				if (simpleName.length === 0) continue;

				if (availableSet.has(simpleName)) {
					// Check for false positives — some entries are descriptions, not raw API names
					const isDescription =
						unavailableEntry.includes("renamed") ||
						unavailableEntry.includes("use ") ||
						unavailableEntry.includes("removed") ||
						unavailableEntry.includes("deprecated");
					if (!isDescription) {
						throw new Error(
							`${ref.library} v${ref.version}: '${simpleName}' is both available and unavailable. Entry: "${unavailableEntry}"`,
						);
					}
				}
			}

			// Check unavailable_hooks don't overlap with available_hooks
			for (const hook of ref.unavailable_hooks) {
				// Extract simple hook name
				const simpleHook = (hook.split(" ")[0] ?? "").replace(/[()]/g, "");
				expect(
					ref.available_hooks.includes(simpleHook),
					`${ref.library} v${ref.version}: hook '${simpleHook}' is both available and unavailable`,
				).toBe(false);
			}
		}
	});

	it("sync_apis and async_apis should not overlap within any version", async () => {
		const files = await loadAllReferenceFiles();

		for (const file of files) {
			if (!file.parsed) continue;
			const ref = file.parsed;
			const overlap = ref.sync_apis.filter((api) =>
				ref.async_apis.includes(api),
			);
			expect(
				overlap.length,
				`${ref.library} v${ref.version}: sync/async overlap: ${overlap.join(", ")}`,
			).toBe(0);
		}
	});
});

describe("Spot-Check Accuracy", () => {
	// Verified against official Next.js documentation via Nia search:
	// - Next.js 15 upgrade guide confirms cookies/headers became async
	// - Next.js 16 docs confirm proxy.ts rename and cacheTag/cacheLife stabilization
	// - Official Next.js migration codemods confirm these breaking changes
	it("Next.js v15: after() should be available from next/server", async () => {
		const files = await loadAllReferenceFiles();
		const v15 = files.find(
			(f) => f.parsed?.library === "next" && f.parsed?.version === "15",
		)?.parsed;
		const serverImports = v15?.available_imports["next/server"] ?? [];
		expect(serverImports).toContain("after");
	});

	it("Next.js v13: after() should be unavailable", async () => {
		const files = await loadAllReferenceFiles();
		const v13 = files.find(
			(f) => f.parsed?.library === "next" && f.parsed?.version === "13",
		)?.parsed;
		expect(v13?.unavailable_apis).toContain("after");
	});

	// Verified against official React 19 blog post and upgrade guide via Nia search:
	// - React 19 confirms use() hook, useActionState, ref as prop
	// - React 19 confirms ReactDOM.render removal, forwardRef deprecation
	// - React 18 confirms useId, useTransition, useDeferredValue, createRoot introduction
	it("React v19: forwardRef should be in breaking_changes as deprecated", async () => {
		const files = await loadAllReferenceFiles();
		const v19 = files.find(
			(f) => f.parsed?.library === "react" && f.parsed?.version === "19",
		)?.parsed;
		const hasForwardRefBreaking = v19?.breaking_changes.some((change) =>
			change.toLowerCase().includes("forwardref"),
		);
		expect(hasForwardRefBreaking).toBe(true);
	});

	it("React v17: forwardRef should be available, not deprecated", async () => {
		const files = await loadAllReferenceFiles();
		const v17 = files.find(
			(f) => f.parsed?.library === "react" && f.parsed?.version === "17",
		)?.parsed;
		const imports = v17?.available_imports.react ?? [];
		expect(imports).toContain("forwardRef");
	});

	// Verified against Zod v4 changelog and migration guide via Nia search:
	// - z.string().ip() removed in v4, replaced by z.ipv4()/z.ipv6()
	// - required_error and invalid_type_error removed in v4
	// - .deepPartial() removed in v4
	it("Zod v3: z.string().ip() should be in key_features", async () => {
		const files = await loadAllReferenceFiles();
		const v3 = files.find(
			(f) => f.parsed?.library === "zod" && f.parsed?.version === "3",
		)?.parsed;
		const hasIpFeature = v3?.key_features.some((f) => f.includes(".ip()"));
		expect(hasIpFeature).toBe(true);
	});

	it("Zod v4: .deepPartial() should be in removed_from_previous", async () => {
		const files = await loadAllReferenceFiles();
		const v4 = files.find(
			(f) => f.parsed?.library === "zod" && f.parsed?.version === "4",
		)?.parsed;
		const hasDeepPartialRemoved = v4?.removed_from_previous.some((r) =>
			r.includes("deepPartial"),
		);
		expect(hasDeepPartialRemoved).toBe(true);
	});

	// Verified against tRPC v10/v11 migration guide via Nia search:
	// - createTRPCProxyClient renamed to createTRPCClient in v11
	// - Transformer moved from client to link level in v11
	// - rawInput replaced by getRawInput() in v11
	it("tRPC v11: httpSubscriptionLink should be available", async () => {
		const files = await loadAllReferenceFiles();
		const v11 = files.find(
			(f) => f.parsed?.library === "trpc" && f.parsed?.version === "11",
		)?.parsed;
		const clientImports = v11?.available_imports["@trpc/client"] ?? [];
		expect(clientImports).toContain("httpSubscriptionLink");
	});

	it("tRPC v10: httpSubscriptionLink should be unavailable", async () => {
		const files = await loadAllReferenceFiles();
		const v10 = files.find(
			(f) => f.parsed?.library === "trpc" && f.parsed?.version === "10",
		)?.parsed;
		const hasUnavailable = v10?.unavailable_apis.some((api) =>
			api.includes("httpSubscriptionLink"),
		);
		expect(hasUnavailable).toBe(true);
	});
});
