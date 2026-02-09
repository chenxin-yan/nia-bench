import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Result from running tsc --noEmit against a version-specific environment.
 */
export interface TypeCheckResult {
	passed: boolean;
	errors: string[];
}

/**
 * Library and version info for mapping to the correct typecheck environment.
 */
export interface LibraryVersion {
	library: string;
	version: string;
}

/**
 * Maps a library + version to the typecheck-envs directory name.
 *
 * Examples:
 *   { library: 'next', version: '13' } -> 'next-13'
 *   { library: 'next', version: '16.1.0' } -> 'next-16'
 *   { library: 'ai', version: '3' } -> 'ai-sdk-3'
 *   { library: 'react', version: '19' } -> 'react-19'
 *
 * Extracts the major version number from the version string.
 */
function getEnvDirName(libraryVersion: LibraryVersion): string {
	const { library, version } = libraryVersion;

	// Extract major version (first number before a dot or the whole string if no dot)
	const majorVersion = version.split(".")[0] ?? version;

	// AI SDK uses "ai-sdk-N" naming convention
	if (library === "ai") {
		return `ai-sdk-${majorVersion}`;
	}

	// All others use "library-N" naming convention
	return `${library}-${majorVersion}`;
}

/**
 * Resolves the absolute path to a typecheck environment directory.
 * Uses the provided base path, or defaults to the project's typecheck-envs directory.
 */
function resolveEnvDir(
	libraryVersion: LibraryVersion,
	typecheckEnvsDir?: string,
): string {
	const baseDir =
		typecheckEnvsDir ?? resolve(import.meta.dir, "..", "..", "typecheck-envs");
	const envDirName = getEnvDirName(libraryVersion);
	return join(baseDir, envDirName);
}

/**
 * Runs TypeScript type checking on the provided code against a version-specific
 * environment with pinned library versions.
 *
 * 1. Resolves the correct typecheck-envs/{env} directory based on library + version
 * 2. Writes the code to a temporary file in that directory
 * 3. Runs `tsc --noEmit` using the environment's tsconfig.json and node_modules
 * 4. Parses the output for errors
 * 5. Cleans up the temporary file
 *
 * @param code - The TypeScript/TSX code to type-check
 * @param libraryVersion - The library and version to check against
 * @param options - Optional configuration
 * @returns TypeCheckResult with pass/fail and any error messages
 */
export async function runTypeCheck(
	code: string,
	libraryVersion: LibraryVersion,
	options?: {
		/** Custom base directory for typecheck environments */
		typecheckEnvsDir?: string;
		/** Filename for the temp file (default: _typecheck_temp.tsx) */
		tempFileName?: string;
	},
): Promise<TypeCheckResult> {
	const envDir = resolveEnvDir(libraryVersion, options?.typecheckEnvsDir);

	// Verify environment directory exists
	if (!existsSync(envDir)) {
		return {
			passed: false,
			errors: [
				`Type-check environment not found: ${envDir}. Run 'bun install' in the environment directory first.`,
			],
		};
	}

	// Verify node_modules exists (dependencies installed)
	const nodeModulesDir = join(envDir, "node_modules");
	if (!existsSync(nodeModulesDir)) {
		return {
			passed: false,
			errors: [
				`Dependencies not installed in ${envDir}. Run 'bun install' in the environment directory first.`,
			],
		};
	}

	// Determine temp filename — use .tsx for JSX support, .ts for non-JSX
	const tempFileName = options?.tempFileName ?? "_typecheck_temp.tsx";
	const tempFilePath = join(envDir, tempFileName);

	try {
		// Write code to temp file
		writeFileSync(tempFilePath, code, "utf-8");

		// Get the path to tsc in the environment's node_modules
		const tscPath = join(nodeModulesDir, ".bin", "tsc");

		// Run tsc --noEmit on just this file, using the env's tsconfig
		const proc = Bun.spawn([tscPath, "--noEmit", "--pretty", "false"], {
			cwd: envDir,
			stdout: "pipe",
			stderr: "pipe",
		});

		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		const exitCode = await proc.exited;

		if (exitCode === 0) {
			return { passed: true, errors: [] };
		}

		// Parse errors from tsc output
		// tsc outputs errors in the format: file(line,col): error TSxxxx: message
		const output = stdout || stderr;
		const errors = parseTscErrors(output, tempFileName);

		return {
			passed: false,
			errors: errors.length > 0 ? errors : [`tsc exited with code ${exitCode}`],
		};
	} finally {
		// Clean up temp file
		try {
			if (existsSync(tempFilePath)) {
				unlinkSync(tempFilePath);
			}
		} catch {
			// Ignore cleanup errors
		}
	}
}

/**
 * Runs TypeScript type checking on multiple files against a version-specific environment.
 * Useful for tasks that produce multiple files (e.g., page.tsx + actions.ts).
 *
 * @param files - Map of filename to code content
 * @param libraryVersion - The library and version to check against
 * @param options - Optional configuration
 * @returns TypeCheckResult with pass/fail and any error messages
 */
export async function runTypeCheckMultiFile(
	files: Record<string, string>,
	libraryVersion: LibraryVersion,
	options?: {
		typecheckEnvsDir?: string;
	},
): Promise<TypeCheckResult> {
	const envDir = resolveEnvDir(libraryVersion, options?.typecheckEnvsDir);

	if (!existsSync(envDir)) {
		return {
			passed: false,
			errors: [
				`Type-check environment not found: ${envDir}. Run 'bun install' in the environment directory first.`,
			],
		};
	}

	const nodeModulesDir = join(envDir, "node_modules");
	if (!existsSync(nodeModulesDir)) {
		return {
			passed: false,
			errors: [
				`Dependencies not installed in ${envDir}. Run 'bun install' in the environment directory first.`,
			],
		};
	}

	const tempFiles: string[] = [];

	try {
		// Write all files to the env directory with a prefix to avoid conflicts
		for (const [filename, code] of Object.entries(files)) {
			const tempFileName = `_typecheck_${filename}`;
			const tempFilePath = join(envDir, tempFileName);
			writeFileSync(tempFilePath, code, "utf-8");
			tempFiles.push(tempFilePath);
		}

		const tscPath = join(nodeModulesDir, ".bin", "tsc");
		const proc = Bun.spawn([tscPath, "--noEmit", "--pretty", "false"], {
			cwd: envDir,
			stdout: "pipe",
			stderr: "pipe",
		});

		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		const exitCode = await proc.exited;

		if (exitCode === 0) {
			return { passed: true, errors: [] };
		}

		const output = stdout || stderr;
		// Collect errors from all temp files
		const allErrors: string[] = [];
		for (const [filename] of Object.entries(files)) {
			const tempFileName = `_typecheck_${filename}`;
			const fileErrors = parseTscErrors(output, tempFileName);
			for (const err of fileErrors) {
				allErrors.push(`[${filename}] ${err}`);
			}
		}

		return {
			passed: false,
			errors:
				allErrors.length > 0 ? allErrors : [`tsc exited with code ${exitCode}`],
		};
	} finally {
		// Clean up all temp files
		for (const filePath of tempFiles) {
			try {
				if (existsSync(filePath)) {
					unlinkSync(filePath);
				}
			} catch {
				// Ignore cleanup errors
			}
		}
	}
}

/**
 * Parses tsc output for errors related to a specific file.
 * Filters to only include errors from the temp file (ignoring errors from
 * library type definitions or other files).
 */
function parseTscErrors(output: string, tempFileName: string): string[] {
	const errors: string[] = [];
	const lines = output.split("\n");

	for (const line of lines) {
		// Match tsc error lines: file(line,col): error TSxxxx: message
		// We want errors from our temp file specifically
		if (line.includes(tempFileName) && line.includes("error TS")) {
			// Extract just the error part (remove file path prefix for cleaner output)
			const errorMatch = line.match(/error TS\d+:\s*(.+)/);
			if (errorMatch) {
				errors.push(errorMatch[0] ?? line.trim());
			} else {
				errors.push(line.trim());
			}
		}
	}

	return errors;
}
