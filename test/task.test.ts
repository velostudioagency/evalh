import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverTasks, loadTask, scaffoldFamily } from "../src/task.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "evalh-task-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("task loading", () => {
	it("loads a scaffolded task with family defaults", async () => {
		await scaffoldFamily(join(dir, "family"));
		const task = await loadTask(join(dir, "family", "example-task"));

		expect(task.id).toBe("example-task");
		expect(task.family).toBe("my-family");
		expect(task.config.toolFamily).toBe("pi");
		expect(task.config.model).toBe("anthropic/claude-sonnet-4-5");
	});

	it("discovers tasks recursively", async () => {
		await scaffoldFamily(join(dir, "family"));
		const tasks = await discoverTasks(join(dir, "family"));

		expect(tasks).toHaveLength(1);
		expect(tasks[0].id).toBe("example-task");
	});

	it("fails clearly when family.yaml is missing", async () => {
		const taskDir = join(dir, "orphan");
		await mkdir(join(taskDir, "repo"), { recursive: true });
		await writeFile(join(taskDir, "task.yaml"), "id: orphan\n", "utf8");
		await writeFile(join(taskDir, "prompt.md"), "Do the thing.\n", "utf8");

		await expect(loadTask(taskDir)).rejects.toMatchObject({ code: "family_missing" });
	});
});
