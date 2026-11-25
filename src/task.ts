import type { Dirent } from "node:fs";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DEFAULT_CONFIG, mergeTaskConfig, readYamlFile } from "./config.ts";
import { HarnessError } from "./errors.ts";
import type { RawFamilyFile, RawTaskFile, ResolvedTask } from "./types.ts";

const FAMILY_FILES = ["family.yaml", "family.yml"];
const TASK_FILES = ["task.yaml", "task.yml"];
const SKIP_DIRS = new Set(["repo", ".git", "node_modules", "dist", "runs", "traces", "input", "workspace"]);

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function firstExisting(dir: string, names: string[]): Promise<string | undefined> {
	for (const name of names) {
		const candidate = join(dir, name);
		if (await exists(candidate)) return candidate;
	}
	return undefined;
}

function requireString(value: unknown, field: string, file: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new HarnessError("task_invalid", `${file}: ${field} must be a non-empty string`);
	}
	return value.trim();
}

export async function findFamilyRoot(taskDir: string): Promise<string> {
	let current = resolve(taskDir);
	while (true) {
		if (await firstExisting(current, FAMILY_FILES)) return current;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	throw new HarnessError(
		"family_missing",
		`No family.yaml found above ${taskDir}`,
		"Create one with `evalh init <dir>` or add a family.yaml at the tasks root.",
	);
}

export async function loadTask(taskDir: string): Promise<ResolvedTask> {
	const dir = resolve(taskDir);
	if (!(await isDirectory(dir))) {
		throw new HarnessError("task_missing", `Task directory does not exist: ${dir}`);
	}

	const taskFile = await firstExisting(dir, TASK_FILES);
	if (!taskFile) {
		throw new HarnessError(
			"task_missing",
			`No task.yaml found in ${dir}`,
			"A task folder must contain task.yaml, prompt.md, and repo/.",
		);
	}

	const familyDir = await findFamilyRoot(dir);
	const familyFile = await firstExisting(familyDir, FAMILY_FILES);
	if (!familyFile) {
		throw new HarnessError("family_missing", `No family.yaml found in ${familyDir}`);
	}

	const rawTask = (await readYamlFile(taskFile)) as RawTaskFile;
	const rawFamily = (await readYamlFile(familyFile)) as RawFamilyFile;
	const familyDefaults = rawFamily.defaults ?? rawFamily;

	const config = mergeTaskConfig(DEFAULT_CONFIG, familyDefaults, rawTask);

	const promptPath = resolve(dir, rawTask.prompt ?? "prompt.md");
	if (!(await exists(promptPath))) {
		throw new HarnessError("task_invalid", `${taskFile}: prompt file not found at ${promptPath}`);
	}

	const repoDir = resolve(dir, rawTask.repo ?? "repo");
	if (!(await isDirectory(repoDir))) {
		throw new HarnessError("task_invalid", `${taskFile}: repo directory not found at ${repoDir}`);
	}

	const id = rawTask.id?.trim() || basename(dir);
	const family = rawFamily.name?.trim() || basename(familyDir);

	return { id, family, dir, promptPath, repoDir, config };
}

async function walkTasks(dir: string, found: string[]): Promise<void> {
	const taskFile = await firstExisting(dir, TASK_FILES);
	if (taskFile) {
		found.push(dir);
		return;
	}

	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (SKIP_DIRS.has(entry.name)) continue;
		await walkTasks(join(dir, entry.name), found);
	}
}

export async function discoverTasks(root: string): Promise<ResolvedTask[]> {
	const base = resolve(root);
	if (!(await isDirectory(base))) {
		throw new HarnessError("tasks_missing", `Tasks directory does not exist: ${base}`);
	}

	const dirs: string[] = [];
	await walkTasks(base, dirs);
	const tasks = await Promise.all(dirs.map((dir) => loadTask(dir)));
	return tasks.sort((a, b) => `${a.family}/${a.id}`.localeCompare(`${b.family}/${b.id}`));
}

export async function readPrompt(task: ResolvedTask): Promise<string> {
	return readFile(task.promptPath, "utf8");
}

const EXAMPLE_FAMILY_YAML = `name: my-family
description: Describe what this family of tasks is for.

defaults:
  harness: pi
  model: anthropic/claude-sonnet-4-5
  thinkingLevel: off
  toolFamily: pi
  env:
    os: linux
    shell: bash
    user: dev
    hostname: devbox
    home: /home/dev
    timezone: UTC
    git: true
  limits:
    maxTurns: 40
    timeoutSec: 900
  trace:
    formats: [qwen3, jsonl]
    includeThinking: true
    includeToolSchemas: true
`;

const EXAMPLE_TASK_YAML = `id: example-task
prompt: prompt.md
repo: repo
`;

const EXAMPLE_PROMPT = `Fix the failing test in this repository.

Run \`npm test\` to see the failure, find the bug, and make the test pass without
changing the test file.
`;

const EXAMPLE_REPO_README = `# example-task

A tiny Node project with one failing test.
`;

const EXAMPLE_PACKAGE_JSON = `{
	"name": "example-task",
	"private": true,
	"type": "module",
	"scripts": {
		"test": "node --test"
	}
}
`;

const EXAMPLE_SOURCE = `export function greet(name) {
	return \`Hello, \${nmae}!\`;
}
`;

const EXAMPLE_TEST = `import assert from "node:assert/strict";
import { test } from "node:test";
import { greet } from "../src/greet.js";

test("greets by name", () => {
	assert.equal(greet("Ada"), "Hello, Ada!");
});
`;

export async function scaffoldFamily(targetDir: string, options: { force?: boolean } = {}): Promise<string> {
	const dir = resolve(targetDir);
	if ((await exists(dir)) && !options.force) {
		const entries = await readdir(dir);
		if (entries.length > 0) {
			throw new HarnessError(
				"init_conflict",
				`Directory is not empty: ${dir}`,
				"Pick a new directory or pass --force to write into it anyway.",
			);
		}
	}

	const files: Array<[string, string]> = [
		["family.yaml", EXAMPLE_FAMILY_YAML],
		["README.md", "# my-family\n\nTasks in this family.\n"],
		["example-task/task.yaml", EXAMPLE_TASK_YAML],
		["example-task/prompt.md", EXAMPLE_PROMPT],
		["example-task/repo/README.md", EXAMPLE_REPO_README],
		["example-task/repo/package.json", EXAMPLE_PACKAGE_JSON],
		["example-task/repo/src/greet.js", EXAMPLE_SOURCE],
		["example-task/repo/test/greet.test.js", EXAMPLE_TEST],
	];

	for (const [relative, content] of files) {
		const path = join(dir, relative);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content, "utf8");
	}

	return dir;
}
