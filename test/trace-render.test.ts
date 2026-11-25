import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TraceInput, TraceTool } from "../src/trace/index.ts";
import { renderQwen3 } from "../src/trace/qwen3.ts";
import type { CanonicalEvent, TaskConfig } from "../src/types.ts";

interface FixtureToolCall {
	id: string;
	name: string;
	arguments: unknown;
}

interface FixtureMessage {
	role: "user" | "assistant" | "tool";
	content: string;
	reasoning_content?: string | null;
	toolCalls?: FixtureToolCall[];
	toolCallId?: string;
}

interface ConversationFixture {
	systemPrompt: string;
	prompt: string;
	tools: TraceTool[];
	config: TaskConfig;
	messages: FixtureMessage[];
}

const fixturesDir = join(import.meta.dirname, "fixtures", "conversations");
const goldensDir = join(import.meta.dirname, "fixtures", "golden");
const timestamp = "2026-01-01T00:00:00.000Z";

async function loadFixture(name: string): Promise<ConversationFixture> {
	const text = await readFile(join(fixturesDir, `${name}.json`), "utf8");
	return JSON.parse(text) as ConversationFixture;
}

/** Pi-session messages become canonical events; the fixture prompt is the first user turn. */
function toTraceInput(fixture: ConversationFixture): TraceInput {
	const events: CanonicalEvent[] = [];
	for (const [index, message] of fixture.messages.entries()) {
		if (message.role === "assistant") {
			const content: unknown[] = [];
			if (message.reasoning_content) content.push({ type: "thinking", thinking: message.reasoning_content });
			if (message.content.length > 0) content.push({ type: "text", text: message.content });
			for (const call of message.toolCalls ?? []) {
				content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments });
			}
			events.push({ seq: index, ts: timestamp, type: "message", role: "assistant", content });
		} else if (message.role === "tool") {
			events.push({
				seq: index,
				ts: timestamp,
				type: "tool_result",
				id: message.toolCallId ?? "",
				name: "",
				content: message.content,
				isError: false,
			});
		}
	}
	return {
		events,
		systemPrompt: fixture.systemPrompt,
		prompt: fixture.prompt,
		tools: fixture.tools,
		config: fixture.config,
	};
}

describe("qwen3 golden traces", () => {
	it("matches the vendored Jinja template byte for byte", async () => {
		const entries = await readdir(fixturesDir);
		const names = entries
			.filter((name) => name.endsWith(".json"))
			.map((name) => basename(name, ".json"))
			.sort();
		expect(names.length).toBeGreaterThan(0);

		for (const name of names) {
			const expected = await readFile(join(goldensDir, `${name}.txt`), "utf8");
			expect(renderQwen3(toTraceInput(await loadFixture(name))), name).toBe(expected);
		}
	});

	it("renders a non-empty trace for the plain fixture", async () => {
		expect(renderQwen3(toTraceInput(await loadFixture("plain"))).length).toBeGreaterThan(0);
	});
});
