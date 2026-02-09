import {
	copyFile,
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Task } from "@/types/task";

// --- Types ---

export type Condition = "baseline" | "context7" | "nia";

export interface AgentResult {
	/** Task ID from the task definition */
	taskId: string;
	/** Which condition was used (baseline, context7, nia) */
	condition: Condition;
	/** Repetition index (0-based) */
	runIndex: number;
	/** Raw stdout output from opencode */
	rawOutput: string;
	/** Extracted code files: filename -> code content */
	extractedFiles: Record<string, string>;
	/** Exit code from opencode process */
	exitCode: number;
	/** Execution duration in milliseconds */
	durationMs: number;
	/** Path to the working directory used for this run */
	workDir: string;
}

export interface AgentRunnerConfig {
	/** Whether to keep working directories after execution (for debugging) */
	keepWorkdirs?: boolean;
	/** Timeout in milliseconds per agent execution (default: 300_000 = 5 min) */
	timeout?: number;
	/** Base directory for temp working dirs (default: /tmp/nia-bench) */
	tempBaseDir?: string;
	/** Directory containing MCP config files (default: auto-resolved from module location) */
	mcpConfigDir?: string;
	/** Project root directory (for resolving default paths) */
	projectRoot?: string;
	/**
	 * Model ID to use for the agent in provider/model format.
	 * Passed as `--model` flag to opencode to override any config/env defaults.
	 * Example: "anthropic/claude-sonnet-4-20250514"
	 */
	model?: string;
}

/**
 * Represents a single JSON event from opencode's streaming output.
 * Format: newline-delimited JSON (NDJSON) with a `type` field.
 */
export interface OpenCodeEvent {
	type: string;
	timestamp: number;
	sessionID: string;
	part?: {
		id?: string;
		sessionID?: string;
		messageID?: string;
		type?: string;
		text?: string;
		tool?: string;
		callID?: string;
		state?: {
			status?: string;
			input?: Record<string, unknown>;
			output?: string;
			metadata?: Record<string, unknown>;
		};
		reason?: string;
		cost?: number;
		tokens?: Record<string, unknown>;
	};
	error?: {
		name?: string;
		data?: Record<string, unknown>;
	};
}

// --- Constants ---

const DEFAULT_TIMEOUT = 300_000; // 5 minutes
const DEFAULT_TEMP_BASE = "/tmp/nia-bench";
const CODE_FILE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const CONFIG_FILE_MAP: Record<Condition, string> = {
	baseline: "baseline.opencode.json",
	context7: "context7.opencode.json",
	nia: "nia.opencode.json",
};

/**
 * Default model to use for the agent. This is always passed as --model to
 * opencode to prevent env-based API keys (e.g., GROQ_API_KEY) from
 * overriding the intended model in .opencode.json config.
 */
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-20250514";

// --- Utility Functions ---

/**
 * Resolves the project root directory from config or by convention.
 */
function resolveProjectRoot(config?: AgentRunnerConfig): string {
	return config?.projectRoot ?? resolve(import.meta.dirname, "..", "..");
}

/**
 * Resolves the MCP config directory. Defaults to the mcp_configs directory
 * relative to this module's location.
 */
function resolveMcpConfigDir(config?: AgentRunnerConfig): string {
	if (config?.mcpConfigDir) return config.mcpConfigDir;
	return join(resolveProjectRoot(config), "src", "runner", "mcp_configs");
}

/**
 * Resolves the condition-specific config directory.
 * Each condition (baseline, context7, nia) has its own directory under
 * src/runner/condition_configs/{condition}/ containing:
 * - opencode.json: skill permissions and tool overrides
 * - skills/: condition-specific skill definitions (e.g., nia/ for the nia condition)
 *
 * This directory is passed as OPENCODE_CONFIG_DIR to the opencode process,
 * ensuring reproducible behavior regardless of the user's global opencode setup.
 * Skills, permissions, and tools are loaded from this directory instead of
 * ~/.config/opencode/ or any other global location.
 */
function resolveConditionConfigDir(
	condition: Condition,
	config?: AgentRunnerConfig,
): string {
	return join(
		resolveProjectRoot(config),
		"src",
		"runner",
		"condition_configs",
		condition,
	);
}

/**
 * Creates a unique temporary working directory for an agent execution.
 * Format: /tmp/nia-bench/{timestamp}-{taskId}-{condition}-{rep}/
 */
export async function createWorkDir(
	taskId: string,
	condition: Condition,
	runIndex: number,
	tempBaseDir: string = DEFAULT_TEMP_BASE,
): Promise<string> {
	const timestamp = Date.now();
	const dirName = `${timestamp}-${taskId}-${condition}-${runIndex}`;
	const workDir = join(tempBaseDir, dirName);
	await mkdir(workDir, { recursive: true });
	return workDir;
}

/**
 * Copies the condition-specific .opencode.json config into the working directory.
 * opencode loads config from CWD, so placing it in the workdir ensures the correct config.
 */
export async function injectConfig(
	workDir: string,
	condition: Condition,
	config?: AgentRunnerConfig,
): Promise<void> {
	const mcpConfigDir = resolveMcpConfigDir(config);
	const configFileName = CONFIG_FILE_MAP[condition];
	const srcPath = join(mcpConfigDir, configFileName);
	const destPath = join(workDir, ".opencode.json");
	await copyFile(srcPath, destPath);
}

/**
 * Writes task context files (package.json, code files) into the working directory.
 * This simulates a real project workspace for the agent.
 */
export async function injectContext(
	workDir: string,
	task: Task,
): Promise<void> {
	if (!task.context) return;

	// Write package.json if provided
	if (task.context.package_json) {
		await writeFile(
			join(workDir, "package.json"),
			task.context.package_json,
			"utf-8",
		);
	}

	// Write code files if provided
	if (task.context.code) {
		for (const [filename, content] of Object.entries(task.context.code)) {
			// Ensure parent directories exist for nested paths (e.g., "app/page.tsx")
			const filePath = join(workDir, filename);
			const parentDir = join(filePath, "..");
			await mkdir(parentDir, { recursive: true });
			await writeFile(filePath, content, "utf-8");
		}
	}
}

/**
 * Parses opencode's streaming NDJSON output into an array of events.
 * Each line is a separate JSON event with a `type` field.
 *
 * Event types:
 * - `step_start`: Start of a processing step
 * - `text`: Text response content (part.text)
 * - `tool_use`: Tool call with input/output (part.tool, part.state)
 * - `step_finish`: End of a processing step
 * - `error`: Error event
 */
export function parseOpenCodeEvents(rawOutput: string): OpenCodeEvent[] {
	const events: OpenCodeEvent[] = [];
	const lines = rawOutput.split("\n");

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		try {
			const event = JSON.parse(trimmed) as OpenCodeEvent;
			if (event.type) {
				events.push(event);
			}
		} catch {
			// Skip non-JSON lines (e.g., banner output)
		}
	}

	return events;
}

/**
 * Extracts code from the agent's streaming NDJSON response.
 *
 * Strategy:
 * 1. Collect all `text` type events and concatenate their text content
 * 2. Look for markdown code blocks in the concatenated text
 * 3. Try to detect filenames from context before code blocks
 */
export function extractCodeFromResponse(
	rawOutput: string,
): Record<string, string> {
	const files: Record<string, string> = {};

	// Parse NDJSON events
	const events = parseOpenCodeEvents(rawOutput);

	// Collect all text content from text events
	let fullText = "";
	for (const event of events) {
		if (event.type === "text" && event.part?.text) {
			fullText += event.part.text;
		}
	}

	// If no events were parsed (fallback for non-NDJSON output), try old format
	if (!fullText) {
		// Try to parse as old JSON format {response: "..."}
		try {
			const parsed = JSON.parse(rawOutput) as { response?: string };
			if (parsed.response) {
				fullText = parsed.response;
			}
		} catch {
			// Use raw text
			fullText = rawOutput;
		}
	}

	// Match code blocks with optional language and filename hints
	// Patterns: ```typescript, ```tsx, ```ts, ```jsx, ```js, ```javascript
	const codeBlockRegex =
		/```(?:typescript|tsx|ts|jsx|js|javascript)?\s*(?:\n|$)([\s\S]*?)```/g;

	let match: RegExpExecArray | null;
	let blockIndex = 0;

	// biome-ignore lint/suspicious/noAssignInExpressions: regex exec loop pattern
	while ((match = codeBlockRegex.exec(fullText)) !== null) {
		const code = match[1]?.trim();
		if (code) {
			// Try to detect filename from context before the code block
			const beforeBlock = fullText.substring(0, match.index);
			const filenameMatch = beforeBlock.match(
				/(?:file[:\s]+|filename[:\s]+|in\s+)`?([^\s`]+\.(?:tsx?|jsx?))`?\s*$/i,
			);
			const filename = filenameMatch?.[1] ?? `extracted-${blockIndex}.ts`;
			files[filename] = code;
			blockIndex++;
		}
	}

	return files;
}

/**
 * Scans the working directory for code files written by the agent.
 * Excludes known non-agent files (node_modules, .opencode.json, etc.)
 */
export async function extractCodeFromDisk(
	workDir: string,
): Promise<Record<string, string>> {
	const files: Record<string, string> = {};

	async function scanDir(dir: string, prefix: string): Promise<void> {
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch {
			return;
		}

		for (const entry of entries) {
			const fullPath = join(dir, entry);
			const relativePath = prefix ? `${prefix}/${entry}` : entry;

			// Skip known non-agent directories and files
			if (
				entry === "node_modules" ||
				entry === ".opencode" ||
				entry === ".opencode.json" ||
				entry === "package.json" ||
				entry === "bun.lock" ||
				entry === "package-lock.json" ||
				entry.startsWith(".")
			) {
				continue;
			}

			try {
				const entryStat = await stat(fullPath);

				if (entryStat.isDirectory()) {
					await scanDir(fullPath, relativePath);
				} else if (entryStat.isFile()) {
					const hasCodeExtension = CODE_FILE_EXTENSIONS.some((ext) =>
						entry.endsWith(ext),
					);
					if (hasCodeExtension) {
						const content = await readFile(fullPath, "utf-8");
						files[relativePath] = content;
					}
				}
			} catch {
				// Skip unreadable entries
			}
		}
	}

	await scanDir(workDir, "");
	return files;
}

/**
 * Checks if opencode CLI is available on PATH.
 */
export async function checkOpencodeBinary(): Promise<boolean> {
	try {
		const proc = Bun.spawn(["which", "opencode"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		return exitCode === 0;
	} catch {
		return false;
	}
}

/**
 * Runs the opencode agent for a single task/condition/rep combination.
 *
 * Steps:
 * 1. Create unique temp directory
 * 2. Copy condition-specific .opencode.json config
 * 3. Inject task context files (package.json, code files)
 * 4. Invoke opencode CLI: `opencode run --format json "prompt"` with cwd set to the workdir
 * 5. Extract code from both stdout response and disk files
 * 6. Clean up temp directory (unless keepWorkdirs is true)
 *
 * opencode v1.1.47 uses:
 * - `opencode run --format json "message"` for non-interactive execution
 * - CWD determines project context and config file loading (.opencode.json)
 * - JSON output is streaming NDJSON with event types: step_start, text, tool_use, step_finish
 */
export async function runAgent(
	task: Task,
	condition: Condition,
	runIndex: number,
	config?: AgentRunnerConfig,
): Promise<AgentResult> {
	const timeout = config?.timeout ?? DEFAULT_TIMEOUT;
	const tempBaseDir = config?.tempBaseDir ?? DEFAULT_TEMP_BASE;

	// Step 1: Create unique temp directory
	const workDir = await createWorkDir(
		task.id,
		condition,
		runIndex,
		tempBaseDir,
	);

	try {
		// Step 2: Inject condition-specific config
		await injectConfig(workDir, condition, config);

		// Step 3: Inject task context files
		await injectContext(workDir, task);

		// Step 4: Invoke opencode CLI
		// opencode v1.1.47 uses: `opencode run --format json "message"`
		// CWD is set via Bun.spawn's cwd option (opencode loads .opencode.json from CWD)
		// OPENCODE_CONFIG_DIR overrides skill/permission discovery to use repo-bundled configs
		const startTime = Date.now();
		let rawOutput = "";
		let exitCode = 1;

		try {
			// Build command args
			// Always pass --model to override env-based provider resolution.
			// Without this, opencode may pick a different provider/model based on
			// which API keys are set in the environment (e.g., GROQ_API_KEY).
			const model = config?.model ?? DEFAULT_MODEL;
			const args = ["opencode", "run", "--format", "json", "--model", model];
			args.push(task.prompt);

			// Resolve the condition-specific config directory for skill isolation.
			// This ensures each condition only sees its own skills/permissions,
			// regardless of the user's global opencode setup.
			const conditionConfigDir = resolveConditionConfigDir(condition, config);

			const proc = Bun.spawn(args, {
				stdout: "pipe",
				stderr: "pipe",
				cwd: workDir,
				env: {
					...process.env,
					// Ensure HOME is set so opencode can find its global config
					HOME: process.env.HOME ?? "/tmp",
					// Override config directory to load condition-specific skills and permissions.
					// This takes precedence over global ~/.config/opencode/ settings,
					// making the benchmark reproducible across different machines.
					OPENCODE_CONFIG_DIR: conditionConfigDir,
				},
			});

			// Set up timeout
			const timeoutId = setTimeout(() => {
				try {
					proc.kill();
				} catch {
					// Process may have already exited
				}
			}, timeout);

			try {
				// Read both stdout and stderr concurrently.
				// opencode may split NDJSON events across both streams.
				const [stdoutText, stderrText] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
				]);
				exitCode = await proc.exited;

				// Combine both streams — opencode may write events to either or both
				rawOutput = [stdoutText, stderrText].filter(Boolean).join("\n");
			} finally {
				clearTimeout(timeoutId);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			rawOutput = `Error running opencode: ${message}`;
			exitCode = 1;
		}

		const durationMs = Date.now() - startTime;

		// Step 5: Extract code from both sources
		const diskFiles = await extractCodeFromDisk(workDir);
		const responseFiles = extractCodeFromResponse(rawOutput);

		// Prefer files on disk (more complete), fall back to extracted code blocks
		const extractedFiles: Record<string, string> =
			Object.keys(diskFiles).length > 0 ? diskFiles : responseFiles;

		return {
			taskId: task.id,
			condition,
			runIndex,
			rawOutput,
			extractedFiles,
			exitCode,
			durationMs,
			workDir,
		};
	} finally {
		// Step 6: Cleanup (unless keepWorkdirs is true)
		if (!config?.keepWorkdirs) {
			try {
				await rm(workDir, { recursive: true, force: true });
			} catch {
				// Cleanup failure is non-fatal
			}
		}
	}
}
