import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureDiff, materializeWorkspace } from "../src/workspace.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "evalh-ws-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("workspace materialization", () => {
	it("copies the repo into input and workspace", async () => {
		const repo = join(dir, "repo");
		await mkdir(join(repo, "src"), { recursive: true });
		await writeFile(join(repo, "src", "hello.txt"), "hello\n", "utf8");

		const result = await materializeWorkspace(repo, join(dir, "input"), join(dir, "workspace"), { git: false });

		expect(result.git).toBe(false);
		expect(await readFile(join(dir, "input", "src", "hello.txt"), "utf8")).toBe("hello\n");
		expect(await readFile(join(dir, "workspace", "src", "hello.txt"), "utf8")).toBe("hello\n");
	});

	it("captures a diff against the baseline when git is available", async () => {
		const repo = join(dir, "repo");
		await mkdir(repo, { recursive: true });
		await writeFile(join(repo, "hello.txt"), "hello\n", "utf8");

		const result = await materializeWorkspace(repo, join(dir, "input"), join(dir, "workspace"), { git: true });
		if (!result.git) return;

		await writeFile(join(dir, "workspace", "hello.txt"), "world\n", "utf8");
		await captureDiff(join(dir, "workspace"), result.baseCommit, join(dir, "diff.patch"));

		const diff = await readFile(join(dir, "diff.patch"), "utf8");
		expect(diff).toContain("-hello");
		expect(diff).toContain("+world");
	});

	it("uses a fresh baseline repo instead of a parent repo when nested inside one", async () => {
		const outer = join(dir, "outer");
		await mkdir(outer, { recursive: true });
		const gitOuter = (args: string[]): string =>
			execFileSync("git", args, { cwd: outer, encoding: "utf8", windowsHide: true }).trim();
		gitOuter(["init", "-q"]);
		gitOuter(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "outer"]);
		const outerHead = gitOuter(["rev-parse", "HEAD"]);

		const repo = join(outer, "task-repo");
		await mkdir(repo, { recursive: true });
		await writeFile(join(repo, "hello.txt"), "hello\n", "utf8");

		const result = await materializeWorkspace(repo, join(outer, "input"), join(outer, "workspace"), { git: true });
		expect(result.git).toBe(true);
		expect(result.baseCommit).toBeDefined();
		expect(gitOuter(["rev-parse", "HEAD"])).toBe(outerHead);
	});
});
