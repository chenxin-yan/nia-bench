import {
	copyFile,
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Task } from "@/types/task";

// --- Types ---

export type Condition = "baseline" | "context7" | "nia";

/**
 * Represents a single tool call extracted from the agent's NDJSON output.
 */
export interface ToolCall {
	/** Tool name (e.g., "context7", "nia", "write", "bash") */
	tool: string;
	/** Tool call ID from the event */
	callId?: string;
	/** Completion status of the tool call */
	status?: string;
	/** Input parameters passed to the tool */
	input?: Record<string, unknown>;
}

/**
 * Structured error extracted from the agent's output or process failure.
 */
export interface AgentError {
	/** Short error classification (e.g., "UnknownError", "APIError", "ProcessError") */
	name: string;
	/** Human-readable error message */
	message: string;
}

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
	/** Tool calls made by the agent during execution */
	toolCalls: ToolCall[];
	/** Error information if the agent failed (null on success) */
	error: AgentError | null;
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

const DEFAULT_TIMEOUT = 900000; // 15 minutes
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

/**
 * Per-condition prompt suffixes appended to the task prompt.
 *
 * Each condition gets a short hint that nudges the agent toward using its
 * available context tools, while baseline gets a neutral version-accuracy
 * reminder to control for prompt-length effects.
 *
 * These are soft hints — the agent still decides whether to use the tools.
 */
const PROMPT_SUFFIX: Record<Condition, string> = {
	baseline:
		"\n\nEnsure your code uses the correct APIs for the specified library version.",
	context7:
		"\n\nBefore writing code, use your available documentation tools to verify the correct APIs for the specified library version.",
	nia: "\n\nBefore writing code, use your available research tools to look up and verify the correct APIs for the specified library version.",
};

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
 * Minimal opencode global config for the sandboxed HOME.
 * Contains no agents, plugins, MCP servers, or skills — just bare permissions
 * so opencode can start cleanly. Condition-specific tools are provided via
 * OPENCODE_CONFIG_DIR and the CWD .opencode.json.
 */
const SANDBOXED_OPENCODE_CONFIG = JSON.stringify(
	{
		$schema: "https://opencode.ai/config.json",
		mcp: {},
		plugin: [],
		permission: {
			bash: "allow",
			edit: "allow",
			write: "allow",
		},
	},
	null,
	"\t",
);

/**
 * Creates a sandboxed HOME directory for an opencode execution.
 *
 * opencode discovers agents, skills, plugins, and MCP servers from the global
 * config at ~/.config/opencode/. When a user has the "nia" agent or other tools
 * installed globally, they leak into every opencode session — including benchmark
 * conditions that should not have access to them (e.g., baseline).
 *
 * This function creates a minimal, isolated HOME directory that contains:
 * - A bare ~/.config/opencode/opencode.json (no agents, plugins, MCP servers)
 * - A copy of ~/.local/share/opencode/auth.json (so API auth still works)
 *
 * By setting HOME to this directory when spawning opencode, the benchmark
 * ensures complete isolation: each condition only sees tools provided by its
 * own OPENCODE_CONFIG_DIR and CWD .opencode.json config.
 */
export async function createSandboxedHome(
	tempBaseDir: string = DEFAULT_TEMP_BASE,
): Promise<string> {
	const sandboxHome = join(
		tempBaseDir,
		`home-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);

	// Create config directory structure
	const configDir = join(sandboxHome, ".config", "opencode");
	await mkdir(configDir, { recursive: true });

	// Write minimal opencode config (no agents, plugins, MCP, or skills)
	await writeFile(
		join(configDir, "opencode.json"),
		SANDBOXED_OPENCODE_CONFIG,
		"utf-8",
	);

	// Copy auth.json so API authentication still works.
	// opencode stores auth at ~/.local/share/opencode/auth.json (XDG data dir).
	const realHome = process.env.HOME ?? homedir();
	const authSrc = join(realHome, ".local", "share", "opencode", "auth.json");
	const authDestDir = join(sandboxHome, ".local", "share", "opencode");
	try {
		await mkdir(authDestDir, { recursive: true });
		await copyFile(authSrc, join(authDestDir, "auth.json"));
	} catch {
		// auth.json may not exist if using env-based API keys — that's fine
	}

	return sandboxHome;
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
 * Reads the condition-specific .opencode.json template, substitutes the $MODEL
 * placeholder with the resolved model, and writes the result into the working
 * directory. opencode loads config from CWD, so placing it in the workdir
 * ensures the correct config.
 *
 * The model is resolved from (highest priority first):
 *   1. config.model (--model CLI flag)
 *   2. DEFAULT_MODEL constant
 */
export async function injectConfig(
	workDir: string,
	condition: Condition,
	config?: AgentRunnerConfig,
): Promise<void> {
	const mcpConfigDir = resolveMcpConfigDir(config);
	const configFileName = CONFIG_FILE_MAP[condition];
	const srcPath = join(mcpConfigDir, configFileName);
	const model = config?.model ?? DEFAULT_MODEL;

	const template = await readFile(srcPath, "utf-8");
	const resolved = template.replaceAll("$MODEL", model);

	const destPath = join(workDir, ".opencode.json");
	await writeFile(destPath, resolved, "utf-8");
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
 * Extracts error information from the agent's streaming NDJSON output.
 *
 * Scans for `error` type events and returns a structured AgentError if found.
 * Multiple error events are concatenated into a single error message.
 * Returns null if no errors were found.
 */
export function extractErrors(rawOutput: string): AgentError | null {
	const events = parseOpenCodeEvents(rawOutput);
	const errorEvents = events.filter((e) => e.type === "error" && e.error);

	if (errorEvents.length === 0) return null;

	// Use the first error's name, and combine all messages
	const firstError = errorEvents[0]?.error;
	const name = firstError?.name ?? "UnknownError";

	const messages = errorEvents
		.map((e) => {
			const data = e.error?.data;
			const msg =
				data && typeof data.message === "string" ? data.message : null;
			return msg ?? e.error?.name ?? "Unknown error";
		})
		.filter(Boolean);

	const message =
		messages.length > 0 ? messages.join("; ") : "Unknown agent error";

	return { name, message };
}

/**
 * Extracts tool calls from the agent's streaming NDJSON output.
 *
 * Scans for `tool_use` type events and extracts the tool name, call ID,
 * status, and input parameters. This enables tracking which context tools
 * (Context7, Nia, etc.) the agent actually invoked during a run.
 */
export function extractToolCalls(rawOutput: string): ToolCall[] {
	const events = parseOpenCodeEvents(rawOutput);
	const toolCalls: ToolCall[] = [];

	for (const event of events) {
		if (event.type === "tool_use" && event.part?.tool) {
			toolCalls.push({
				tool: event.part.tool,
				callId: event.part.callID,
				status: event.part.state?.status,
				input: event.part.state?.input,
			});
		}
	}

	return toolCalls;
}

/**
 * Builds the full prompt sent to the agent by appending a condition-specific
 * suffix to the task prompt.
 *
 * - Baseline: neutral reminder about version correctness
 * - Context7: soft hint to use available documentation tools
 * - Nia: soft hint to use available research tools
 */
export function buildPrompt(taskPrompt: string, condition: Condition): string {
	return taskPrompt + PROMPT_SUFFIX[condition];
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
 * 1. Create sandboxed HOME and unique temp working directory
 * 2. Copy condition-specific .opencode.json config
 * 3. Inject task context files (package.json, code files)
 * 4. Invoke opencode CLI: `opencode run --format json "prompt"` with cwd set to the workdir
 * 5. Extract code from both stdout response and disk files
 * 6. Clean up temp directory and sandboxed HOME (unless keepWorkdirs is true)
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

	// Step 1a: Create sandboxed HOME to isolate from user's global opencode config.
	// This prevents global agents (e.g., nia subagent), skills, plugins, and MCP
	// servers from leaking into benchmark conditions.
	const sandboxHome = await createSandboxedHome(tempBaseDir);

	// Step 1b: Create unique temp directory
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
		// HOME is sandboxed to prevent global agent/skill/plugin leakage
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
			args.push(buildPrompt(task.prompt, condition));

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
					// Sandboxed HOME prevents opencode from discovering user's global
					// agents, skills, plugins, and MCP servers. Contains only a minimal
					// opencode config and a copy of auth.json for API authentication.
					HOME: sandboxHome,
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

		// Step 5: Extract errors from agent output (NDJSON error events),
		// or synthesize one from a process-level failure (e.g., spawn error).
		let error = extractErrors(rawOutput);
		if (!error && exitCode !== 0) {
			error = {
				name: "ProcessError",
				message: `opencode exited with code ${exitCode}`,
			};
		}

		// Step 6: Extract code from both sources and merge
		const diskFiles = await extractCodeFromDisk(workDir);
		const responseFiles = extractCodeFromResponse(rawOutput);

		// Merge both sources: disk files take precedence per-filename, but
		// response-extracted files fill in any gaps. This prevents the case where
		// the agent writes some helper files to disk but puts the primary solution
		// in a markdown code block, which would otherwise be silently dropped.
		const extractedFiles: Record<string, string> = {
			...responseFiles,
			...diskFiles,
		};

		// Step 6b: Extract tool calls for usage tracking
		const toolCalls = extractToolCalls(rawOutput);

		return {
			taskId: task.id,
			condition,
			runIndex,
			rawOutput,
			extractedFiles,
			exitCode,
			durationMs,
			workDir,
			toolCalls,
			error,
		};
	} finally {
		// Cleanup (unless keepWorkdirs is true)
		if (!config?.keepWorkdirs) {
			try {
				await rm(workDir, { recursive: true, force: true });
			} catch {
				// Cleanup failure is non-fatal
			}
			try {
				await rm(sandboxHome, { recursive: true, force: true });
			} catch {
				// Cleanup failure is non-fatal
			}
		}
	}
}
