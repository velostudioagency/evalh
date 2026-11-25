import { access, cp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type {
	ExecResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const MAIN_OPTIONS = ["Create eval run", "List tasks", "Show a run", "Cancel"];
const TRACE_FORMATS = ["qwen3", "qwen3,jsonl", "jsonl"];
const DEFAULT_MODEL = "lmstudio/qwen3.8-4b-distill";
const MAX_ERROR_LENGTH = 200;

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function subdirectories(root: string): Promise<string[]> {
	try {
		const entries = await readdir(root, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(root, entry.name))
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}

async function subdirectoriesContaining(root: string, fileName: string): Promise<string[]> {
	const dirs = await subdirectories(root);
	const found: string[] = [];
	for (const dir of dirs) {
		try {
			await access(join(dir, fileName));
			found.push(dir);
		} catch {
			// Not one of the directories we are looking for.
		}
	}
	return found;
}

function nameOf(path: string): string {
	return basename(path);
}

function notifyExec(ctx: ExtensionContext, result: ExecResult): void {
	const text = (result.stdout || result.stderr).trim();
	ctx.ui.notify(text || "evalh finished without output.", result.code === 0 ? "info" : "error");
}

async function listTasks(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const result = await pi.exec("evalh", ["list", ctx.cwd + "/tasks"]);
	notifyExec(ctx, result);
}

async function showRun(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const runs = await subdirectories(ctx.cwd + "/runs");
	if (runs.length === 0) {
		ctx.ui.notify("No runs found.", "warning");
		return;
	}

	const selected = await ctx.ui.select("Select a run:", runs.map(nameOf));
	if (selected === undefined) return;

	const result = await pi.exec("evalh", ["show", join(ctx.cwd, "runs", selected)]);
	notifyExec(ctx, result);
}

function taskNameFromRepo(repoPath: string): string {
	const cleaned = basename(repoPath)
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned || "task";
}

async function createTask(ctx: ExtensionContext, familyDir: string): Promise<string | undefined> {
	const repoInput = await ctx.ui.input("Repository path", "path/to/repo");
	if (repoInput === undefined) return undefined;
	const repoPath = repoInput.trim();
	if (!repoPath) return undefined;

	const promptInput = await ctx.ui.input("Prompt text", "What should the agent do?");
	if (promptInput === undefined) return undefined;
	const prompt = promptInput.trim();
	if (!prompt) return undefined;

	const sourceRepo = resolve(ctx.cwd, repoPath);
	const baseName = taskNameFromRepo(sourceRepo);
	let taskDir = join(familyDir, baseName);
	for (let suffix = 2; (await isDirectory(taskDir)) && suffix < 100; suffix += 1) {
		taskDir = join(familyDir, `${baseName}-${suffix}`);
	}

	const repoDir = join(taskDir, "repo");
	await mkdir(repoDir, { recursive: true });
	if (await isDirectory(sourceRepo)) {
		const rel = relative(sourceRepo, repoDir);
		const nested = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
		if (!nested) await cp(sourceRepo, repoDir, { recursive: true, force: true });
	}

	await writeFile(join(taskDir, "task.yaml"), `id: ${baseName}\nprompt: prompt.md\nrepo: repo\n`, "utf8");
	await writeFile(join(taskDir, "prompt.md"), `${prompt}\n`, "utf8");
	return taskDir;
}

async function pickTaskDir(ctx: ExtensionContext, familyDir: string, createdFamily: boolean): Promise<string | undefined> {
	const tasks = await subdirectoriesContaining(familyDir, "task.yaml");

	if (tasks.length === 0 || createdFamily) {
		const options = createdFamily ? ["Create new task", ...tasks.map(nameOf), "Cancel"] : ["Create new task", "Cancel"];
		const selected = await ctx.ui.select("Select a task:", options);
		if (selected === undefined || selected === "Cancel") return undefined;
		if (selected === "Create new task") return createTask(ctx, familyDir);
		return join(familyDir, selected);
	}

	const selected = await ctx.ui.select("Select a task:", tasks.map(nameOf));
	if (selected === undefined) return undefined;
	return join(familyDir, selected);
}

async function runEval(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	taskDir: string,
	model: string,
	formats: string,
): Promise<ExecResult> {
	ctx.ui.setWorkingMessage("Running eval...");
	ctx.ui.setWorkingVisible(true);
	try {
		return await pi.exec("evalh", ["run", taskDir, "--model", model, "--format", formats]);
	} finally {
		ctx.ui.setWorkingVisible(false);
		ctx.ui.setWorkingMessage();
	}
}

async function createRun(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const tasksDir = ctx.cwd + "/tasks";
	const families = await subdirectoriesContaining(tasksDir, "family.yaml");
	let familyDir: string;
	let createdFamily = false;

	if (families.length === 0) {
		const choice = await ctx.ui.select("No task families found. Create one?", ["Create new task family", "Cancel"]);
		if (choice !== "Create new task family") return;

		const nameInput = await ctx.ui.input("Task family name", "my-family");
		if (nameInput === undefined) return;
		const name = nameInput.trim();
		if (!name) return;

		const result = await pi.exec("evalh", ["init", "tasks/" + name]);
		if (result.code !== 0) {
			notifyExec(ctx, result);
			return;
		}
		familyDir = join(tasksDir, name);
		createdFamily = true;
	} else {
		const selected = await ctx.ui.select("Select a task family:", families.map(nameOf));
		if (selected === undefined) return;
		familyDir = join(tasksDir, selected);
	}

	const taskDir = await pickTaskDir(ctx, familyDir, createdFamily);
	if (taskDir === undefined) return;

	const defaultModel = ctx.model ? ctx.model.provider + "/" + ctx.model.id : DEFAULT_MODEL;
	const modelInput = await ctx.ui.input("Model (provider/id)", defaultModel);
	if (modelInput === undefined) return;
	const model = modelInput.trim() || defaultModel;

	const formats = await ctx.ui.select("Trace formats", TRACE_FORMATS);
	if (formats === undefined) return;

	const result = await runEval(pi, ctx, taskDir, model, formats);
	if (result.code === 0) {
		ctx.ui.notify("Eval completed. See traces/ in the run dir.", "info");
	} else {
		const detail = (result.stderr || result.stdout).slice(0, MAX_ERROR_LENGTH);
		ctx.ui.notify("Eval failed: " + detail, "error");
	}
}

export default function evalhExtension(pi: ExtensionAPI): void {
	pi.registerCommand("evalh", {
		description: "Create and inspect evalh evaluation runs",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("evalh requires an interactive TUI session.", "error");
				return;
			}

			const action = await ctx.ui.select("evalh — what would you like to do?", MAIN_OPTIONS);
			if (action === undefined || action === "Cancel") return;

			if (action === "List tasks") {
				await listTasks(pi, ctx);
			} else if (action === "Show a run") {
				await showRun(pi, ctx);
			} else {
				await createRun(pi, ctx);
			}
		},
	});
}
