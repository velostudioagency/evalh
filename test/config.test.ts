import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, mergeTaskConfig, parseModelRef, validateTaskConfig } from "../src/config.ts";
import { HarnessError } from "../src/errors.ts";

describe("parseModelRef", () => {
	it("splits provider and model", () => {
		expect(parseModelRef("anthropic/claude-sonnet-4-5")).toEqual({
			provider: "anthropic",
			id: "claude-sonnet-4-5",
			spec: "anthropic/claude-sonnet-4-5",
		});
	});

	it("keeps slashes inside the model id", () => {
		expect(parseModelRef("openrouter/vendor/model").id).toBe("vendor/model");
	});

	it("rejects a missing provider", () => {
		expect(() => parseModelRef("claude-sonnet")).toThrow(HarnessError);
	});
});

describe("mergeTaskConfig", () => {
	it("merges nested sections without dropping defaults", () => {
		const merged = mergeTaskConfig(DEFAULT_CONFIG, {
			limits: { maxTurns: 5 },
			trace: { formats: ["qwen3"] },
			env: { user: "ada" },
		});

		expect(merged.limits.maxTurns).toBe(5);
		expect(merged.limits.timeoutSec).toBe(DEFAULT_CONFIG.limits.timeoutSec);
		expect(merged.trace.formats).toEqual(["qwen3"]);
		expect(merged.trace.includeThinking).toBe(DEFAULT_CONFIG.trace.includeThinking);
		expect(merged.env.user).toBe("ada");
	});

	it("rejects unknown trace formats", () => {
		expect(() => mergeTaskConfig(DEFAULT_CONFIG, { trace: { formats: ["nope" as never] } })).toThrow(HarnessError);
	});

	it("requires a prompt file for custom mode", () => {
		const config = structuredClone(DEFAULT_CONFIG);
		config.systemPrompt.mode = "custom";
		expect(() => validateTaskConfig(config)).toThrow(HarnessError);
	});

	it("accepts the pi tool family", () => {
		expect(mergeTaskConfig(DEFAULT_CONFIG, { toolFamily: "pi" }).toolFamily).toBe("pi");
	});

	it("rejects an unknown tool family with tool_family_unknown", () => {
		expectCode(() => mergeTaskConfig(DEFAULT_CONFIG, { toolFamily: "nope" }), "tool_family_unknown");
	});

	it("defaults toolFamily to omp when the omp harness is used without an explicit family", () => {
		const merged = mergeTaskConfig(DEFAULT_CONFIG, { harness: "omp" });
		expect(merged.harness).toBe("omp");
		expect(merged.toolFamily).toBe("omp");
	});

	it("respects an explicit toolFamily with the omp harness", () => {
		expect(mergeTaskConfig(DEFAULT_CONFIG, { harness: "omp", toolFamily: "pi" }).toolFamily).toBe("pi");
		expect(
			mergeTaskConfig(DEFAULT_CONFIG, { harness: "omp", toolFamily: "custom", tools: ["read"] }).toolFamily,
		).toBe("custom");
	});
});

describe("validateTaskConfig", () => {
	it("accepts the pi and omp harnesses", () => {
		for (const harness of ["pi", "omp"] as const) {
			const config = structuredClone(DEFAULT_CONFIG);
			config.harness = harness;
			expect(() => validateTaskConfig(config)).not.toThrow();
		}
	});

	it("rejects the unimplemented custom harness before a run starts", () => {
		const config = structuredClone(DEFAULT_CONFIG);
		config.harness = "custom";
		expectCode(() => validateTaskConfig(config), "harness_unsupported");
	});

	it("requires tools when toolFamily is custom", () => {
		const config = structuredClone(DEFAULT_CONFIG);
		config.toolFamily = "custom";
		expect(config.tools).toBeUndefined();
		expectCode(() => validateTaskConfig(config), "tools_missing");
	});

	it("accepts custom toolFamily with an explicit tool list", () => {
		const config = mergeTaskConfig(DEFAULT_CONFIG, { toolFamily: "custom", tools: ["read", "bash"] });
		expect(() => validateTaskConfig(config)).not.toThrow();
	});
});

function expectCode(run: () => void, code: string): void {
	try {
		run();
		throw new Error(`expected ${code}`);
	} catch (error) {
		expect(error).toBeInstanceOf(HarnessError);
		expect((error as HarnessError).code).toBe(code);
	}
}
