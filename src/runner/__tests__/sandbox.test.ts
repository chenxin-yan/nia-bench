import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "@/types/task";
import {
	buildPrompt,
	type Condition,
	createSandboxedHome,
	createWorkDir,
	injectConfig,
	injectContext,
} from "../agent";

// --- Test Helpers ---

const TEST_TEMP_DIR = join(
	"/tmp",
	"nia-bench-test",
	`sandbox-test-${Date.now()}`,
);

/** Helper: check if a path exists */
async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** Get path to the actual MCP config directory */
function getMcpConfigDir(): string {
	return join(import.meta.dirname, "..", "mcp_configs");
}

/** Minimal valid task for testing */
function makeTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "test-task-1",
		category: "bleeding_edge",
		library: "next",
		target_version: "16",
		prompt: "Create a proxy.ts file",
		reference_solution: "export function proxy() {}",
		test_spec: {
			ast_checks: [],
		},
		rubric: {
			criteria: [{ name: "test", weight: 1.0, description: "Test criterion" }],
		},
		common_hallucinations: [],
		...overrides,
	};
}

/** Assert skillsDir is non-null and return it (avoids non-null assertions) */
function requireSkillsDir(
	sandbox: Awaited<ReturnType<typeof createSandboxedHome>>,
): string {
	if (!sandbox.skillsDir) {
		throw new Error("Expected sandbox.skillsDir to be non-null");
	}
	return sandbox.skillsDir;
}

// --- Setup / Teardown ---

beforeEach(async () => {
	await mkdir(TEST_TEMP_DIR, { recursive: true });
});

afterEach(async () => {
	try {
		await rm(TEST_TEMP_DIR, { recursive: true, force: true });
	} catch {
		// Best effort cleanup
	}
});

// ============================================================================
// 1. createSandboxedHome: HOME isolation, config structure, skills copy
// ============================================================================

describe("createSandboxedHome", () => {
	test("creates a sandboxed HOME directory with opencode config", async () => {
		const sandbox = await createSandboxedHome(
			{ mcpConfigDir: getMcpConfigDir() },
			TEST_TEMP_DIR,
		);

		expect(sandbox.home).toBeTruthy();
		expect(await pathExists(sandbox.home)).toBe(true);

		// Should contain .config/opencode/opencode.json
		const configPath = join(
			sandbox.home,
			".config",
			"opencode",
			"opencode.json",
		);
		expect(await pathExists(configPath)).toBe(true);
	});

	test("sandboxed HOME config is a clean slate with no agents, plugins, or MCP servers", async () => {
		const sandbox = await createSandboxedHome(
			{ mcpConfigDir: getMcpConfigDir() },
			TEST_TEMP_DIR,
		);

		const configPath = join(
			sandbox.home,
			".config",
			"opencode",
			"opencode.json",
		);
		const config = JSON.parse(await readFile(configPath, "utf-8"));

		// Clean slate: no agents, no plugins, no skills
		expect(config.agent).toBeUndefined();
		expect(config.plugin).toEqual([]);
		expect(config.skills).toBeUndefined();

		// MCP should be empty (no servers)
		expect(config.mcp).toEqual({});

		// Base permissions are present
		expect(config.permission).toBeDefined();
		expect(config.permission.bash).toBe("allow");
		expect(config.permission.edit).toBe("allow");
		expect(config.permission.write).toBe("allow");

		// Should NOT have condition-specific permissions (like skill deny/allow)
		expect(config.permission.skill).toBeUndefined();
	});

	test("copies skills from mcp_configs/skills/ into sandbox", async () => {
		const sandbox = await createSandboxedHome(
			{ mcpConfigDir: getMcpConfigDir() },
			TEST_TEMP_DIR,
		);

		// Skills should be copied into $SANDBOX_HOME/skills/
		const skillsDir = requireSkillsDir(sandbox);
		expect(await pathExists(skillsDir)).toBe(true);

		// Nia skill directory should exist
		const niaDir = join(skillsDir, "nia");
		expect(await pathExists(niaDir)).toBe(true);
	});

	test("copies SKILL.md into sandbox with correct frontmatter", async () => {
		const sandbox = await createSandboxedHome(
			{ mcpConfigDir: getMcpConfigDir() },
			TEST_TEMP_DIR,
		);

		const skillsDir = requireSkillsDir(sandbox);
		const skillMdPath = join(skillsDir, "nia", "SKILL.md");
		expect(await pathExists(skillMdPath)).toBe(true);

		const content = await readFile(skillMdPath, "utf-8");

		// Verify frontmatter has correct case-sensitive name
		expect(content).toContain("name: Nia");
		expect(content).toContain("slug: nia");
		expect(content).toContain("description:");
	});

	test("copies skill scripts into sandbox", async () => {
		const sandbox = await createSandboxedHome(
			{ mcpConfigDir: getMcpConfigDir() },
			TEST_TEMP_DIR,
		);

		const skillsDir = requireSkillsDir(sandbox);
		const scriptsDir = join(skillsDir, "nia", "scripts");
		expect(await pathExists(scriptsDir)).toBe(true);

		const scripts = await readdir(scriptsDir);
		// Should have the core scripts: lib.sh, search.sh, sources.sh, repos.sh, packages.sh
		expect(scripts.length).toBeGreaterThanOrEqual(5);
		expect(scripts).toContain("search.sh");
		expect(scripts).toContain("sources.sh");
		expect(scripts).toContain("repos.sh");
		expect(scripts).toContain("lib.sh");
		expect(scripts).toContain("packages.sh");
	});

	test("skill scripts match between source and sandbox", async () => {
		const sandbox = await createSandboxedHome(
			{ mcpConfigDir: getMcpConfigDir() },
			TEST_TEMP_DIR,
		);

		// Compare source vs sandbox script lists
		const skillsDir = requireSkillsDir(sandbox);
		const srcScriptsDir = join(getMcpConfigDir(), "skills", "nia", "scripts");
		const srcScripts = (await readdir(srcScriptsDir)).sort();
		const sandboxScripts = (
			await readdir(join(skillsDir, "nia", "scripts"))
		).sort();

		expect(sandboxScripts).toEqual(srcScripts);

		// Verify content matches for a key script
		const srcSearch = await readFile(join(srcScriptsDir, "search.sh"), "utf-8");
		const sandboxSearch = await readFile(
			join(skillsDir, "nia", "scripts", "search.sh"),
			"utf-8",
		);
		expect(sandboxSearch).toBe(srcSearch);
	});

	test("creates unique sandbox directories for each call", async () => {
		const sandbox1 = await createSandboxedHome(
			{ mcpConfigDir: getMcpConfigDir() },
			TEST_TEMP_DIR,
		);
		const sandbox2 = await createSandboxedHome(
			{ mcpConfigDir: getMcpConfigDir() },
			TEST_TEMP_DIR,
		);

		expect(sandbox1.home).not.toBe(sandbox2.home);
		expect(sandbox1.skillsDir).not.toBe(sandbox2.skillsDir);
	});

	test("sandbox has no extraneous files beyond config, auth, and skills", async () => {
		const sandbox = await createSandboxedHome(
			{ mcpConfigDir: getMcpConfigDir() },
			TEST_TEMP_DIR,
		);

		// Top-level entries in sandbox HOME
		const topEntries = await readdir(sandbox.home);
		// Should only have: .config, .local (auth), skills
		const expectedDirs = [".config", ".local", "skills"];
		for (const entry of topEntries) {
			expect(expectedDirs).toContain(entry);
		}
	});
});

// ============================================================================
// 2. Per-condition sandbox + config integration
// ============================================================================

describe("condition: baseline", () => {
	test("baseline config has NO MCP servers", async () => {
		const workDir = await createWorkDir("test", "baseline", 0, TEST_TEMP_DIR);
		await injectConfig(workDir, "baseline", {
			mcpConfigDir: getMcpConfigDir(),
		});

		const config = JSON.parse(
			await readFile(join(workDir, "opencode.json"), "utf-8"),
		);

		expect(config.mcp).toBeUndefined();
	});

	test("baseline config has skill tool disabled", async () => {
		const workDir = await createWorkDir("test", "baseline", 0, TEST_TEMP_DIR);
		await injectConfig(workDir, "baseline", {
			mcpConfigDir: getMcpConfigDir(),
		});

		const config = JSON.parse(
			await readFile(join(workDir, "opencode.json"), "utf-8"),
		);

		expect(config.tools?.skill).toBe(false);
	});

	test("baseline config denies ALL skill permissions", async () => {
		const workDir = await createWorkDir("test", "baseline", 0, TEST_TEMP_DIR);
		await injectConfig(workDir, "baseline", {
			mcpConfigDir: getMcpConfigDir(),
		});

		const config = JSON.parse(
			await readFile(join(workDir, "opencode.json"), "utf-8"),
		);

		expect(config.permission.skill).toBe("deny");
	});

	test("baseline config has NO skills.paths", async () => {
		const workDir = await createWorkDir("test", "baseline", 0, TEST_TEMP_DIR);
		const sandbox = await createSandboxedHome(
			{ mcpConfigDir: getMcpConfigDir() },
			TEST_TEMP_DIR,
		);
		await injectConfig(
			workDir,
			"baseline",
			{ mcpConfigDir: getMcpConfigDir() },
			sandbox,
		);

		const config = JSON.parse(
			await readFile(join(workDir, "opencode.json"), "utf-8"),
		);

		// Baseline has no $SKILLS_DIR placeholder so skills block should not exist
		expect(config.skills).toBeUndefined();
	});

	test("baseline allows edit, write, bash permissions", async () => {
		const workDir = await createWorkDir("test", "baseline", 0, TEST_TEMP_DIR);
		await injectConfig(workDir, "baseline", {
			mcpConfigDir: getMcpConfigDir(),
		});

		const config = JSON.parse(
			await readFile(join(workDir, "opencode.json"), "utf-8"),
		);

		expect(config.permission.edit).toBe("allow");
		expect(config.permission.write).toBe("allow");
		expect(config.permission.bash).toBe("allow");
	});
});

describe("condition: context7", () => {
	test("context7 config has Context7 MCP server", async () => {
		const workDir = await createWorkDir("test", "context7", 0, TEST_TEMP_DIR);
		await injectConfig(workDir, "context7", {
			mcpConfigDir: getMcpConfigDir(),
		});

		const config = JSON.parse(
			await readFile(join(workDir, "opencode.json"), "utf-8"),
		);

		expect(config.mcp).toBeDefined();
		expect(config.mcp.context7).toBeDefined();
		expect(config.mcp.context7.type).toBe("remote");
		expect(config.mcp.context7.url).toBe("https://mcp.context7.com/mcp");
	});

	test("context7 config has ONLY the context7 MCP server (no others)", async () => {
		const workDir = await createWorkDir("test", "context7", 0, TEST_TEMP_DIR);
		await injectConfig(workDir, "context7", {
			mcpConfigDir: getMcpConfigDir(),
		});

		const config = JSON.parse(
			await readFile(join(workDir, "opencode.json"), "utf-8"),
		);

		const mcpKeys = Object.keys(config.mcp);
		expect(mcpKeys).toEqual(["context7"]);
	});

	test("context7 config has skill tool disabled", async () => {
		const workDir = await createWorkDir("test", "context7", 0, TEST_TEMP_DIR);
		await injectConfig(workDir, "context7", {
			mcpConfigDir: getMcpConfigDir(),
		});

		const config = JSON.parse(
			await readFile(join(workDir, "opencode.json"), "utf-8"),
		);

		expect(config.tools?.skill).toBe(false);
	});

	test("context7 config denies ALL skill permissions", async () => {
		const workDir = await createWorkDir("test", "context7", 0, TEST_TEMP_DIR);
		await injectConfig(workDir, "context7", {
			mcpConfigDir: getMcpConfigDir(),
		});

		const config = JSON.parse(
			await readFile(join(workDir, "opencode.json"), "utf-8"),
		);

		expect(config.permission.skill).toBe("deny");
	});

	test("context7 config has NO skills.paths", async () => {
		const workDir = await createWorkDir("test", "context7", 0, TEST_TEMP_DIR);
		const sandbox = await createSandboxedHome(
			{ mcpConfigDir: getMcpConfigDir() },
			TEST_TEMP_DIR,
		);
		await injectConfig(
			workDir,
			"context7",
			{ mcpConfigDir: getMcpConfigDir() },
			sandbox,
		);

		const config = JSON.parse(
			await readFile(join(workDir, "opencode.json"), "utf-8"),
		);

		expect(config.skills).toBeUndefined();
	});

	test("context7 config passes Context7 API key via env reference", async () => {
		const workDir = await createWorkDir("test", "context7", 0, TEST_TEMP_DIR);
		await injectConfig(workDir, "context7", {
			mcpConfigDir: getMcpConfigDir(),
		});

		const config = JSON.parse(
			await readFile(join(workDir, "opencode.json"), "utf-8"),
		);

		expect(config.mcp.context7.headers?.CONTEXT7_API_KEY).toBe(
			"{env:CONTEXT7_API_KEY}",
		);
	});
});

describe("condition: nia", () => {
	test("nia config has NO MCP servers", async () => {
		const workDir = await createWorkDir("test", "nia", 0, TEST_TEMP_DIR);
		await injectConfig(workDir, "nia", { mcpConfigDir: getMcpConfigDir() });

		const config = JSON.parse(
			await readFile(join(workDir, "opencode.json"), "utf-8"),
		);

		expect(config.mcp).toBeUndefined();
	});

	test("nia config does NOT disable skill tool", async () => {
		const workDir = await createWorkDir("test", "nia", 0, TEST_TEMP_DIR);
		await injectConfig(workDir, "nia", { mcpConfigDir: getMcpConfigDir() });

		const config = JSON.parse(
			await readFile(join(workDir, "opencode.json"), "utf-8"),
		);

		// Nia should NOT have tools.skill: false
		expect(config.tools?.skill).toBeUndefined();
	});

	test("nia config uses case-sensitive Nia permission (PascalCase)", async () => {
		const workDir = await createWorkDir("test", "nia", 0, TEST_TEMP_DIR);
		await injectConfig(workDir, "nia", { mcpConfigDir: getMcpConfigDir() });

		const config = JSON.parse(
			await readFile(join(workDir, "opencode.json"), "utf-8"),
		);

		// Must use PascalCase "Nia" to match SKILL.md frontmatter
		expect(config.permission.skill).toBeDefined();
		expect(config.permission.skill.Nia).toBe("allow");

		// Must NOT have lowercase "nia" (this was the bug we fixed)
		expect(config.permission.skill.nia).toBeUndefined();
	});

	test("nia config denies all other skills with wildcard", async () => {
		const workDir = await createWorkDir("test", "nia", 0, TEST_TEMP_DIR);
		await injectConfig(workDir, "nia", { mcpConfigDir: getMcpConfigDir() });

		const config = JSON.parse(
			await readFile(join(workDir, "opencode.json"), "utf-8"),
		);

		expect(config.permission.skill["*"]).toBe("deny");

		// Only two keys should exist in skill permissions
		const skillPermKeys = Object.keys(config.permission.skill);
		expect(skillPermKeys).toEqual(expect.arrayContaining(["*", "Nia"]));
		expect(skillPermKeys).toHaveLength(2);
	});

	test("nia config includes skills.paths when sandboxInfo provided", async () => {
		const sandbox = await createSandboxedHome(
			{ mcpConfigDir: getMcpConfigDir() },
			TEST_TEMP_DIR,
		);
		const workDir = await createWorkDir("test", "nia", 0, TEST_TEMP_DIR);
		await injectConfig(
			workDir,
			"nia",
			{ mcpConfigDir: getMcpConfigDir() },
			sandbox,
		);

		const config = JSON.parse(
			await readFile(join(workDir, "opencode.json"), "utf-8"),
		);

		// skills.paths should point to sandbox skills directory
		expect(config.skills).toBeDefined();
		expect(config.skills.paths).toHaveLength(1);
		expect(config.skills.paths[0]).toBe(sandbox.skillsDir);
	});

	test("nia config skills.paths points to a directory that contains nia/SKILL.md", async () => {
		const sandbox = await createSandboxedHome(
			{ mcpConfigDir: getMcpConfigDir() },
			TEST_TEMP_DIR,
		);
		const workDir = await createWorkDir("test", "nia", 0, TEST_TEMP_DIR);
		await injectConfig(
			workDir,
			"nia",
			{ mcpConfigDir: getMcpConfigDir() },
			sandbox,
		);

		const config = JSON.parse(
			await readFile(join(workDir, "opencode.json"), "utf-8"),
		);

		const skillsPath = config.skills.paths[0] as string;

		// The skills path should contain nia/SKILL.md
		const skillMdPath = join(skillsPath, "nia", "SKILL.md");
		expect(await pathExists(skillMdPath)).toBe(true);

		// And nia/scripts/
		const scriptsPath = join(skillsPath, "nia", "scripts");
		expect(await pathExists(scriptsPath)).toBe(true);
	});

	test("nia config removes skills block when no sandboxInfo", async () => {
		const workDir = await createWorkDir("test", "nia", 0, TEST_TEMP_DIR);
		await injectConfig(workDir, "nia", { mcpConfigDir: getMcpConfigDir() });

		const config = JSON.parse(
			await readFile(join(workDir, "opencode.json"), "utf-8"),
		);

		// Without sandbox, $SKILLS_DIR placeholder can't be resolved
		// so the skills block should be removed
		expect(config.skills).toBeUndefined();
	});

	test("nia config has no raw $SKILLS_DIR placeholder after substitution", async () => {
		const sandbox = await createSandboxedHome(
			{ mcpConfigDir: getMcpConfigDir() },
			TEST_TEMP_DIR,
		);
		const workDir = await createWorkDir("test", "nia", 0, TEST_TEMP_DIR);
		await injectConfig(
			workDir,
			"nia",
			{ mcpConfigDir: getMcpConfigDir() },
			sandbox,
		);

		const raw = await readFile(join(workDir, "opencode.json"), "utf-8");
		expect(raw).not.toContain("$SKILLS_DIR");
	});
});

// ============================================================================
// 3. Cross-condition isolation / no contamination
// ============================================================================

describe("cross-condition isolation", () => {
	test("no condition has raw $MODEL placeholder after substitution", async () => {
		const conditions: Condition[] = ["baseline", "context7", "nia"];
		const sandbox = await createSandboxedHome(
			{ mcpConfigDir: getMcpConfigDir() },
			TEST_TEMP_DIR,
		);

		for (const condition of conditions) {
			const workDir = await createWorkDir("test", condition, 0, TEST_TEMP_DIR);
			await injectConfig(
				workDir,
				condition,
				{ mcpConfigDir: getMcpConfigDir() },
				sandbox,
			);

			const raw = await readFile(join(workDir, "opencode.json"), "utf-8");
			expect(raw).not.toContain("$MODEL");
		}
	});

	test("only context7 has MCP servers; baseline and nia do not", async () => {
		const conditions: Condition[] = ["baseline", "context7", "nia"];
		const sandbox = await createSandboxedHome(
			{ mcpConfigDir: getMcpConfigDir() },
			TEST_TEMP_DIR,
		);
		const configs: Record<string, Record<string, unknown>> = {};

		for (const condition of conditions) {
			const workDir = await createWorkDir("test", condition, 0, TEST_TEMP_DIR);
			await injectConfig(
				workDir,
				condition,
				{ mcpConfigDir: getMcpConfigDir() },
				sandbox,
			);
			configs[condition] = JSON.parse(
				await readFile(join(workDir, "opencode.json"), "utf-8"),
			);
		}

		// Only context7 should have mcp
		expect(configs.baseline?.mcp).toBeUndefined();
		expect(configs.context7?.mcp).toBeDefined();
		expect(configs.nia?.mcp).toBeUndefined();
	});

	test("only nia has skills.paths; baseline and context7 do not", async () => {
		const conditions: Condition[] = ["baseline", "context7", "nia"];
		const sandbox = await createSandboxedHome(
			{ mcpConfigDir: getMcpConfigDir() },
			TEST_TEMP_DIR,
		);
		const configs: Record<string, Record<string, unknown>> = {};

		for (const condition of conditions) {
			const workDir = await createWorkDir("test", condition, 0, TEST_TEMP_DIR);
			await injectConfig(
				workDir,
				condition,
				{ mcpConfigDir: getMcpConfigDir() },
				sandbox,
			);
			configs[condition] = JSON.parse(
				await readFile(join(workDir, "opencode.json"), "utf-8"),
			);
		}

		// Only nia should have skills
		expect(configs.baseline?.skills).toBeUndefined();
		expect(configs.context7?.skills).toBeUndefined();
		expect(configs.nia?.skills).toBeDefined();
	});

	test("baseline and context7 disable skill tool; nia does not", async () => {
		const conditions: Condition[] = ["baseline", "context7", "nia"];
		const sandbox = await createSandboxedHome(
			{ mcpConfigDir: getMcpConfigDir() },
			TEST_TEMP_DIR,
		);
		const configs: Record<string, Record<string, unknown>> = {};

		for (const condition of conditions) {
			const workDir = await createWorkDir("test", condition, 0, TEST_TEMP_DIR);
			await injectConfig(
				workDir,
				condition,
				{ mcpConfigDir: getMcpConfigDir() },
				sandbox,
			);
			configs[condition] = JSON.parse(
				await readFile(join(workDir, "opencode.json"), "utf-8"),
			);
		}

		// baseline & context7: tools.skill = false
		expect((configs.baseline?.tools as Record<string, unknown>)?.skill).toBe(
			false,
		);
		expect((configs.context7?.tools as Record<string, unknown>)?.skill).toBe(
			false,
		);
		// nia: should NOT have tools.skill = false (skill tool must be available)
		expect(
			(configs.nia?.tools as Record<string, unknown> | undefined)?.skill,
		).toBeUndefined();
	});

	test("all conditions use the same agent model", async () => {
		const conditions: Condition[] = ["baseline", "context7", "nia"];
		const sandbox = await createSandboxedHome(
			{ mcpConfigDir: getMcpConfigDir() },
			TEST_TEMP_DIR,
		);
		const models: string[] = [];

		for (const condition of conditions) {
			const workDir = await createWorkDir("test", condition, 0, TEST_TEMP_DIR);
			await injectConfig(
				workDir,
				condition,
				{ mcpConfigDir: getMcpConfigDir() },
				sandbox,
			);
			const config = JSON.parse(
				await readFile(join(workDir, "opencode.json"), "utf-8"),
			) as { agent: { coder: { model: string } } };
			models.push(config.agent.coder.model);
		}

		// All models should be identical
		expect(models).toHaveLength(3);
		expect(models[0]).toBe(models[1]);
		expect(models[1]).toBe(models[2]);
		expect(models[0]).toBe("anthropic/claude-sonnet-4-20250514");
	});

	test("all conditions allow edit, write, bash permissions", async () => {
		const conditions: Condition[] = ["baseline", "context7", "nia"];
		const sandbox = await createSandboxedHome(
			{ mcpConfigDir: getMcpConfigDir() },
			TEST_TEMP_DIR,
		);

		for (const condition of conditions) {
			const workDir = await createWorkDir("test", condition, 0, TEST_TEMP_DIR);
			await injectConfig(
				workDir,
				condition,
				{ mcpConfigDir: getMcpConfigDir() },
				sandbox,
			);
			const config = JSON.parse(
				await readFile(join(workDir, "opencode.json"), "utf-8"),
			);

			const perm = config.permission as Record<string, unknown>;
			expect(perm.edit).toBe("allow");
			expect(perm.write).toBe("allow");
			expect(perm.bash).toBe("allow");
		}
	});
});

// ============================================================================
// 4. SKILL.md frontmatter and content verification
// ============================================================================

describe("skill definition integrity", () => {
	test("SKILL.md frontmatter name matches permission rule (Nia, PascalCase)", async () => {
		// Read the source SKILL.md
		const skillMd = await readFile(
			join(getMcpConfigDir(), "skills", "nia", "SKILL.md"),
			"utf-8",
		);

		// Extract name from frontmatter
		const nameMatch = skillMd.match(/^name:\s*(.+)$/m);
		if (!nameMatch?.[1])
			throw new Error("name not found in SKILL.md frontmatter");
		const skillName = nameMatch[1].trim();

		// Read the nia config to check permission
		const niaConfig = JSON.parse(
			await readFile(join(getMcpConfigDir(), "nia.opencode.json"), "utf-8"),
		);

		// The permission key must EXACTLY match the frontmatter name
		const skillPerms = niaConfig.permission.skill as Record<string, string>;
		expect(skillPerms[skillName]).toBe("allow");

		// Double-check it's "Nia" (PascalCase), not "nia" (lowercase)
		expect(skillName).toBe("Nia");
	});

	test("SKILL.md slug is lowercase 'nia'", async () => {
		const skillMd = await readFile(
			join(getMcpConfigDir(), "skills", "nia", "SKILL.md"),
			"utf-8",
		);

		const slugMatch = skillMd.match(/^slug:\s*(.+)$/m);
		if (!slugMatch?.[1])
			throw new Error("slug not found in SKILL.md frontmatter");
		expect(slugMatch[1].trim()).toBe("nia");
	});

	test("all skill scripts are non-empty shell scripts", async () => {
		const scriptsDir = join(getMcpConfigDir(), "skills", "nia", "scripts");
		const scripts = await readdir(scriptsDir);

		expect(scripts.length).toBeGreaterThan(0);

		for (const script of scripts) {
			expect(script).toMatch(/\.sh$/);
			const content = await readFile(join(scriptsDir, script), "utf-8");
			expect(content.length).toBeGreaterThan(0);
			// All scripts should start with a shebang or be valid shell
			expect(content.trimStart().startsWith("#")).toBe(true);
		}
	});

	test("required skill scripts exist: lib, search, sources, repos, packages", async () => {
		const scriptsDir = join(getMcpConfigDir(), "skills", "nia", "scripts");
		const scripts = await readdir(scriptsDir);

		const requiredScripts = [
			"lib.sh",
			"search.sh",
			"sources.sh",
			"repos.sh",
			"packages.sh",
		];

		for (const required of requiredScripts) {
			expect(scripts).toContain(required);
		}
	});
});

// ============================================================================
// 5. End-to-end sandbox pipeline per condition
// ============================================================================

describe("end-to-end: baseline pipeline", () => {
	test("full baseline pipeline produces correct sandbox and workdir layout", async () => {
		const task = makeTask({
			id: "e2e-baseline",
			context: {
				package_json: '{"dependencies": {"next": "14.0.0"}}',
				code: { "app/page.tsx": "export default function Page() {}" },
			},
		});

		// 1. Create sandbox
		const sandbox = await createSandboxedHome(
			{ mcpConfigDir: getMcpConfigDir() },
			TEST_TEMP_DIR,
		);

		// 2. Create workdir
		const workDir = await createWorkDir(task.id, "baseline", 0, TEST_TEMP_DIR);

		// 3. Inject config with sandbox info
		await injectConfig(
			workDir,
			"baseline",
			{ mcpConfigDir: getMcpConfigDir() },
			sandbox,
		);

		// 4. Inject context
		await injectContext(workDir, task);

		// Verify workdir contents
		const config = JSON.parse(
			await readFile(join(workDir, "opencode.json"), "utf-8"),
		);
		expect(config.agent.coder.model).toBe("anthropic/claude-sonnet-4-20250514");
		expect(config.mcp).toBeUndefined(); // No MCP
		expect(config.skills).toBeUndefined(); // No skills
		expect(config.tools?.skill).toBe(false); // Skill disabled
		expect(config.permission.skill).toBe("deny"); // Skills denied

		// Context files
		expect(await pathExists(join(workDir, "package.json"))).toBe(true);
		expect(await pathExists(join(workDir, "app", "page.tsx"))).toBe(true);

		// Sandbox HOME should be isolated
		const homeConfig = JSON.parse(
			await readFile(
				join(sandbox.home, ".config", "opencode", "opencode.json"),
				"utf-8",
			),
		);
		expect(homeConfig.agent).toBeUndefined();
		expect(homeConfig.mcp).toEqual({});
	});
});

describe("end-to-end: context7 pipeline", () => {
	test("full context7 pipeline produces correct sandbox and workdir layout", async () => {
		const task = makeTask({
			id: "e2e-context7",
			context: {
				package_json: '{"dependencies": {"react": "19.0.0"}}',
			},
		});

		const sandbox = await createSandboxedHome(
			{ mcpConfigDir: getMcpConfigDir() },
			TEST_TEMP_DIR,
		);
		const workDir = await createWorkDir(task.id, "context7", 0, TEST_TEMP_DIR);
		await injectConfig(
			workDir,
			"context7",
			{ mcpConfigDir: getMcpConfigDir() },
			sandbox,
		);
		await injectContext(workDir, task);

		const config = JSON.parse(
			await readFile(join(workDir, "opencode.json"), "utf-8"),
		);

		// Context7 MCP server present
		expect(config.mcp.context7).toBeDefined();
		expect(config.mcp.context7.type).toBe("remote");
		expect(config.mcp.context7.url).toBe("https://mcp.context7.com/mcp");

		// Skills disabled
		expect(config.skills).toBeUndefined();
		expect(config.tools?.skill).toBe(false);
		expect(config.permission.skill).toBe("deny");

		// Context injected
		expect(await pathExists(join(workDir, "package.json"))).toBe(true);
	});
});

describe("end-to-end: nia pipeline", () => {
	test("full nia pipeline produces correct sandbox and workdir layout", async () => {
		const task = makeTask({
			id: "e2e-nia",
			context: {
				package_json: '{"dependencies": {"zod": "4.0.0"}}',
				code: { "schema.ts": 'import { z } from "zod";' },
			},
		});

		const sandbox = await createSandboxedHome(
			{ mcpConfigDir: getMcpConfigDir() },
			TEST_TEMP_DIR,
		);
		const workDir = await createWorkDir(task.id, "nia", 0, TEST_TEMP_DIR);
		await injectConfig(
			workDir,
			"nia",
			{ mcpConfigDir: getMcpConfigDir() },
			sandbox,
		);
		await injectContext(workDir, task);

		const config = JSON.parse(
			await readFile(join(workDir, "opencode.json"), "utf-8"),
		);

		// NO MCP servers
		expect(config.mcp).toBeUndefined();

		// Skills ARE configured
		expect(config.skills).toBeDefined();
		expect(config.skills.paths).toHaveLength(1);
		const skillsPath = config.skills.paths[0] as string;

		// Skills path is absolute and points to sandbox
		expect(skillsPath.startsWith("/")).toBe(true);
		expect(skillsPath).toContain(TEST_TEMP_DIR);

		// Skills path contains nia skill
		expect(await pathExists(join(skillsPath, "nia", "SKILL.md"))).toBe(true);
		expect(
			await pathExists(join(skillsPath, "nia", "scripts", "search.sh")),
		).toBe(true);

		// Skill permissions: allow only Nia (PascalCase)
		expect(config.permission.skill["*"]).toBe("deny");
		expect(config.permission.skill.Nia).toBe("allow");

		// Skill tool NOT disabled
		expect(config.tools?.skill).toBeUndefined();

		// No raw placeholders
		const raw = await readFile(join(workDir, "opencode.json"), "utf-8");
		expect(raw).not.toContain("$SKILLS_DIR");
		expect(raw).not.toContain("$MODEL");

		// Context injected
		expect(await pathExists(join(workDir, "package.json"))).toBe(true);
		expect(await pathExists(join(workDir, "schema.ts"))).toBe(true);
	});

	test("nia sandbox skills directory is separate from workdir", async () => {
		const sandbox = await createSandboxedHome(
			{ mcpConfigDir: getMcpConfigDir() },
			TEST_TEMP_DIR,
		);
		const workDir = await createWorkDir("test", "nia", 0, TEST_TEMP_DIR);
		await injectConfig(
			workDir,
			"nia",
			{ mcpConfigDir: getMcpConfigDir() },
			sandbox,
		);

		// Skills should be in sandbox HOME, not in workDir
		const skillsDir = requireSkillsDir(sandbox);
		expect(skillsDir.startsWith(sandbox.home)).toBe(true);
		expect(skillsDir.startsWith(workDir)).toBe(false);

		// workDir should NOT contain skills directory
		expect(await pathExists(join(workDir, "skills"))).toBe(false);
		expect(await pathExists(join(workDir, "nia"))).toBe(false);
	});
});

// ============================================================================
// 6. Sandbox environment simulation (what opencode would see)
// ============================================================================

describe("opencode environment simulation", () => {
	test("with HOME set to sandbox, opencode finds clean global config", async () => {
		const sandbox = await createSandboxedHome(
			{ mcpConfigDir: getMcpConfigDir() },
			TEST_TEMP_DIR,
		);

		// Simulate what opencode would see with HOME=sandbox.home
		// It looks for ~/.config/opencode/opencode.json
		const globalConfigPath = join(
			sandbox.home,
			".config",
			"opencode",
			"opencode.json",
		);
		expect(await pathExists(globalConfigPath)).toBe(true);

		const globalConfig = JSON.parse(await readFile(globalConfigPath, "utf-8"));

		// Global config should NOT have any condition-specific settings
		expect(globalConfig.agent).toBeUndefined();
		expect(globalConfig.mcp).toEqual({});
		expect(globalConfig.skills).toBeUndefined();

		// No skill permissions at global level (they come from CWD config)
		expect(globalConfig.permission.skill).toBeUndefined();
	});

	test("sandbox does NOT contain any of the real user HOME opencode config", async () => {
		const sandbox = await createSandboxedHome(
			{ mcpConfigDir: getMcpConfigDir() },
			TEST_TEMP_DIR,
		);

		// The sandbox should NOT contain directories that could leak real config
		// These are opencode external skill discovery paths
		const leakPaths = [
			join(sandbox.home, ".claude", "skills"),
			join(sandbox.home, ".agents", "skills"),
			join(sandbox.home, ".opencode", "skills"),
		];

		for (const leakPath of leakPaths) {
			expect(await pathExists(leakPath)).toBe(false);
		}
	});

	test("multiple sandboxes are fully independent", async () => {
		const sandbox1 = await createSandboxedHome(
			{ mcpConfigDir: getMcpConfigDir() },
			TEST_TEMP_DIR,
		);
		const sandbox2 = await createSandboxedHome(
			{ mcpConfigDir: getMcpConfigDir() },
			TEST_TEMP_DIR,
		);

		// Different HOME paths
		expect(sandbox1.home).not.toBe(sandbox2.home);

		// Different skills paths
		expect(sandbox1.skillsDir).not.toBe(sandbox2.skillsDir);

		// Both have independent skill copies
		const skills1 = requireSkillsDir(sandbox1);
		const skills2 = requireSkillsDir(sandbox2);
		const skill1 = await readFile(join(skills1, "nia", "SKILL.md"), "utf-8");
		const skill2 = await readFile(join(skills2, "nia", "SKILL.md"), "utf-8");
		expect(skill1).toBe(skill2);

		// Modifying one doesn't affect the other
		await writeFile(join(skills1, "nia", "SKILL.md"), "MODIFIED", "utf-8");
		const skill2After = await readFile(
			join(skills2, "nia", "SKILL.md"),
			"utf-8",
		);
		expect(skill2After).not.toBe("MODIFIED");
		expect(skill2After).toBe(skill2);
	});
});

// ============================================================================
// 7. Prompt suffix verification per condition
// ============================================================================

describe("prompt suffixes by condition", () => {
	const taskPrompt = "Using Next.js 16, create a file that uses the new API.";

	test("baseline prompt does NOT mention any tools or skills", () => {
		const prompt = buildPrompt(taskPrompt, "baseline");
		expect(prompt).not.toContain("context7");
		expect(prompt).not.toContain("MCP");
		expect(prompt).not.toContain("skill");
		expect(prompt).not.toContain("Nia");
		expect(prompt).not.toContain("search.sh");
	});

	test("context7 prompt mentions MCP tools but NOT skills or Nia", () => {
		const prompt = buildPrompt(taskPrompt, "context7");
		expect(prompt).toContain("context7 MCP tools");
		expect(prompt).toContain("resolve-library-id");
		expect(prompt).toContain("query-docs");
		expect(prompt).not.toContain("skill");
		expect(prompt).not.toContain("Nia");
	});

	test("nia prompt mentions skill and Nia but NOT context7 or MCP", () => {
		const prompt = buildPrompt(taskPrompt, "nia");
		expect(prompt).toContain("skill");
		expect(prompt).toContain("Nia");
		expect(prompt).toContain("sources.sh");
		expect(prompt).not.toContain("context7");
		expect(prompt).not.toContain("MCP");
	});
});

// ============================================================================
// 8. Regression guards for known bugs
// ============================================================================

describe("regression: known bugs", () => {
	test("nia permission is PascalCase 'Nia', not lowercase 'nia' (fixed bug)", async () => {
		// This was the root cause of Nia never being called in the benchmark.
		// SKILL.md defines name: Nia (PascalCase), but permission said "nia": "allow"
		// opencode's Wildcard.match() is case-sensitive, so it never matched.
		const niaConfigRaw = await readFile(
			join(getMcpConfigDir(), "nia.opencode.json"),
			"utf-8",
		);
		const niaConfig = JSON.parse(niaConfigRaw);

		const skillPerms = niaConfig.permission.skill as Record<string, string>;

		// Must have PascalCase "Nia"
		expect(skillPerms.Nia).toBe("allow");
		// Must NOT have lowercase "nia"
		expect(skillPerms.nia).toBeUndefined();
	});

	test("nia config uses skills.paths (not OPENCODE_CONFIG_DIR) for discovery", async () => {
		// Old approach: set OPENCODE_CONFIG_DIR env var, which didn't work.
		// New approach: skills.paths in CWD opencode.json.
		const niaConfigRaw = await readFile(
			join(getMcpConfigDir(), "nia.opencode.json"),
			"utf-8",
		);
		const niaConfig = JSON.parse(niaConfigRaw);

		// Config should have skills.paths with a placeholder
		expect(niaConfig.skills).toBeDefined();
		expect(niaConfig.skills.paths).toEqual(["$SKILLS_DIR"]);
	});

	test("baseline and context7 cannot accidentally discover skills", async () => {
		// Even though sandbox copies skills, baseline/context7 should:
		// 1. Not have skills.paths
		// 2. Have tools.skill: false
		// 3. Have permission.skill: "deny"
		for (const condition of ["baseline", "context7"] as Condition[]) {
			const sandbox = await createSandboxedHome(
				{ mcpConfigDir: getMcpConfigDir() },
				TEST_TEMP_DIR,
			);
			const workDir = await createWorkDir("test", condition, 0, TEST_TEMP_DIR);
			await injectConfig(
				workDir,
				condition,
				{ mcpConfigDir: getMcpConfigDir() },
				sandbox,
			);

			const config = JSON.parse(
				await readFile(join(workDir, "opencode.json"), "utf-8"),
			);

			// Triple protection: no paths, tool disabled, permission denied
			expect(config.skills).toBeUndefined();
			expect(config.tools?.skill).toBe(false);
			expect(config.permission.skill).toBe("deny");
		}
	});

	test("sandbox HOME config does not contain any skill permissions that could override CWD", async () => {
		// The HOME config is a clean slate. Condition-specific skill permissions
		// come from the CWD opencode.json. If HOME config had skill permissions,
		// they could interfere with CWD-level settings.
		const sandbox = await createSandboxedHome(
			{ mcpConfigDir: getMcpConfigDir() },
			TEST_TEMP_DIR,
		);

		const homeConfig = JSON.parse(
			await readFile(
				join(sandbox.home, ".config", "opencode", "opencode.json"),
				"utf-8",
			),
		);

		expect(homeConfig.permission.skill).toBeUndefined();
		expect(homeConfig.tools).toBeUndefined();
	});
});
