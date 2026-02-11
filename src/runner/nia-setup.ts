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
	/** Version tag (e.g. "v19.2.4") for repositories. */
	tag?: string;
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

/**
 * Result of submitting a target to the Nia API via `POST /sources`.
 * Contains the source ID needed for per-source status polling.
 */
interface IndexResult {
	/** The target that was submitted. */
	target: NiaIndexTarget;
	/** Unique source ID returned by the API (used for `GET /sources/{id}`). */
	sourceId: string;
	/** Status at the time of submission (e.g. "indexing", "completed", "indexed"). */
	status: string;
}

// --- Version → Target Mapping ---

/**
 * Static mapping from `{library}:{majorVersion}` to the Nia index targets
 * (repos + docs) required for that library version.
 *
 * The major version is extracted from the task's `target_version` field
 * (e.g. "19.0.0" → "19", "4.2.0" → "4").
 *
 * Repos use specific version tags so the agent can search version-accurate
 * source code. Docs use the canonical documentation site for that era.
 */
const VERSION_TARGETS: Record<string, NiaIndexTarget[]> = {
	// ─── React ───────────────────────────────────────────────────────────────
	"react:17": [
		{
			type: "repo",
			identifier: "facebook/react",
			tag: "17.0.2",
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
			tag: "18.3.1",
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
			tag: "v19.2.4",
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
			tag: "v13.5.7",
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
			tag: "v14.2.28",
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
			tag: "v15.3.3",
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
			tag: "v16.1.6",
			displayName: "Next.js v16",
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
			tag: "v3.4.33",
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
			tag: "v4.2.2",
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
			tag: "ai@5.0.129",
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
			tag: "v10.45.4",
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
			tag: "v11.10.0",
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
			tag: "v3.24.4",
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
			tag: "v4.3.6",
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
 * `type + identifier + tag` so shared sources (e.g. legacy.reactjs.org
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

	// Deduplicate by (type, identifier, tag)
	const seen = new Set<string>();
	const unique: NiaIndexTarget[] = [];
	for (const target of all) {
		const dedupeKey = `${target.type}:${target.identifier}:${target.tag ?? ""}`;
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

// --- Status Helpers ---

/** Terminal "ready" statuses — the source is fully indexed and searchable. */
const READY_STATUSES = new Set(["indexed", "completed"]);

/** In-progress statuses — the source is still being processed. */
const PENDING_STATUSES = new Set(["indexing", "queued", "processing"]);

/**
 * Checks the status of a specific Nia source by its ID.
 *
 * Uses the unified `GET /sources/{id}` endpoint which works for all source
 * types (repos, docs, etc.) and tracks per-source status — including
 * distinguishing different tags/refs of the same repository.
 */
export async function checkSourceStatus(
	apiKey: string,
	sourceId: string,
): Promise<{ ready: boolean; pending: boolean; rawStatus: string }> {
	try {
		const data = await niaFetch(apiKey, "GET", `/sources/${sourceId}`);
		const status = data.status ?? "unknown";
		return {
			ready: READY_STATUSES.has(status),
			pending: PENDING_STATUSES.has(status),
			rawStatus: status,
		};
	} catch {
		return { ready: false, pending: false, rawStatus: "error" };
	}
}

// --- Indexing ---

/**
 * Submits a repository for indexing via `POST /sources`.
 *
 * The API is idempotent — if the repo+ref is already indexed it returns the
 * existing source with its current status. The returned source ID is used
 * for subsequent per-source status polling via `GET /sources/{id}`.
 *
 * @returns The source ID and current status from the API response
 */
async function indexRepo(
	apiKey: string,
	target: NiaIndexTarget,
): Promise<{ id: string; status: string }> {
	const body: Record<string, unknown> = {
		type: "repository",
		repository: target.identifier,
	};
	if (target.tag) body.ref = target.tag;
	if (target.displayName) body.display_name = target.displayName;

	const res = await niaFetch(apiKey, "POST", "/sources", body);

	if (!res.id) {
		throw new Error(
			`POST /sources for ${target.displayName} did not return a source ID`,
		);
	}

	return { id: res.id, status: res.status ?? "unknown" };
}

/**
 * Submits a documentation site for indexing via `POST /sources`.
 *
 * Like `indexRepo`, the API is idempotent and returns the source ID for
 * subsequent status tracking.
 *
 * @returns The source ID and current status from the API response
 */
async function indexDocs(
	apiKey: string,
	target: NiaIndexTarget,
): Promise<{ id: string; status: string }> {
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

	const res = await niaFetch(apiKey, "POST", "/sources", body);

	if (!res.id) {
		throw new Error(
			`POST /sources for ${target.displayName} did not return a source ID`,
		);
	}

	return { id: res.id, status: res.status ?? "unknown" };
}

/**
 * Submits a target for indexing and returns the source ID + status.
 *
 * Dispatches to `indexRepo` or `indexDocs` based on target type.
 * The API is idempotent: already-indexed sources return immediately with
 * their current status (e.g. "completed"/"indexed").
 */
async function submitTarget(
	apiKey: string,
	target: NiaIndexTarget,
): Promise<{ id: string; status: string }> {
	if (target.type === "repo") {
		return indexRepo(apiKey, target);
	}
	return indexDocs(apiKey, target);
}

// --- Polling ---

/**
 * Polls a source by ID until it reaches a ready status or the deadline
 * is exceeded.
 *
 * Uses `GET /sources/{id}` for accurate per-source tracking, which
 * correctly distinguishes different tags/refs of the same repository.
 *
 * @param apiKey - Nia API key
 * @param sourceId - Source ID returned by `POST /sources`
 * @param displayName - Human-readable name for log messages
 * @param pollInterval - Interval between polls in ms
 * @param deadline - Absolute timestamp (Date.now() + maxWaitTime) to stop polling
 * @throws {Error} if the deadline is exceeded or a terminal error state is reached
 */
async function pollUntilReady(
	apiKey: string,
	sourceId: string,
	displayName: string,
	pollInterval: number,
	deadline: number,
): Promise<void> {
	while (Date.now() < deadline) {
		const status = await checkSourceStatus(apiKey, sourceId);

		if (status.ready) {
			return;
		}

		if (!status.pending) {
			// Unexpected terminal state (e.g. "error", "failed")
			throw new Error(
				`${displayName}: indexing ended with status "${status.rawStatus}"`,
			);
		}

		// Wait before next poll
		const remaining = deadline - Date.now();
		const wait = Math.min(pollInterval, remaining);
		if (wait <= 0) break;
		await new Promise((r) => setTimeout(r, wait));
	}

	throw new Error(`${displayName}: timed out waiting for indexing to complete`);
}

// --- Main Entry Point ---

/**
 * Ensures all Nia sources required by the loaded tasks are indexed and ready.
 *
 * This function is the main entry point for the Nia setup phase. It:
 * 1. Resolves the Nia API key
 * 2. Derives required targets from the task list
 * 3. Submits all targets via `POST /sources` (idempotent — returns existing
 *    source if already indexed) to obtain per-source IDs
 * 4. Polls any sources that aren't yet ready using `GET /sources/{id}` for
 *    accurate per-tag/ref status tracking
 *
 * This approach avoids the legacy `GET /repositories/{id}` endpoint which
 * only provides repo-level status and cannot distinguish between different
 * tags/refs of the same repository.
 *
 * If a target fails to submit, a warning is logged but other targets continue.
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
		`  Submitting ${targets.length} source(s) needed for the selected tasks...`,
	);

	// Step 3: Submit all targets via POST /sources (with concurrency control)
	// The API is idempotent — already-indexed sources return immediately with
	// their existing source ID and status. This gives us the per-source IDs
	// we need for accurate polling.
	const semaphore = new AsyncSemaphore(parallel);
	const submitPromises = targets.map(
		async (target): Promise<IndexResult | null> => {
			await semaphore.acquire();
			try {
				const { id, status } = await submitTarget(apiKey, target);
				return { target, sourceId: id, status };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(`  ⚠ Failed to submit ${target.displayName}: ${msg}`);
				return null;
			} finally {
				semaphore.release();
			}
		},
	);
	const results = (await Promise.all(submitPromises)).filter(
		(r): r is IndexResult => r !== null,
	);

	// Partition into ready vs needs-polling
	const alreadyReady: IndexResult[] = [];
	const needsPolling: IndexResult[] = [];

	for (const result of results) {
		if (READY_STATUSES.has(result.status)) {
			alreadyReady.push(result);
			console.log(`  ✓ ${result.target.displayName} (${result.status})`);
		} else {
			needsPolling.push(result);
			console.log(`  ↻ ${result.target.displayName} (${result.status})`);
		}
	}

	// If everything is already ready, we're done
	if (needsPolling.length === 0) {
		console.log(`\n  All ${alreadyReady.length} source(s) already indexed.`);
		return;
	}

	// Step 4: Poll sources that aren't ready yet using GET /sources/{id}
	const deadline = Date.now() + maxWaitTime;

	console.log(
		`\n  Waiting for ${needsPolling.length} source(s) to finish indexing...`,
	);
	console.log(
		`  (timeout: ${formatDuration(maxWaitTime)}, polling every ${formatDuration(pollInterval)})`,
	);

	const pollPromises = needsPolling.map(async (result) => {
		try {
			await pollUntilReady(
				apiKey,
				result.sourceId,
				result.target.displayName,
				pollInterval,
				deadline,
			);
			console.log(`  ✓ ${result.target.displayName} ready`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`  ⚠ ${msg}`);
		}
	});
	await Promise.allSettled(pollPromises);

	// Summary
	const elapsed = Date.now() + maxWaitTime - deadline; // time already spent
	console.log(
		`\n  Nia setup finished (${formatDuration(elapsed)}). ` +
			`${alreadyReady.length} cached, ${needsPolling.length} indexed/waited.`,
	);
}
