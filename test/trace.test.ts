import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { TraceInput } from "../src/trace/index.ts";
import { exportTraces, TRACE_RENDERERS, traceFileName } from "../src/trace/index.ts";
import type { CanonicalEvent, TraceFormat } from "../src/types.ts";

const events: CanonicalEvent[] = [
	{
		seq: 0,
		ts: "2026-01-01T00:00:00.000Z",
		type: "run_start",
		task: "demo",
		family: "demo",
		harness: "pi",
		model: "anthropic/claude-sonnet-4-5",
		env: DEFAULT_CONFIG.env,
	},
	{ seq: 1, ts: "2026-01-01T00:00:01.000Z", type: "run_end", status: "completed", turns: 1, durationMs: 10 },
];

function input(formats: TraceFormat[]): TraceInput {
	return {
		events,
		systemPrompt: "system",
		prompt: "prompt",
		tools: [],
		config: { ...DEFAULT_CONFIG, trace: { ...DEFAULT_CONFIG.trace, formats } },
	};
}

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "evalh-trace-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("jsonl renderer", () => {
	it("writes exactly one JSON object per canonical event", () => {
		const output = TRACE_RENDERERS.jsonl.render(input(["jsonl"]));
		const lines = output.trimEnd().split("\n");

		expect(lines).toHaveLength(events.length);
		expect(lines.map((line) => JSON.parse(line))).toEqual(events);
	});

	it("writes an empty stream for no events", () => {
		const empty: TraceInput = { ...input(["jsonl"]), events: [] };
		expect(TRACE_RENDERERS.jsonl.render(empty)).toBe("");
	});
});

describe("qwen3 renderer", () => {
	it("maps to qwen3.txt", () => {
		expect(traceFileName("qwen3")).toBe("qwen3.txt");
	});

	it("writes a system turn and the prompt for a minimal input", () => {
		expect(TRACE_RENDERERS.qwen3.render(input(["qwen3"]))).toBe(
			"<|im_start|>system\nsystem<|im_end|>\n<|im_start|>user\nprompt<|im_end|>\n",
		);
	});
});

describe("exportTraces", () => {
	it("creates traces/ and returns only written paths", async () => {
		const tracesDir = join(dir, "nested", "traces");
		const failures: Array<{ format: TraceFormat; code: string }> = [];

		const paths = await exportTraces(input(["qwen3", "jsonl"]), tracesDir, (failure) => {
			failures.push({ format: failure.format, code: failure.code });
		});

		expect((await stat(tracesDir)).isDirectory()).toBe(true);
		expect(paths).toEqual([join(tracesDir, "qwen3.txt"), join(tracesDir, "events.jsonl")]);
		expect(failures).toEqual([]);

		const text = await readFile(paths[1], "utf8");
		expect(text.trimEnd().split("\n")).toHaveLength(events.length);
	});
});
