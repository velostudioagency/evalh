import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { buildPromptBundle } from "../src/harness/prompt.ts";
import type { ResolvedTask } from "../src/types.ts";

const workspaceDir = "C:/workspace";

function task(realism: boolean): ResolvedTask {
	return {
		id: "fix-greeting",
		family: "demo",
		dir: workspaceDir,
		promptPath: "prompt.md",
		repoDir: "repo",
		config: {
			...DEFAULT_CONFIG,
			systemPrompt: { ...DEFAULT_CONFIG.systemPrompt, mode: "pi", realism },
		},
	};
}

describe("buildPromptBundle realism", () => {
	it("leaves pi's default prompt alone when realism is false", async () => {
		const bundle = await buildPromptBundle(task(false), workspaceDir);
		expect(bundle.systemPrompt).toBeUndefined();
	});

	it("builds a neutral prompt without pi identity, docs, or PI hint when realism is true", async () => {
		const bundle = await buildPromptBundle(task(true), workspaceDir);
		const prompt = bundle.systemPrompt ?? "";

		expect(prompt).toContain("You are a coding assistant operating on this machine.");
		expect(prompt).toContain("<tools>");
		expect(prompt).toContain("<rules>");
		expect(prompt).not.toContain("running inside pi");
		expect(prompt).not.toContain("<docs>");
		expect(prompt).not.toContain("PI_*");
		expect(prompt).not.toContain("You can inspect");
	});

	it("keeps a custom prompt when realism is true", async () => {
		const custom = task(true);
		custom.config.systemPrompt = { ...custom.config.systemPrompt, mode: "template", template: "Custom." };
		const bundle = await buildPromptBundle(custom, workspaceDir);
		expect(bundle.systemPrompt).toBe("Custom.");
	});
});
