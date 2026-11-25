import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseModelRef } from "../src/config.ts";
import { listRuns, RunStore, readRunMeta } from "../src/run-store.ts";
import { loadTask, scaffoldFamily } from "../src/task.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "evalh-run-"));
	await scaffoldFamily(join(dir, "family"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("RunStore", () => {
	it("creates a run directory with the expected layout", async () => {
		const task = await loadTask(join(dir, "family", "example-task"));
		const store = await RunStore.create(task, {
			runsDir: join(dir, "runs"),
			model: parseModelRef(task.config.model),
			runId: "test-run",
		});

		expect(store.meta.id).toBe("test-run");
		expect(store.meta.paths.workspaceDir).toBe("workspace");
		expect(store.meta.paths.eventsPath).toBe("events.jsonl");
	});

	it("appends and reads canonical events in order", async () => {
		const task = await loadTask(join(dir, "family", "example-task"));
		const store = await RunStore.create(task, {
			runsDir: join(dir, "runs"),
			model: parseModelRef(task.config.model),
			runId: "events-run",
		});

		await store.append({
			type: "run_start",
			task: task.id,
			family: task.family,
			harness: task.config.harness,
			model: task.config.model,
			env: task.config.env,
		});
		await store.append({ type: "run_end", status: "completed", turns: 2, durationMs: 10 });

		const events = await store.readEvents();
		expect(events.map((event) => event.seq)).toEqual([0, 1]);
		expect(events[0].type).toBe("run_start");
		expect(events[1].type).toBe("run_end");
	});

	it("lists runs newest first", async () => {
		const task = await loadTask(join(dir, "family", "example-task"));
		const model = parseModelRef(task.config.model);
		await RunStore.create(task, { runsDir: join(dir, "runs"), model, runId: "run-a" });
		await RunStore.create(task, { runsDir: join(dir, "runs"), model, runId: "run-b" });

		const runs = await listRuns(join(dir, "runs"));
		expect(runs).toHaveLength(2);
		expect(await readRunMeta(join(dir, "runs", "run-a"))).toMatchObject({ id: "run-a" });
	});
});
