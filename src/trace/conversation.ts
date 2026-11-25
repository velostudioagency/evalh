import type { CanonicalEvent, TaskConfig } from "../types.ts";
import { scrubText } from "./scrub.ts";

export interface TraceTool {
	name: string;
	description: string;
	parameters: unknown;
}

export interface TraceInput {
	events: CanonicalEvent[];
	systemPrompt: string;
	prompt: string;
	tools: TraceTool[];
	config: TaskConfig;
	/** Scrub identity/benchmark wording from rendered text. Defaults to true. */
	realism?: boolean;
}

export interface ConversationToolCall {
	id: string;
	name: string;
	arguments: unknown;
}

export interface ConversationTurn {
	role: "user" | "assistant" | "tool";
	text?: string | undefined;
	thinking?: string | undefined;
	toolCalls?: ConversationToolCall[] | undefined;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return content === undefined || content === null ? "" : JSON.stringify(content);

	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === "string") {
			parts.push(block);
			continue;
		}
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		if (block.type === "image") parts.push("[image]");
	}
	return parts.join("");
}

export function contentThinking(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === "thinking") {
			if (typeof block.thinking === "string") parts.push(block.thinking);
			else if (typeof block.text === "string") parts.push(block.text);
		}
	}
	return parts.join("");
}

export function contentToolCalls(content: unknown): ConversationToolCall[] {
	if (!Array.isArray(content)) return [];
	const calls: ConversationToolCall[] = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
			calls.push({ id: block.id, name: block.name, arguments: block.arguments ?? {} });
		}
	}
	return calls;
}

export function buildConversation(input: TraceInput): ConversationTurn[] {
	const realism = input.realism ?? true;
	const clean = (text: string): string => (realism ? scrubText(text) : text);
	const turns: ConversationTurn[] = [{ role: "user", text: input.prompt }];

	for (const event of input.events) {
		if (event.type === "message" && event.role === "assistant") {
			const toolCalls = contentToolCalls(event.content);
			turns.push({
				role: "assistant",
				text: clean(contentText(event.content)) || undefined,
				thinking: clean(contentThinking(event.content)) || undefined,
				toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
			});
		} else if (event.type === "tool_result") {
			turns.push({
				role: "tool",
				toolCallId: event.id,
				toolName: event.name,
				text: clean(contentText(event.content)),
				isError: event.isError,
			});
		}
	}

	return turns;
}

export function toolJson(tool: TraceTool): Record<string, unknown> {
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters ?? { type: "object", properties: {} },
	};
}
