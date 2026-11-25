import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { parseModelRef, parseTraceFormat } from "./config.ts";
import { asHarnessError } from "./errors.ts";
import { runTaskMain } from "./main.ts";
import { listRuns } from "./run-store.ts";
import { discoverTasks, scaffoldFamily } from "./task.ts";
import type { ResolvedTask, RunMeta } from "./types.ts";
import { TRACE_FORMATS } from "./types.ts";

const SUGGESTED_PROVIDERS = ["opencode", "lmstudio", "groq"];
const MODEL_QUERY_TIMEOUT_MS = 10_000;

/** Raised when the user cancels a prompt with Ctrl+C or Ctrl+D. */
class WizardExit extends Error {
	constructor() {
		super("wizard exit");
		this.name = "WizardExit";
	}
}

interface Choice<T> {
	label: string;
	value: T;
}

interface TaskFamily {
	name: string;
	tasks: ResolvedTask[];
}

type ModelChoice = { kind: "ref"; spec: string } | { kind: "manual" };

type MenuAction = "init" | "run" | "show" | "list" | "exit";

/** Ask one question, rejecting with WizardExit when input is cancelled. */
function askLine(prompt: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
	return new Promise<string>((resolveAnswer, rejectAnswer) => {
		let settled = false;
		const finish = (settle: () => void): void => {
			if (settled) return;
			settled = true;
			rl.close();
			settle();
		};
		rl.on("SIGINT", () => finish(() => rejectAnswer(new WizardExit())));
		rl.on("close", () => finish(() => rejectAnswer(new WizardExit())));
		rl.question(prompt, (answer) => finish(() => resolveAnswer(answer.trim())));
	});
}

/** Print numbered choices and re-ask until one is picked or input is cancelled. */
async function select<T>(choices: readonly Choice<T>[], prompt: string): Promise<T> {
	if (choices.length === 0) throw new Error(`No choices available: ${prompt}`);
	for (;;) {
		console.log(prompt);
		for (const [index, choice] of choices.entries()) console.log(`${index + 1}) ${choice.label}`);
		console.log();
		const answer = await askLine("Select > ");
		const index = Number(answer);
		if (Number.isInteger(index) && index >= 1 && index <= choices.length) return choices[index - 1].value;
		console.log(`Invalid selection: ${answer.length > 0 ? answer : "(empty)"}`);
	}
}

/** Print a harness error in the same shape as the CLI. */
function reportError(error: unknown): void {
	const harnessError = asHarnessError(error);
	console.error(`error: ${harnessError.message}`);
	if (harnessError.hint) console.error(`hint:  ${harnessError.hint}`);
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function tasksRoot(): string {
	return resolve(join(process.cwd(), "tasks"));
}

function runsRoot(): string {
	return resolve(join(process.cwd(), "runs"));
}

/** Show the wizard menu and dispatch actions until the user exits or cancels. */
export async function runWizard(): Promise<void> {
	try {
		for (;;) {
			const action = await select<MenuAction>(
				[
					{ label: "New task family      — run the init scaffold", value: "init" },
					{ label: "New run              — pick family, model, formats, run it", value: "run" },
					{ label: "Show a run           — pick a run, show summary", value: "show" },
					{ label: "List tasks", value: "list" },
					{ label: "Exit", value: "exit" },
				],
				"pi-eval harness (v0.2)\n",
			);
			switch (action) {
				case "init":
					await newFamily();
					break;
				case "run":
					await newRun();
					break;
				case "show":
					await showRun();
					break;
				case "list":
					await listTasks();
					break;
				case "exit":
					return;
			}
		}
	} catch (error) {
		if (error instanceof WizardExit) {
			console.log();
			return;
		}
		throw error;
	}
}

async function newFamily(): Promise<void> {
	const answer = await askLine("Family directory (default: tasks/my-family): ");
	const target = answer.length > 0 ? answer : "tasks/my-family";
	try {
		const dir = await scaffoldFamily(target);
		console.log(`Created task family: ${dir}`);
		console.log("Add tasks under this directory, then choose New run.");
	} catch (error) {
		reportError(error);
	}
}

async function listTasks(): Promise<void> {
	const root = tasksRoot();
	try {
		const tasks = await discoverTasks(root);
		if (tasks.length === 0) {
			console.log(`No tasks found under ${root}`);
			return;
		}
		const width = Math.max(...tasks.map((task) => `${task.family}/${task.id}`.length));
		for (const task of tasks) {
			const label = `${task.family}/${task.id}`.padEnd(width);
			console.log(`${label}  ${task.config.model}  [${task.config.toolFamily}]`);
		}
	} catch (error) {
		reportError(error);
	}
}

async function newRun(): Promise<void> {
	const root = tasksRoot();
	let tasks: ResolvedTask[];
	try {
		tasks = await discoverTasks(root);
	} catch (error) {
		reportError(error);
		return;
	}
	if (tasks.length === 0) {
		console.log(`No tasks found under ${root}`);
		return;
	}

	const families = groupFamilies(tasks);
	const family = await select(
		families.map((entry) => ({
			label: `${entry.name} (${entry.tasks.length} ${entry.tasks.length === 1 ? "task" : "tasks"})`,
			value: entry,
		})),
		"Choose a task family:",
	);
	const task =
		family.tasks.length === 1
			? family.tasks[0]
			: await select(
					family.tasks.map((entry) => ({ label: `${entry.id}  ${entry.config.model}`, value: entry })),
					`Choose a task in ${family.name}:`,
				);

	const model = await pickModel();
	const formats = await pickFormats();
	try {
		const code = await runTaskMain(task.dir, { model, format: formats.join(",") });
		if (code !== 0) console.log("Run completed with errors.");
	} catch (error) {
		reportError(error);
	}
}

function groupFamilies(tasks: readonly ResolvedTask[]): TaskFamily[] {
	const families: TaskFamily[] = [];
	const byName = new Map<string, TaskFamily>();
	for (const task of tasks) {
		let family = byName.get(task.family);
		if (family === undefined) {
			family = { name: task.family, tasks: [] };
			families.push(family);
			byName.set(task.family, family);
		}
		family.tasks.push(task);
	}
	return families;
}

async function pickModel(): Promise<string> {
	const refs = await availableModelRefs();
	const choices: Array<Choice<ModelChoice>> = refs.map((spec) => ({ label: spec, value: { kind: "ref", spec } }));
	choices.push({ label: "Enter a model spec manually", value: { kind: "manual" } });
	const picked = await select(choices, "Choose a model:");
	switch (picked.kind) {
		case "ref":
			return picked.spec;
		case "manual":
			return askModelRef();
	}
}

/** Prefer providers that work with a local key or no key, then show at most ten refs. */
async function availableModelRefs(): Promise<string[]> {
	try {
		const runtime = await ModelRuntime.create({});
		const models = await runtime.getAvailable(undefined, { signal: AbortSignal.timeout(MODEL_QUERY_TIMEOUT_MS) });
		const refs = [...new Set(models.map((model) => `${model.provider}/${model.id}`))];
		const ordered: string[] = [];
		for (const provider of SUGGESTED_PROVIDERS) {
			for (const ref of refs) {
				if (ref.startsWith(`${provider}/`)) ordered.push(ref);
			}
		}
		for (const ref of refs.sort((a, b) => a.localeCompare(b))) {
			if (!ordered.includes(ref)) ordered.push(ref);
		}
		return ordered.slice(0, 10);
	} catch (error) {
		reportError(error);
		return [];
	}
}

async function askModelRef(): Promise<string> {
	for (;;) {
		const spec = await askLine("Model (provider/id): ");
		try {
			return parseModelRef(spec).spec;
		} catch (error) {
			reportError(error);
		}
	}
}

async function pickFormats(): Promise<string[]> {
	for (;;) {
		const answer = await askLine(`Trace formats (comma-separated, default: ${TRACE_FORMATS.join(",")}): `);
		if (answer.length === 0) return [...TRACE_FORMATS];
		try {
			const formats = answer
				.split(",")
				.map((item) => item.trim())
				.filter((item) => item.length > 0)
				.map((item) => parseTraceFormat(item));
			return [...new Set(formats)];
		} catch (error) {
			reportError(error);
		}
	}
}

async function showRun(): Promise<void> {
	const root = runsRoot();
	let runs: RunMeta[];
	try {
		runs = await listRuns(root);
	} catch (error) {
		reportError(error);
		return;
	}
	if (runs.length === 0) {
		console.log(`No runs found under ${root}`);
		return;
	}
	const meta = await select(
		runs.map((run) => ({
			label: `${run.id}  ${run.status}  ${run.task.family}/${run.task.id}`,
			value: run,
		})),
		"Choose a run:",
	);
	printRunSummary(meta);
}

function printRunSummary(meta: RunMeta): void {
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
	const traces = meta.result?.traces;
	console.log(`Traces:     ${traces?.paths.length ?? 0}`);
	if (traces && traces.failures.length > 0) console.log(`Trace failures: ${traces.failures.length}`);
	console.log(`Workspace:  ${join(meta.paths.runDir, meta.paths.workspaceDir)}`);
	console.log(`Diff:       ${join(meta.paths.runDir, meta.paths.diffPath)}`);
}
