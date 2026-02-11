import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Task } from "@/types/task";
import { AsyncSemaphore, formatDuration } from "./orchestrator";

// --- Constants ---

const NIA_BASE_URL = "https://apigcp.trynia.ai/v2";

/** Default overall timeout for the setup phase (10 minutes). */
const DEFAULT_MAX_WAIT_TIME = 600_000;

/** How often to poll for indexing completion (15 seconds). */
const DEFAULT_POLL_INTERVAL = 15_000;

/** Default concurrent indexing operations. */
const DEFAULT_PARALLEL = 3;

/** Default page limit when indexing documentation sites. */
const DEFAULT_DOC_LIMIT = 1000;

// --- Types ---

/**
 * Represents a single Nia source (repo or docs) that should be indexed
 * before running the benchmark.
 */
export interface NiaIndexTarget {
	/** Whether this is a GitHub repository or a documentation site. */
	type: "repo" | "docs";
	/** Repository path (owner/repo) or documentation URL. */
	identifier: string;
	/** Branch, tag, or commit ref for repositories. */
	branch?: string;
	/** Human-readable name for the indexed source. */
	displayName: string;
	/** Comma-separated URL patterns for docs indexing scope. */
	urlPatterns?: string;
	/** AI focus instruction for the crawler. */
	focus?: string;
}

/**
 * Options for the Nia setup phase.
 */
export interface NiaSetupOptions {
	/** Overall timeout for the entire setup phase in ms (default: 600_000). */
	maxWaitTime?: number;
	/** How often to poll for indexing completion in ms (default: 15_000). */
	pollInterval?: number;
	/** Max concurrent indexing operations (default: 3). */
	parallel?: number;
}

/**
 * Minimal shape of a Nia source from the API.
 * The actual API returns more fields; we only parse what we need.
 */
interface NiaSourceResponse {
	id?: string;
	status?: string;
	progress?: number | null;
	display_name?: string;
	error?: string;
	message?: string;
}

// --- Version → Target Mapping ---

/**
 * Static mapping from `{library}:{majorVersion}` to the Nia index targets
 * (repos + docs) required for that library version.
 *
 * The major version is extracted from the task's `target_version` field
 * (e.g. "19.0.0" → "19", "4.2.0" → "4").
 *
 * Repos use specific tags/branches so the agent can search version-accurate
 * source code. Docs use the canonical documentation site for that era.
 */
const VERSION_TARGETS: Record<string, NiaIndexTarget[]> = {
	// ─── React ───────────────────────────────────────────────────────────────
	"react:17": [
		{
			type: "repo",
			identifier: "facebook/react",
			branch: "17.0.2",
			displayName: "React v17",
		},
		{
			type: "docs",
			identifier: "https://legacy.reactjs.org",
			displayName: "React Legacy Docs",
		},
	],
	"react:18": [
		{
			type: "repo",
			identifier: "facebook/react",
			branch: "18.3.1",
			displayName: "React v18",
		},
		{
			type: "docs",
			identifier: "https://legacy.reactjs.org",
			displayName: "React Legacy Docs",
		},
	],
	"react:19": [
		{
			type: "repo",
			identifier: "facebook/react",
			branch: "main",
			displayName: "React v19",
		},
		{
			type: "docs",
			identifier: "https://react.dev",
			displayName: "React Docs",
		},
	],

	// ─── Next.js ─────────────────────────────────────────────────────────────
	"next:13": [
		{
			type: "repo",
			identifier: "vercel/next.js",
			branch: "v13.5.7",
			displayName: "Next.js v13",
		},
		{
			type: "docs",
			identifier: "https://nextjs.org/docs",
			displayName: "Next.js Docs",
		},
	],
	"next:14": [
		{
			type: "repo",
			identifier: "vercel/next.js",
			branch: "v14.2.28",
			displayName: "Next.js v14",
		},
		{
			type: "docs",
			identifier: "https://nextjs.org/docs",
			displayName: "Next.js Docs",
		},
	],
	"next:15": [
		{
			type: "repo",
			identifier: "vercel/next.js",
			branch: "v15.3.3",
			displayName: "Next.js v15",
		},
		{
			type: "docs",
			identifier: "https://nextjs.org/docs",
			displayName: "Next.js Docs",
		},
	],
	"next:16": [
		{
			type: "repo",
			identifier: "vercel/next.js",
			branch: "canary",
			displayName: "Next.js v16 (canary)",
		},
		{
			type: "docs",
			identifier: "https://nextjs.org/docs",
			displayName: "Next.js Docs",
		},
	],

	// ─── Vercel AI SDK ───────────────────────────────────────────────────────
	"ai:3": [
		{
			type: "repo",
			identifier: "vercel/ai",
			branch: "v3.4.33",
			displayName: "Vercel AI SDK v3",
		},
		{
			type: "docs",
			identifier: "https://ai-sdk.dev/docs",
			displayName: "Vercel AI SDK Docs",
		},
	],
	"ai:4": [
		{
			type: "repo",
			identifier: "vercel/ai",
			branch: "v4.2.2",
			displayName: "Vercel AI SDK v4",
		},
		{
			type: "docs",
			identifier: "https://ai-sdk.dev/docs",
			displayName: "Vercel AI SDK Docs",
		},
	],
	"ai:5": [
		{
			type: "repo",
			identifier: "vercel/ai",
			branch: "main",
			displayName: "Vercel AI SDK v5",
		},
		{
			type: "docs",
			identifier: "https://ai-sdk.dev/docs",
			displayName: "Vercel AI SDK Docs",
		},
	],

	// ─── tRPC ────────────────────────────────────────────────────────────────
	"trpc:10": [
		{
			type: "repo",
			identifier: "trpc/trpc",
			branch: "v10",
			displayName: "tRPC v10",
		},
		{
			type: "docs",
			identifier: "https://trpc.io/docs",
			displayName: "tRPC Docs",
		},
	],
	"trpc:11": [
		{
			type: "repo",
			identifier: "trpc/trpc",
			branch: "main",
			displayName: "tRPC v11",
		},
		{
			type: "docs",
			identifier: "https://trpc.io/docs",
			displayName: "tRPC Docs",
		},
	],

	// ─── Zod ─────────────────────────────────────────────────────────────────
	"zod:3": [
		{
			type: "repo",
			identifier: "colinhacks/zod",
			branch: "v3.24.4",
			displayName: "Zod v3",
		},
		{
			type: "docs",
			identifier: "https://zod.dev",
			displayName: "Zod Docs",
		},
	],
	"zod:4": [
		{
			type: "repo",
			identifier: "colinhacks/zod",
			branch: "main",
			displayName: "Zod v4",
		},
		{
			type: "docs",
			identifier: "https://zod.dev",
			displayName: "Zod Docs",
		},
	],
};

// --- API Key Resolution ---

/**
 * Resolves the Nia API key from the environment or config file.
 *
 * Resolution order:
 * 1. `NIA_API_KEY` environment variable
 * 2. `~/.config/nia/api_key` file
 *
 * @throws {Error} if no API key is found
 */
export async function resolveNiaApiKey(): Promise<string> {
	// 1. Environment variable
	const envKey = process.env.NIA_API_KEY;
	if (envKey) return envKey.trim();

	// 2. Config file
	try {
		const configPath = join(homedir(), ".config", "nia", "api_key");
		const fileKey = await readFile(configPath, "utf-8");
		const trimmed = fileKey.trim();
		if (trimmed) return trimmed;
	} catch {
		// File doesn't exist or is unreadable — fall through
	}

	throw new Error(
		"No Nia API key found. Set NIA_API_KEY env variable or run: npx nia-wizard@latest",
	);
}

// --- Target Derivation ---

/**
 * Derives the set of Nia index targets required by the given tasks.
 *
 * Extracts unique `(library, majorVersion)` pairs from the tasks, looks up
 * the corresponding targets in `VERSION_TARGETS`, and deduplicates by
 * `type + identifier + branch` so shared sources (e.g. legacy.reactjs.org
 * used by both React 17 and 18) are only indexed once.
 */
export function getTargetsForTasks(tasks: Task[]): NiaIndexTarget[] {
	// Collect unique library:majorVersion keys
	const keys = new Set<string>();
	for (const task of tasks) {
		const major = task.target_version.split(".")[0];
		const key = `${task.library}:${major}`;
		keys.add(key);
	}

	// Gather all targets, then deduplicate
	const all: NiaIndexTarget[] = [];
	for (const key of keys) {
		const targets = VERSION_TARGETS[key];
		if (targets) {
			all.push(...targets);
		} else {
			console.warn(`  ⚠ No Nia targets defined for ${key}`);
		}
	}

	// Deduplicate by (type, identifier, branch)
	const seen = new Set<string>();
	const unique: NiaIndexTarget[] = [];
	for (const target of all) {
		const dedupeKey = `${target.type}:${target.identifier}:${target.branch ?? ""}`;
		if (!seen.has(dedupeKey)) {
			seen.add(dedupeKey);
			unique.push(target);
		}
	}

	return unique;
}

// --- Nia API Helpers ---

/**
 * Makes an authenticated request to the Nia API.
 */
async function niaFetch(
	apiKey: string,
	method: string,
	path: string,
	body?: Record<string, unknown>,
): Promise<NiaSourceResponse> {
	const url = `${NIA_BASE_URL}${path}`;
	const headers: Record<string, string> = {
		Authorization: `Bearer ${apiKey}`,
	};
	const init: RequestInit = { method, headers };

	if (body) {
		headers["Content-Type"] = "application/json";
		init.body = JSON.stringify(body);
	}

	const res = await fetch(url, init);

	// For 404s, return a "not found" marker instead of throwing
	if (res.status === 404) {
		return { status: "not_found" };
	}

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`Nia API ${method} ${path}: ${res.status} ${text}`);
	}

	return (await res.json()) as NiaSourceResponse;
}

// --- Status Checking ---

/**
 * Status result for a single Nia source.
 */
interface SourceStatus {
	/** Whether the source is fully indexed and ready to search. */
	indexed: boolean;
	/** Whether the source is currently being indexed. */
	indexing: boolean;
	/** Raw status string from the API. */
	rawStatus: string;
}

/**
 * Checks whether a repository is indexed in Nia.
 *
 * Uses `GET /repositories/{owner%2Frepo}` to fetch the repo metadata.
 * The `status` field indicates the indexing state.
 */
export async function checkRepoStatus(
	apiKey: string,
	ownerRepo: string,
): Promise<SourceStatus> {
	const encoded = ownerRepo.replace("/", "%2F");
	try {
		const data = await niaFetch(apiKey, "GET", `/repositories/${encoded}`);
		const status = data.status ?? "unknown";
		return {
			indexed: status === "indexed",
			indexing:
				status === "indexing" || status === "queued" || status === "processing",
			rawStatus: status,
		};
	} catch {
		return { indexed: false, indexing: false, rawStatus: "error" };
	}
}

/**
 * Checks whether a documentation source is indexed in Nia.
 *
 * This is a two-step process because the resolve endpoint only returns
 * `{id, type, display_name, identifier}` without a `status` field:
 * 1. `GET /sources/resolve?identifier={url}` → resolves the source ID
 * 2. `GET /sources/{id}` → fetches full details including `status`
 *
 * Returns indexed=true when status is "completed".
 */
export async function checkDocStatus(
	apiKey: string,
	url: string,
): Promise<SourceStatus> {
	const encoded = encodeURIComponent(url);
	try {
		// Step 1: resolve URL to source ID
		const resolved = await niaFetch(
			apiKey,
			"GET",
			`/sources/resolve?identifier=${encoded}`,
		);

		if (resolved.status === "not_found" || !resolved.id) {
			return { indexed: false, indexing: false, rawStatus: "not_found" };
		}

		// Step 2: fetch full details by ID to get status
		const detail = await niaFetch(apiKey, "GET", `/sources/${resolved.id}`);
		const status = detail.status ?? "unknown";
		return {
			indexed: status === "completed",
			indexing:
				status === "indexing" || status === "queued" || status === "processing",
			rawStatus: status,
		};
	} catch {
		return { indexed: false, indexing: false, rawStatus: "error" };
	}
}

/**
 * Checks the current status of a target (dispatches to repo or doc check).
 */
async function checkTargetStatus(
	apiKey: string,
	target: NiaIndexTarget,
): Promise<SourceStatus> {
	if (target.type === "repo") {
		return checkRepoStatus(apiKey, target.identifier);
	}
	return checkDocStatus(apiKey, target.identifier);
}

// --- Indexing ---

/**
 * Starts indexing a repository in Nia.
 *
 * Calls `POST /sources` with `type: "repository"`. The Nia API queues the
 * indexing job and returns immediately. Use `checkRepoStatus()` or
 * `pollUntilReady()` to monitor completion.
 */
async function indexRepo(
	apiKey: string,
	target: NiaIndexTarget,
): Promise<void> {
	const body: Record<string, unknown> = {
		type: "repository",
		repository: target.identifier,
	};
	if (target.branch) body.ref = target.branch;
	if (target.displayName) body.display_name = target.displayName;

	await niaFetch(apiKey, "POST", "/sources", body);
}

/**
 * Starts indexing a documentation site in Nia.
 *
 * Calls `POST /sources` with `type: "documentation"`. Supports optional
 * URL pattern filtering and AI focus instructions via the target config.
 */
async function indexDocs(
	apiKey: string,
	target: NiaIndexTarget,
): Promise<void> {
	const body: Record<string, unknown> = {
		type: "documentation",
		url: target.identifier,
		limit: DEFAULT_DOC_LIMIT,
		only_main_content: true,
	};
	if (target.displayName) body.display_name = target.displayName;
	if (target.urlPatterns) {
		body.url_patterns = target.urlPatterns.split(",");
	}
	if (target.focus) body.focus_instructions = target.focus;

	await niaFetch(apiKey, "POST", "/sources", body);
}

/**
 * Starts indexing a target (dispatches to repo or docs indexing).
 */
async function indexTarget(
	apiKey: string,
	target: NiaIndexTarget,
): Promise<void> {
	if (target.type === "repo") {
		await indexRepo(apiKey, target);
	} else {
		await indexDocs(apiKey, target);
	}
}

// --- Polling ---

/**
 * Polls a target until it reaches "indexed"/"completed" status or the
 * deadline is exceeded.
 *
 * @param apiKey - Nia API key
 * @param target - The target to poll
 * @param pollInterval - Interval between polls in ms
 * @param deadline - Absolute timestamp (Date.now() + maxWaitTime) to stop polling
 * @throws {Error} if the deadline is exceeded
 */
async function pollUntilReady(
	apiKey: string,
	target: NiaIndexTarget,
	pollInterval: number,
	deadline: number,
): Promise<void> {
	while (Date.now() < deadline) {
		const status = await checkTargetStatus(apiKey, target);

		if (status.indexed) {
			return;
		}

		if (!status.indexing && status.rawStatus !== "queued") {
			// Unexpected terminal state (e.g. "failed", "error")
			throw new Error(
				`${target.displayName}: indexing ended with status "${status.rawStatus}"`,
			);
		}

		// Wait before next poll
		const remaining = deadline - Date.now();
		const wait = Math.min(pollInterval, remaining);
		if (wait <= 0) break;
		await new Promise((r) => setTimeout(r, wait));
	}

	throw new Error(
		`${target.displayName}: timed out waiting for indexing to complete`,
	);
}

// --- Main Entry Point ---

/**
 * Ensures all Nia sources required by the loaded tasks are indexed and ready.
 *
 * This function is the main entry point for the Nia setup phase. It:
 * 1. Resolves the Nia API key
 * 2. Derives required targets from the task list
 * 3. Checks which targets are already indexed
 * 4. Starts indexing any missing targets (with concurrency control)
 * 5. Waits for all indexing (new + already in-progress) to complete
 *
 * If a target fails to index, a warning is logged but other targets continue.
 * The function only throws if the API key is missing or a fatal error occurs.
 *
 * @param tasks - Loaded benchmark tasks (used to derive required targets)
 * @param options - Setup options (timeouts, concurrency)
 */
export async function ensureNiaSetup(
	tasks: Task[],
	options: NiaSetupOptions = {},
): Promise<void> {
	const maxWaitTime = options.maxWaitTime ?? DEFAULT_MAX_WAIT_TIME;
	const pollInterval = options.pollInterval ?? DEFAULT_POLL_INTERVAL;
	const parallel = options.parallel ?? DEFAULT_PARALLEL;

	// Step 1: Resolve API key
	const apiKey = await resolveNiaApiKey();

	// Step 2: Derive targets from tasks
	const targets = getTargetsForTasks(tasks);
	if (targets.length === 0) {
		console.log("  No Nia targets needed for the selected tasks.");
		return;
	}

	console.log(
		`  Checking ${targets.length} source(s) needed for the selected tasks...`,
	);

	// Step 3: Check status of all targets (parallel)
	const statusChecks = await Promise.all(
		targets.map(async (target) => {
			const status = await checkTargetStatus(apiKey, target);
			return { target, status };
		}),
	);

	// Partition into categories
	const alreadyIndexed: NiaIndexTarget[] = [];
	const inProgress: NiaIndexTarget[] = [];
	const needsIndexing: NiaIndexTarget[] = [];

	for (const { target, status } of statusChecks) {
		if (status.indexed) {
			alreadyIndexed.push(target);
			console.log(`  ✓ ${target.displayName} (indexed)`);
		} else if (status.indexing) {
			inProgress.push(target);
			console.log(`  ↻ ${target.displayName} (indexing in progress)`);
		} else {
			needsIndexing.push(target);
			console.log(`  ✗ ${target.displayName} (needs indexing)`);
		}
	}

	// If everything is already indexed, we're done
	if (needsIndexing.length === 0 && inProgress.length === 0) {
		console.log(`\n  All ${alreadyIndexed.length} source(s) already indexed.`);
		return;
	}

	// Step 4: Start indexing missing targets with concurrency control
	const deadline = Date.now() + maxWaitTime;

	if (needsIndexing.length > 0) {
		console.log(
			`\n  Starting indexing for ${needsIndexing.length} source(s) (parallel: ${parallel})...`,
		);

		const semaphore = new AsyncSemaphore(parallel);
		const indexPromises = needsIndexing.map(async (target) => {
			await semaphore.acquire();
			try {
				console.log(`  → Indexing ${target.displayName}...`);
				await indexTarget(apiKey, target);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(
					`  ⚠ Failed to start indexing ${target.displayName}: ${msg}`,
				);
			} finally {
				semaphore.release();
			}
		});
		await Promise.allSettled(indexPromises);
	}

	// Step 5: Wait for all non-indexed targets (newly started + already in-progress)
	const toWaitFor = [...needsIndexing, ...inProgress];
	if (toWaitFor.length > 0) {
		console.log(
			`\n  Waiting for ${toWaitFor.length} source(s) to finish indexing...`,
		);
		console.log(
			`  (timeout: ${formatDuration(maxWaitTime)}, polling every ${formatDuration(pollInterval)})`,
		);

		const pollPromises = toWaitFor.map(async (target) => {
			try {
				await pollUntilReady(apiKey, target, pollInterval, deadline);
				console.log(`  ✓ ${target.displayName} ready`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(`  ⚠ ${msg}`);
			}
		});
		await Promise.allSettled(pollPromises);
	}

	// Summary
	const elapsed = Date.now() + maxWaitTime - deadline; // time already spent
	console.log(
		`\n  Nia setup finished (${formatDuration(elapsed)}). ` +
			`${alreadyIndexed.length} cached, ${needsIndexing.length + inProgress.length} indexed/waited.`,
	);
}
