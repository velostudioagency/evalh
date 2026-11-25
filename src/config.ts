import { readFile } from "node:fs/promises";
import { homedir, hostname as osHostname } from "node:os";
import { parse } from "yaml";
import { HarnessError } from "./errors.ts";
import {
	type EnvConfig,
	HARNESS_IDS,
	type HarnessId,
	type LimitsConfig,
	type ModelRef,
	OS_IDS,
	type OsId,
	type RawTaskConfig,
	SHELL_IDS,
	type ShellId,
	SYSTEM_PROMPT_MODES,
	type SystemPromptConfig,
	type TaskConfig,
	TOOL_FAMILY_IDS,
	TRACE_FORMATS,
	type TraceConfig,
	type TraceFormat,
} from "./types.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function hostOs(): OsId {
	if (process.platform === "win32") return "win32";
	if (process.platform === "darwin") return "darwin";
	return "linux";
}

function hostShell(os: OsId): ShellId {
	if (os === "win32") return "powershell";
	if (os === "darwin") return "zsh";
	return "bash";
}

export const DEFAULT_CONFIG: TaskConfig = {
	harness: "pi",
	model: "anthropic/claude-sonnet-4-5",
	thinkingLevel: "off",
	toolFamily: "pi",
	systemPrompt: {
		mode: "pi",
		realism: true,
	},
	env: {
		os: hostOs(),
		shell: hostShell(hostOs()),
		user: process.env.USERNAME ?? process.env.USER ?? "dev",
		hostname: osHostname(),
		home: homedir(),
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
		git: true,
	},
	limits: {
		maxTurns: 40,
		timeoutSec: 900,
	},
	trace: {
		formats: ["qwen3", "jsonl"],
		includeThinking: true,
		includeToolSchemas: true,
	},
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readYamlFile(path: string): Promise<Record<string, unknown>> {
	const text = await readFile(path, "utf8");
	let value: unknown;
	try {
		value = parse(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new HarnessError("yaml_invalid", `Could not parse ${path}: ${message}`);
	}
	if (value === null || value === undefined) return {};
	if (!isRecord(value)) {
		throw new HarnessError("yaml_invalid", `${path} must contain a YAML mapping at the top level`);
	}
	return value;
}

export function parseModelRef(spec: string): ModelRef {
	const trimmed = spec.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) {
		throw new HarnessError(
			"model_invalid",
			`Model must be written as provider/model, got "${spec}"`,
			"Example: anthropic/claude-sonnet-4-5",
		);
	}
	return {
		provider: trimmed.slice(0, slash),
		id: trimmed.slice(slash + 1),
		spec: trimmed,
	};
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		throw new HarnessError("config_invalid", `${field} must be one of: ${allowed.join(", ")}`);
	}
	return value as T;
}

/** Parse one trace format from a CLI flag using the same error as the YAML path. */
export function parseTraceFormat(value: string, field = "trace.formats"): TraceFormat {
	return oneOf(value, TRACE_FORMATS, field);
}

function positiveInt(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new HarnessError("config_invalid", `${field} must be a positive number`);
	}
	return Math.floor(value);
}

function stringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
		throw new HarnessError("config_invalid", `${field} must be a list of non-empty strings`);
	}
	return [...new Set(value)];
}

function mergeEnv(base: EnvConfig, raw: Partial<EnvConfig> | undefined): EnvConfig {
	if (!raw) return base;
	const next = { ...base };
	if (raw.os !== undefined) next.os = oneOf(raw.os, OS_IDS, "env.os");
	if (raw.shell !== undefined) next.shell = oneOf(raw.shell, SHELL_IDS, "env.shell");
	if (raw.cwd !== undefined) {
		if (typeof raw.cwd !== "string" || raw.cwd.length === 0) {
			throw new HarnessError("config_invalid", "env.cwd must be a non-empty string");
		}
		next.cwd = raw.cwd;
	}
	if (raw.user !== undefined) next.user = String(raw.user);
	if (raw.hostname !== undefined) next.hostname = String(raw.hostname);
	if (raw.home !== undefined) next.home = String(raw.home);
	if (raw.timezone !== undefined) next.timezone = String(raw.timezone);
	if (raw.git !== undefined) next.git = Boolean(raw.git);
	return next;
}

function mergeLimits(base: LimitsConfig, raw: Partial<LimitsConfig> | undefined): LimitsConfig {
	if (!raw) return base;
	const next = { ...base };
	if (raw.maxTurns !== undefined) next.maxTurns = positiveInt(raw.maxTurns, "limits.maxTurns");
	if (raw.timeoutSec !== undefined) next.timeoutSec = positiveInt(raw.timeoutSec, "limits.timeoutSec");
	return next;
}

function mergeTrace(base: TraceConfig, raw: Partial<TraceConfig> | undefined): TraceConfig {
	if (!raw) return base;
	const next = { ...base };
	if (raw.formats !== undefined) {
		const formats = stringArray(raw.formats, "trace.formats");
		next.formats = formats.map((format) => oneOf(format, TRACE_FORMATS, "trace.formats")) as TraceFormat[];
	}
	if (raw.includeThinking !== undefined) next.includeThinking = Boolean(raw.includeThinking);
	if (raw.includeToolSchemas !== undefined) next.includeToolSchemas = Boolean(raw.includeToolSchemas);
	return next;
}

function mergeSystemPrompt(base: SystemPromptConfig, raw: Partial<SystemPromptConfig> | undefined): SystemPromptConfig {
	if (!raw) return base;
	const next = { ...base };
	if (raw.mode !== undefined) next.mode = oneOf(raw.mode, SYSTEM_PROMPT_MODES, "systemPrompt.mode");
	if (raw.file !== undefined) next.file = String(raw.file);
	if (raw.template !== undefined) next.template = String(raw.template);
	if (raw.append !== undefined) next.append = String(raw.append);
	if (raw.realism !== undefined) next.realism = Boolean(raw.realism);
	return next;
}

export function mergeTaskConfig(base: TaskConfig, ...overrides: Array<RawTaskConfig | undefined>): TaskConfig {
	const next = structuredClone(base);
	let toolFamilyExplicit = false;
	for (const raw of overrides) {
		if (!raw) continue;
		if (raw.harness !== undefined) next.harness = oneOf(raw.harness, HARNESS_IDS, "harness") as HarnessId;
		if (raw.model !== undefined) next.model = String(raw.model);
		if (raw.thinkingLevel !== undefined) {
			next.thinkingLevel = oneOf(raw.thinkingLevel, THINKING_LEVELS, "thinkingLevel");
		}
		if (raw.toolFamily !== undefined) {
			next.toolFamily = String(raw.toolFamily);
			toolFamilyExplicit = true;
		}
		if (raw.tools !== undefined) next.tools = stringArray(raw.tools, "tools");
		next.env = mergeEnv(next.env, raw.env);
		next.limits = mergeLimits(next.limits, raw.limits);
		next.trace = mergeTrace(next.trace, raw.trace);
		next.systemPrompt = mergeSystemPrompt(next.systemPrompt, raw.systemPrompt);
	}
	// The omp harness uses the portable tool set unless a tool family was actually configured.
	if (next.harness === "omp" && !toolFamilyExplicit) {
		next.toolFamily = "omp";
	}
	validateTaskConfig(next);
	return next;
}

export function validateTaskConfig(config: TaskConfig): void {
	parseModelRef(config.model);
	if (!TOOL_FAMILY_IDS.includes(config.toolFamily)) {
		throw new HarnessError(
			"tool_family_unknown",
			`Unknown tool family "${config.toolFamily}"`,
			"Use one of: pi, omp, custom.",
		);
	}
	if (config.harness !== "pi" && config.harness !== "omp") {
		const hint =
			config.harness === "custom"
				? 'The custom harness is not implemented. Use harness "pi" or "omp"; for a custom tool set use toolFamily: custom with a tools list.'
				: 'Use harness "pi" or "omp".';
		throw new HarnessError(
			"harness_unsupported",
			`Harness "${config.harness}" is not implemented`,
			hint,
		);
	}
	if (config.toolFamily === "custom" && (!config.tools || config.tools.length === 0)) {
		throw new HarnessError(
			"tools_missing",
			"toolFamily custom requires a non-empty tools list",
			"Set tools: [read, bash, ...] in task.yaml or family.yaml.",
		);
	}
	if (!THINKING_LEVELS.includes(config.thinkingLevel as (typeof THINKING_LEVELS)[number])) {
		throw new HarnessError("config_invalid", `thinkingLevel must be one of: ${THINKING_LEVELS.join(", ")}`);
	}
	if (config.systemPrompt.mode === "custom" && !config.systemPrompt.file) {
		throw new HarnessError("config_invalid", "systemPrompt.file is required when mode is custom");
	}
	if (config.systemPrompt.mode === "template" && !config.systemPrompt.template) {
		throw new HarnessError("config_invalid", "systemPrompt.template is required when mode is template");
	}
	if (config.trace.formats.length === 0) {
		throw new HarnessError("config_invalid", "trace.formats must contain at least one format");
	}
}
