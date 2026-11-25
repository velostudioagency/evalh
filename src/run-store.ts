import type { Dirent } from "node:fs";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { HarnessError } from "./errors.ts";
import type { CanonicalEvent, ModelRef, ResolvedTask, RunMeta, RunPaths, RunResult, RunStatus } from "./types.ts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type EventInput = DistributiveOmit<CanonicalEvent, "seq" | "ts">;
type ArtifactEventInput = Extract<EventInput, { path: string }>;

const RUN_SUBDIRS = ["input", "workspace", "requests", "responses", "traces", "logs"] as const;

function sanitize(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
}

export function newRunId(taskId: string, now: Date = new Date()): string {
	const stamp = now.toISOString().replace(/[:.]/g, "-").replace("Z", "Z");
	const suffix = Math.random().toString(36).slice(2, 6);
	return `${stamp}-${sanitize(taskId) || "task"}-${suffix}`;
}

function relativePaths(): Omit<RunPaths, "runDir"> {
	return {
		metaPath: "run.json",
		inputDir: "input",
		workspaceDir: "workspace",
		eventsPath: "events.jsonl",
		sessionPath: "session.jsonl",
		requestsDir: "requests",
		responsesDir: "responses",
		tracesDir: "traces",
		logsDir: "logs",
		diffPath: "diff.patch",
	};
}

export function resolveRunPath(runDir: string, relative: string): string {
	return resolve(runDir, relative);
}

export interface CreateRunOptions {
	runsDir: string;
	model: ModelRef;
	runId?: string;
}

export class RunStore {
	readonly dir: string;
	readonly eventsPath: string;
	meta: RunMeta;
	private seq = 0;

	private constructor(dir: string, meta: RunMeta) {
		this.dir = dir;
		this.meta = meta;
		this.eventsPath = join(dir, meta.paths.eventsPath);
	}

	static async open(dir: string): Promise<RunStore> {
		const meta = await readRunMeta(dir);
		return new RunStore(resolve(dir), meta);
	}

	static async create(task: ResolvedTask, options: CreateRunOptions): Promise<RunStore> {
		const runsDir = resolve(options.runsDir);
		const id = options.runId ?? newRunId(task.id);
		const dir = join(runsDir, id);
		const now = new Date().toISOString();
		const relative = relativePaths();

		const meta: RunMeta = {
			version: 1,
			id,
			createdAt: now,
			updatedAt: now,
			status: "created",
			task: {
				id: task.id,
				family: task.family,
				dir: task.dir,
				promptPath: task.promptPath,
				repoDir: task.repoDir,
			},
			model: options.model,
			config: task.config,
			paths: { runDir: dir, ...relative },
			workspace: { git: task.config.env.git },
		};

		await mkdir(runsDir, { recursive: true });
		await mkdir(dir, { recursive: false });
		for (const sub of RUN_SUBDIRS) {
			await mkdir(join(dir, sub), { recursive: true });
		}
		await writeFile(join(dir, relative.metaPath), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
		await writeFile(join(dir, relative.eventsPath), "", "utf8");

		return new RunStore(dir, meta);
	}

	async append(event: EventInput): Promise<CanonicalEvent> {
		const entry = { seq: this.seq++, ts: new Date().toISOString(), ...event } as CanonicalEvent;
		await appendFile(this.eventsPath, `${JSON.stringify(entry)}\n`, "utf8");
		return entry;
	}

	async setStatus(status: RunStatus): Promise<void> {
		this.meta.status = status;
		this.meta.updatedAt = new Date().toISOString();
		await this.save();
	}

	async setWorkspace(workspace: RunMeta["workspace"]): Promise<void> {
		this.meta.workspace = workspace;
		this.meta.updatedAt = new Date().toISOString();
		await this.save();
	}

	async appendArtifact(event: ArtifactEventInput, relative: string, content: string): Promise<CanonicalEvent> {
		const path = resolveRunPath(this.dir, relative);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content, "utf8");
		const entry = { seq: this.seq++, ts: new Date().toISOString(), ...event, path: relative } as CanonicalEvent;
		await appendFile(this.eventsPath, `${JSON.stringify(entry)}\n`, "utf8");
		return entry;
	}

	async save(): Promise<void> {
		await writeFile(join(this.dir, this.meta.paths.metaPath), `${JSON.stringify(this.meta, null, 2)}\n`, "utf8");
	}

	async finish(result: RunResult): Promise<void> {
		this.meta.status = result.status;
		this.meta.result = result;
		this.meta.updatedAt = new Date().toISOString();
		await this.save();
	}

	async writeArtifact(relative: string, content: string): Promise<string> {
		const path = resolveRunPath(this.dir, relative);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content, "utf8");
		return path;
	}

	async readEvents(): Promise<CanonicalEvent[]> {
		const text = await readFile(this.eventsPath, "utf8");
		return text
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line, index) => {
				try {
					return JSON.parse(line) as CanonicalEvent;
				} catch {
					throw new HarnessError("events_corrupt", `Invalid JSON on line ${index + 1} of ${this.eventsPath}`);
				}
			});
	}
}

export async function readRunMeta(runDir: string): Promise<RunMeta> {
	const dir = resolve(runDir);
	const path = join(dir, "run.json");
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		throw new HarnessError("run_missing", `Not a run directory (no run.json): ${dir}`);
	}
	try {
		return JSON.parse(text) as RunMeta;
	} catch {
		throw new HarnessError("run_corrupt", `Could not parse ${path}`);
	}
}

export async function listRuns(runsDir: string): Promise<RunMeta[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(resolve(runsDir), { withFileTypes: true });
	} catch {
		return [];
	}

	const runs: RunMeta[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		try {
			runs.push(await readRunMeta(join(resolve(runsDir), entry.name)));
		} catch {
			// Ignore directories that are not runs.
		}
	}
	return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
