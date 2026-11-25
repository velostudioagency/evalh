#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG, parseModelRef, parseTraceFormat, validateTaskConfig } from "./config.ts";
import { asHarnessError, HarnessError } from "./errors.ts";
import { runPiTask } from "./harness/pi-runner.ts";
import { RunStore, readRunMeta } from "./run-store.ts";
import { discoverTasks, loadTask, scaffoldFamily } from "./task.ts";
import { describeTraceFailure, exportTraces } from "./trace/index.ts";
import { runWizard } from "./tui.ts";
import type { TraceExportFailure } from "./types.ts";
import { materializeWorkspace } from "./workspace.ts";

interface ParsedArgs {
	command: string;
	positionals: string[];
	flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
	const positionals: string[] = [];
	const flags: Record<string, string | boolean> = {};
	let command = "";

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			if (eq !== -1) {
				flags[arg.slice(2, eq)] = arg.slice(eq + 1);
			} else {
				const key = arg.slice(2);
				const next = argv[i + 1];
				if (next !== undefined && !next.startsWith("-")) {
					flags[key] = next;
					i += 1;
				} else {
					flags[key] = true;
				}
			}
		} else if (arg === "-h") {
			flags.help = true;
		} else if (!command) {
			command = arg;
		} else {
			positionals.push(arg);
		}
	}

	return { command, positionals, flags };
}

function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
	const value = flags[key];
	return typeof value === "string" ? value : undefined;
}

function flagNumber(flags: Record<string, string | boolean>, key: string): number | undefined {
	const value = flagString(flags, key);
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new HarnessError("flag_invalid", `--${key} must be a positive number`);
	}
	return parsed;
}

function help(): void {
	console.log(`evalh - agent evaluation harness

Usage:
  evalh                                    Launch the interactive wizard (TTY only)
  evalh init <dir>                         Create a task family with an example task
  evalh list [tasksDir]                    List discovered tasks
  evalh run <taskDir> [options]            Run one task in a fresh workspace
  evalh show <runDir>                      Show a run summary
  evalh export <runDir> [options]          Re-export traces from a run
  evalh doctor                             Check model, git, and config setup

Run options:
  --model <provider/model>   Override the task model
  --harness <pi|omp>         Override the harness profile
  --tool-family <name>       Override the tool family
  --format <qwen3,jsonl>     Trace formats: qwen3, jsonl
  --max-turns <n>            Stop after n turns
  --timeout <seconds>        Stop after n seconds
  --runs-dir <dir>           Where runs are written (default: ./runs)
  --quiet                    Print only the final result

Examples:
  evalh init tasks/my-family
  evalh run tasks/my-family/example-task --model anthropic/claude-sonnet-4-5
  evalh show runs/<run-id>
  evalh export runs/<run-id> --format qwen3

Docs: packages/eval-harness/README.md
`);
}

function reportHarnessError(error: unknown): number {
	const harnessError = asHarnessError(error);
	console.error(`error: ${harnessError.message}`);
	if (harnessError.hint) console.error(`hint:  ${harnessError.hint}`);
	if (process.env.EVALH_DEBUG === "1" && error instanceof Error && error.stack) {
		console.error(error.stack);
	}
	return 1;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function applyOverrides(task: Awaited<ReturnType<typeof loadTask>>, flags: Record<string, string | boolean>): void {
	const config = task.config;
	const model = flagString(flags, "model");
	if (model) config.model = model;

	const harness = flagString(flags, "harness");
	if (harness) {
		if (harness !== "pi" && harness !== "omp" && harness !== "custom") {
			throw new HarnessError("flag_invalid", "--harness must be pi, omp, or custom");
		}
		config.harness = harness;
	}

	const toolFamily = flagString(flags, "tool-family");
	if (toolFamily) config.toolFamily = toolFamily;

	const formats = flagString(flags, "format");
	if (formats) {
		config.trace.formats = formats
			.split(",")
			.map((item) => item.trim())
			.filter((item) => item.length > 0)
			.map((item) => parseTraceFormat(item));
	}

	const maxTurns = flagNumber(flags, "max-turns");
	if (maxTurns !== undefined) config.limits.maxTurns = Math.floor(maxTurns);

	const timeout = flagNumber(flags, "timeout");
	if (timeout !== undefined) config.limits.timeoutSec = Math.floor(timeout);

	validateTaskConfig(config);
}

async function commandRun(args: ParsedArgs): Promise<number> {
	const taskDir = args.positionals[0];
	if (!taskDir) throw new HarnessError("usage", "Missing task directory", "Usage: evalh run <taskDir>");

	const task = await loadTask(taskDir);
	applyOverrides(task, args.flags);
	const model = parseModelRef(task.config.model);
	const runsDir = resolve(flagString(args.flags, "runs-dir") ?? join(process.cwd(), "runs"));
	const quiet = args.flags.quiet === true;

	const run = await RunStore.create(task, { runsDir, model });
	if (!quiet) {
		console.log(`Run:       ${run.dir}`);
		console.log(`Task:      ${task.family}/${task.id}`);
		console.log(`Model:     ${task.config.model}`);
		console.log(`Harness:   ${task.config.harness}`);
		console.log(`Tool set:  ${task.config.toolFamily}`);
	}

	const materialized = await materializeWorkspace(
		task.repoDir,
		join(run.dir, run.meta.paths.inputDir),
		join(run.dir, run.meta.paths.workspaceDir),
		{ git: task.config.env.git },
	);
	await run.setWorkspace({ git: materialized.git, baseCommit: materialized.baseCommit });
	if (materialized.warning && !quiet) console.warn(`Warning:   ${materialized.warning}`);

	const result = await runPiTask({
		task,
		run,
		workspaceDir: join(run.dir, run.meta.paths.workspaceDir),
	});

	if (!quiet) {
		console.log(`Status:    ${result.status}`);
		console.log(`Turns:     ${result.turns}`);
		console.log(`Duration:  ${formatDuration(result.durationMs)}`);
		if (result.error) console.log(`Error:     ${result.error}`);
		console.log(`Workspace: ${join(run.dir, run.meta.paths.workspaceDir)}`);
		console.log(`Diff:      ${join(run.dir, run.meta.paths.diffPath)}`);
		for (const path of result.traces?.paths ?? []) console.log(`Trace:     ${path}`);
		for (const failure of result.traces?.failures ?? []) console.warn(describeTraceFailure(failure));
	} else {
		console.log(`${result.status} ${run.dir}`);
	}

	return result.status === "completed" ? 0 : 1;
}

/** Run one task with CLI-style flag overrides, returning the CLI exit code. */
export async function runTaskMain(taskDir: string, overrides: Record<string, string | boolean> = {}): Promise<number> {
	return commandRun({ command: "run", positionals: [taskDir], flags: overrides });
}

async function commandInit(args: ParsedArgs): Promise<number> {
	const target = args.positionals[0];
	if (!target) throw new HarnessError("usage", "Missing target directory", "Usage: evalh init <dir>");
	const dir = await scaffoldFamily(target, { force: args.flags.force === true });
	console.log(`Created task family: ${dir}`);
	console.log("");
	console.log("Next:");
	console.log(`  evalh run ${join(dir, "example-task")} --model anthropic/claude-sonnet-4-5`);
	return 0;
}

async function commandList(args: ParsedArgs): Promise<number> {
	const root = resolve(args.positionals[0] ?? join(process.cwd(), "tasks"));
	const tasks = await discoverTasks(root);
	if (tasks.length === 0) {
		console.log(`No tasks found under ${root}`);
		return 0;
	}
	const width = Math.max(...tasks.map((task) => `${task.family}/${task.id}`.length));
	for (const task of tasks) {
		const label = `${task.family}/${task.id}`.padEnd(width);
		console.log(`${label}  ${task.config.model}  [${task.config.toolFamily}]`);
	}
	return 0;
}

async function commandShow(args: ParsedArgs): Promise<number> {
	const runDir = args.positionals[0];
	if (!runDir) throw new HarnessError("usage", "Missing run directory", "Usage: evalh show <runDir>");
	const meta = await readRunMeta(runDir);

	if (args.flags.json === true) {
		console.log(JSON.stringify(meta, null, 2));
		return 0;
	}

	console.log(`Run:        ${meta.id}`);
	console.log(`Status:     ${meta.status}`);
	console.log(`Task:       ${meta.task.family}/${meta.task.id}`);
	console.log(`Model:      ${meta.model.spec}`);
	console.log(`Harness:    ${meta.config.harness}`);
	console.log(`Tool set:   ${meta.config.toolFamily}`);
	console.log(`Created:    ${meta.createdAt}`);
	if (meta.result) {
		console.log(`Turns:      ${meta.result.turns}`);
		console.log(`Duration:   ${formatDuration(meta.result.durationMs)}`);
		if (meta.result.error) console.log(`Error:      ${meta.result.error}`);
	}
	console.log(`Workspace:  ${join(meta.paths.runDir, meta.paths.workspaceDir)}`);
	console.log(`Diff:       ${join(meta.paths.runDir, meta.paths.diffPath)}`);
	console.log(`Events:     ${join(meta.paths.runDir, meta.paths.eventsPath)}`);
	return 0;
}

async function commandExport(args: ParsedArgs): Promise<number> {
	const runDir = args.positionals[0];
	if (!runDir) throw new HarnessError("usage", "Missing run directory", "Usage: evalh export <runDir>");
	const meta = await readRunMeta(runDir);
	const store = await RunStore.open(runDir);
	const events = await store.readEvents();

	const systemPrompt = await readFile(join(meta.paths.runDir, "logs", "system-prompt.txt"), "utf8").catch(() => "");
	const prompt = await readFile(join(meta.paths.runDir, "logs", "prompt.md"), "utf8").catch(() => "");
	const toolsText = await readFile(join(meta.paths.runDir, "logs", "tools.json"), "utf8").catch(() => "[]");
	const tools = JSON.parse(toolsText) as Array<{ name: string; description: string; parameters: unknown }>;

	const requested = flagString(args.flags, "format");
	const formats = requested
		? requested
				.split(",")
				.map((item) => item.trim())
				.filter(Boolean)
				.map((item) => parseTraceFormat(item))
		: meta.config.trace.formats;

	const failures: TraceExportFailure[] = [];
	const written = await exportTraces(
		{ events, systemPrompt, prompt, tools, config: { ...meta.config, trace: { ...meta.config.trace, formats } } },
		join(meta.paths.runDir, meta.paths.tracesDir),
		(failure) => failures.push(failure),
	);

	for (const path of written) console.log(path);
	for (const failure of failures) console.warn(describeTraceFailure(failure));
	return 0;
}

async function commandDoctor(): Promise<number> {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	console.log(`Node:       ${process.version}`);
	console.log(`Platform:   ${process.platform}`);
	console.log(`CWD:        ${process.cwd()}`);
	console.log(`Agent dir:  ${agentDir}`);

	for (const name of ["auth.json", "models.json"]) {
		const path = join(agentDir, name);
		const ok = await access(path).then(
			() => true,
			() => false,
		);
		console.log(`${name.padEnd(12)}${ok ? "found" : "missing"} (${path})`);
	}

	const git = await new Promise<string>((resolvePromise) => {
		execFile("git", ["--version"], (error, stdout) => {
			resolvePromise(error ? "not available" : stdout.trim());
		});
	});
	console.log(`Git:        ${git}`);
	console.log("");
	console.log("Default config:");
	console.log(JSON.stringify(DEFAULT_CONFIG, null, 2));
	console.log("");
	console.log("If a model is missing, authenticate with pi or add it to models.json.");
	return 0;
}

export async function main(argv: string[]): Promise<number> {
	const args = parseArgs(argv);
	if (args.flags.help === true || args.command === "help") {
		help();
		return 0;
	}
	if (!args.command) {
		if (!process.stdin.isTTY) {
			console.log("Run evalh --help for commands, or `evalh` in a terminal for the wizard.");
			return 0;
		}
		if (process.stdout.isTTY) {
			try {
				await runWizard();
				return 0;
			} catch (error) {
				return reportHarnessError(error);
			}
		}
		help();
		return 0;
	}

	try {
		switch (args.command) {
			case "init":
				return await commandInit(args);
			case "list":
				return await commandList(args);
			case "run":
				return await commandRun(args);
			case "show":
				return await commandShow(args);
			case "export":
				return await commandExport(args);
			case "doctor":
				return await commandDoctor();
			default:
				throw new HarnessError("usage", `Unknown command: ${args.command}`, "Run `evalh help`.");
		}
	} catch (error) {
		return reportHarnessError(error);
	}
}
