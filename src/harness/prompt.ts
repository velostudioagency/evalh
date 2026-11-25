import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { HarnessError } from "../errors.ts";
import type { EnvConfig, ResolvedTask, TaskConfig } from "../types.ts";
import { resolveToolNames } from "./tool-families.ts";

export interface PromptBundle {
	/** Custom system prompt: custom/template mode, or realism in pi mode. Undefined means pi's default. */
	systemPrompt?: string | undefined;
	/** Blocks appended after the base system prompt. */
	append: string[];
	envBlock: string;
}

function osLabel(os: EnvConfig["os"]): string {
	switch (os) {
		case "darwin":
			return "macOS (Darwin)";
		case "win32":
			return "Windows";
		default:
			return "Linux";
	}
}

function renderEnvBlock(env: EnvConfig, workspaceDir: string): string {
	const cwd = env.cwd ?? workspaceDir;
	return [
		"<environment>",
		`OS: ${osLabel(env.os)}`,
		`Shell: ${env.shell}`,
		`Working directory: ${cwd}`,
		`User: ${env.user}`,
		`Hostname: ${env.hostname}`,
		`Home: ${env.home}`,
		`Timezone: ${env.timezone}`,
		"</environment>",
	].join("\n");
}

function renderTemplate(template: string, vars: Record<string, string>): string {
	return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key: string) => {
		return key in vars ? vars[key] : match;
	});
}

const NEUTRAL_PREAMBLE =
	"You are a coding assistant operating on this machine. Help users inspect files, run commands, and modify code.";

/** The hint pi attaches to shell tools; it advertises the harness to the model. */
const PI_ENV_HINT = /PI[ \t]*_[ \t]*\*/i;

interface ToolPromptInfo {
	promptSnippet?: string;
	promptGuidelines?: string[];
}

const TOOL_PROMPTS: Record<string, (cwd: string) => ToolPromptInfo> = {
	read: createReadToolDefinition,
	bash: createBashToolDefinition,
	powershell: createPowerShellToolDefinition,
	edit: createEditToolDefinition,
	write: createWriteToolDefinition,
	grep: createGrepToolDefinition,
	find: createFindToolDefinition,
	ls: createLsToolDefinition,
};

function section(name: string, body: string): string {
	return `<${name}>\n${body}\n</${name}>`;
}

/**
 * Build a pi-shaped system prompt with pi's identity and documentation removed.
 *
 * Passing a custom prompt to pi replaces only the preamble: the loader still appends
 * the `<addendum>` (from `appendSystemPrompt`) and `<cwd>` sections, but does not
 * generate its own `<tools>`, `<rules>`, or `<docs>`. We supply the first two here so
 * the model keeps the tool guidance without the harness hints.
 */
export function buildNeutralSystemPrompt(config: TaskConfig, workspaceDir: string): string {
	const tools = resolveToolNames(config.toolFamily, config.tools) ?? [];
	const prompts = new Map<string, ToolPromptInfo>();
	for (const name of tools) {
		const factory = TOOL_PROMPTS[name];
		if (factory) prompts.set(name, factory(workspaceDir));
	}

	const snippets = [...prompts.entries()]
		.filter(([, prompt]) => prompt.promptSnippet)
		.map(([name, prompt]) => `- ${name}: ${prompt.promptSnippet}`);
	const toolsBody = `${snippets.length > 0 ? snippets.join("\n") : "(none)"}\n\nAdditional tools may be available.`;

	const rules: string[] = [];
	const seen = new Set<string>();
	const addRule = (rule: string): void => {
		const normalized = rule.trim();
		if (!normalized || seen.has(normalized) || PI_ENV_HINT.test(normalized)) return;
		seen.add(normalized);
		rules.push(normalized);
	};
	const hasBash = tools.includes("bash");
	const hasPowerShell = tools.includes("powershell");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	if ((hasBash || hasPowerShell) && !hasGrep && !hasFind && !hasLs) {
		if (hasBash && hasPowerShell) addRule("Use bash or PowerShell for file operations like listing, searching, and finding files");
		else if (hasPowerShell) addRule("Use PowerShell for file operations like listing, searching, and finding files");
		else addRule("Use bash for file operations like ls, rg, find");
	}
	for (const name of tools) {
		for (const guideline of prompts.get(name)?.promptGuidelines ?? []) addRule(guideline);
	}
	addRule("Be concise in your responses");
	addRule("Show file paths clearly when working with files");
	const rulesBody = rules.map((rule) => `- ${rule}`).join("\n");

	return [NEUTRAL_PREAMBLE, section("tools", toolsBody), section("rules", rulesBody)].join("\n\n");
}

export async function buildPromptBundle(task: ResolvedTask, workspaceDir: string): Promise<PromptBundle> {
	const config = task.config;
	const env = { ...config.env, cwd: config.env.cwd ?? workspaceDir };
	const envBlock = renderEnvBlock(env, workspaceDir);
	const append: string[] = [envBlock];

	if (config.systemPrompt.append) append.push(config.systemPrompt.append);

	let systemPrompt: string | undefined;
	if (config.systemPrompt.mode === "custom") {
		const path = resolve(task.dir, config.systemPrompt.file ?? "system.md");
		try {
			systemPrompt = await readFile(path, "utf8");
		} catch {
			throw new HarnessError("prompt_missing", `System prompt file not found: ${path}`);
		}
	} else if (config.systemPrompt.mode === "template") {
		systemPrompt = renderTemplate(config.systemPrompt.template ?? "", {
			os: env.os,
			shell: env.shell,
			cwd: env.cwd ?? workspaceDir,
			user: env.user,
			hostname: env.hostname,
			home: env.home,
			timezone: env.timezone,
			task_id: task.id,
			family: task.family,
			repo: task.repoDir,
		});
	}

	// pi mode: realism leaves `systemPrompt` undefined so pi's default is used. With
	// realism on, replace pi's preamble/docs (and its PI_* hint) with a neutral prompt.
	if (config.systemPrompt.realism && config.systemPrompt.mode === "pi") {
		systemPrompt = buildNeutralSystemPrompt(config, workspaceDir);
	}

	return { systemPrompt, append, envBlock };
}
