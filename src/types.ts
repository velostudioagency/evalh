export type OsId = "linux" | "darwin" | "win32";
export type ShellId = "bash" | "zsh" | "sh" | "powershell";
export type HarnessId = "pi" | "omp" | "custom";
export type TraceFormat = "qwen3" | "jsonl";
export type SystemPromptMode = "pi" | "custom" | "template";
export type RunStatus = "created" | "running" | "completed" | "failed" | "aborted";

export const OS_IDS: readonly OsId[] = ["linux", "darwin", "win32"];
export const SHELL_IDS: readonly ShellId[] = ["bash", "zsh", "sh", "powershell"];
export const HARNESS_IDS: readonly HarnessId[] = ["pi", "omp", "custom"];
export const TRACE_FORMATS: readonly TraceFormat[] = ["qwen3", "jsonl"];
export const SYSTEM_PROMPT_MODES: readonly SystemPromptMode[] = ["pi", "custom", "template"];
export const TOOL_FAMILY_IDS: readonly string[] = ["pi", "omp", "custom"];

export interface TraceConfig {
	formats: TraceFormat[];
	includeThinking: boolean;
	includeToolSchemas: boolean;
}

export interface LimitsConfig {
	maxTurns: number;
	timeoutSec: number;
}

export interface EnvConfig {
	os: OsId;
	shell: ShellId;
	/** Simulated working directory. Local runs use the real workspace path unless this is set. */
	cwd?: string;
	user: string;
	hostname: string;
	home: string;
	timezone: string;
	git: boolean;
}

export interface SystemPromptConfig {
	mode: SystemPromptMode;
	/** Prompt file relative to the task directory, used by `custom` mode. */
	file?: string;
	/** Inline template, used by `template` mode. */
	template?: string;
	/** Extra text appended to the rendered prompt. */
	append?: string;
	/** Strip eval-specific wording and use the OS persona in the prompt. */
	realism: boolean;
}

export interface TaskConfig {
	harness: HarnessId;
	model: string;
	thinkingLevel: string;
	toolFamily: string;
	tools?: string[];
	systemPrompt: SystemPromptConfig;
	env: EnvConfig;
	limits: LimitsConfig;
	trace: TraceConfig;
}

export interface RawTaskConfig {
	harness?: string;
	model?: string;
	thinkingLevel?: string;
	toolFamily?: string;
	tools?: string[];
	systemPrompt?: Partial<SystemPromptConfig>;
	env?: Partial<EnvConfig>;
	limits?: Partial<LimitsConfig>;
	trace?: Partial<TraceConfig>;
}

export interface RawFamilyFile extends RawTaskConfig {
	name?: string;
	description?: string;
	defaults?: RawTaskConfig;
}

export interface RawTaskFile extends RawTaskConfig {
	id?: string;
	prompt?: string;
	repo?: string;
}

export interface ResolvedTask {
	id: string;
	family: string;
	dir: string;
	promptPath: string;
	repoDir: string;
	config: TaskConfig;
}

export interface ModelRef {
	provider: string;
	id: string;
	spec: string;
}

export interface RunPaths {
	runDir: string;
	metaPath: string;
	inputDir: string;
	workspaceDir: string;
	eventsPath: string;
	sessionPath: string;
	requestsDir: string;
	responsesDir: string;
	tracesDir: string;
	logsDir: string;
	diffPath: string;
}

export interface Usage {
	input?: number | undefined;
	output?: number | undefined;
	cacheRead?: number | undefined;
	cacheWrite?: number | undefined;
	totalTokens?: number | undefined;
	cost?: unknown;
}

export interface TraceExportFailure {
	format: TraceFormat;
	code: string;
	message: string;
	hint?: string | undefined;
}

export interface TraceExportSummary {
	paths: string[];
	failures: TraceExportFailure[];
}

export interface RunResult {
	status: RunStatus;
	turns: number;
	usage?: Usage;
	durationMs: number;
	error?: string | undefined;
	traces?: TraceExportSummary;
}

export interface RunMeta {
	version: 1;
	id: string;
	createdAt: string;
	updatedAt: string;
	status: RunStatus;
	task: {
		id: string;
		family: string;
		dir: string;
		promptPath: string;
		repoDir: string;
	};
	model: ModelRef;
	config: TaskConfig;
	paths: RunPaths;
	workspace: {
		git: boolean;
		baseCommit?: string | undefined;
	};
	result?: RunResult;
}

export interface CanonicalEventBase {
	seq: number;
	ts: string;
	type: string;
}

export interface RunStartEvent extends CanonicalEventBase {
	type: "run_start";
	task: string;
	family: string;
	harness: string;
	model: string;
	env: EnvConfig;
}

export interface MessageEvent extends CanonicalEventBase {
	type: "message";
	role: string;
	content: unknown;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	usage?: Usage | undefined;
}

export interface ModelRequestEvent extends CanonicalEventBase {
	type: "model_request";
	requestId: string;
	path: string;
}

export interface ProviderResponseEvent extends CanonicalEventBase {
	type: "provider_response";
	status: number;
	headers: Record<string, string>;
}

export interface ResponseEvent extends CanonicalEventBase {
	type: "response";
	role: "assistant";
	path: string;
}

export interface ToolCallEvent extends CanonicalEventBase {
	type: "tool_call";
	id: string;
	name: string;
	arguments: unknown;
}

export interface ToolResultEvent extends CanonicalEventBase {
	type: "tool_result";
	id: string;
	name: string;
	content: unknown;
	isError: boolean;
	durationMs?: number | undefined;
}

export interface ErrorEvent extends CanonicalEventBase {
	type: "error";
	message: string;
	code?: string;
	stack?: string | undefined;
}

export interface RunEndEvent extends CanonicalEventBase {
	type: "run_end";
	status: RunStatus;
	turns: number;
	usage?: Usage;
	durationMs: number;
}

export type CanonicalEvent =
	| RunStartEvent
	| MessageEvent
	| ModelRequestEvent
	| ProviderResponseEvent
	| ResponseEvent
	| ToolCallEvent
	| ToolResultEvent
	| ErrorEvent
	| RunEndEvent;
