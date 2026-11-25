import { execFile } from "node:child_process";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { HarnessError } from "./errors.ts";

const run = promisify(execFile);

export interface MaterializedWorkspace {
	git: boolean;
	baseCommit?: string;
	warning?: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await run("git", args, {
		cwd,
		maxBuffer: 16 * 1024 * 1024,
		windowsHide: true,
	});
	return stdout.trim();
}

async function hasGitRepo(cwd: string): Promise<boolean> {
	try {
		// --is-inside-work-tree is also true for directories nested in someone else's repo.
		// An empty prefix means cwd is the root of its own repo, which is the only repo
		// the harness may use as a baseline.
		return (await git(cwd, ["rev-parse", "--show-prefix"])) === "";
	} catch {
		return false;
	}
}

async function baseline(cwd: string): Promise<string> {
	if (!(await hasGitRepo(cwd))) {
		await git(cwd, ["init", "-q"]);
		try {
			await git(cwd, ["checkout", "-q", "-b", "main"]);
		} catch {
			// Older git may not support -b on an empty repo; the default branch is fine.
		}
	} else {
		await git(cwd, ["checkout", "-q", "-B", "eval-baseline"]);
	}

	await git(cwd, ["add", "-A"]);
	// This is a synthetic checkpoint, not a repo commit: user/repo hooks must not block it.
	await git(cwd, [
		"-c",
		"user.name=eval-harness",
		"-c",
		"user.email=eval-harness@localhost",
		"commit",
		"-q",
		"-m",
		"eval baseline",
		"--allow-empty",
		"--no-verify",
	]);
	return git(cwd, ["rev-parse", "HEAD"]);
}

export async function materializeWorkspace(
	repoDir: string,
	inputDir: string,
	workspaceDir: string,
	options: { git: boolean },
): Promise<MaterializedWorkspace> {
	await mkdir(inputDir, { recursive: true });
	await mkdir(workspaceDir, { recursive: true });

	await cp(repoDir, inputDir, { recursive: true, force: true });
	await cp(inputDir, workspaceDir, { recursive: true, force: true });

	if (!options.git) return { git: false };

	try {
		const baseCommit = await baseline(workspaceDir);
		return { git: true, baseCommit };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { git: false, warning: `git baseline skipped: ${message}` };
	}
}

export async function captureDiff(
	workspaceDir: string,
	baseCommit: string | undefined,
	diffPath: string,
): Promise<boolean> {
	if (!baseCommit) return false;
	try {
		await git(workspaceDir, ["add", "-A"]);
		const diff = await git(workspaceDir, ["diff", "--binary", "--cached", baseCommit]);
		await writeFile(diffPath, diff.length > 0 ? `${diff}\n` : "", "utf8");
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new HarnessError("diff_failed", `Could not capture workspace diff: ${message}`);
	}
}

export async function changedFiles(workspaceDir: string, baseCommit: string | undefined): Promise<string[]> {
	if (!baseCommit) return [];
	try {
		const status = await git(workspaceDir, ["status", "--porcelain"]);
		return status
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => line.replace(/^..\s+/, ""));
	} catch {
		return [];
	}
}

export function workspacePath(runDir: string): string {
	return join(runDir, "workspace");
}
