import { buildConversation, type TraceInput, toolJson } from "./conversation.ts";

const IM_START = "<|im_start|>";
const IM_END = "<|im_end|>\n";

const TOOLS_HEADER =
	"# Tools\n\nYou may call one or more functions to assist with the user query.\n\nYou are provided with function signatures within <tools></tools> XML tags:\n<tools>";
const TOOLS_FOOTER =
	'\n</tools>\n\nFor each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:\n<tool_call>\n{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call>';

/** Quote a string the way Jinja's `tojson` filter does: sorted-key JSON with ASCII-safe HTML characters. */
function jsonQuoted(value: string): string {
	return JSON.stringify(value)
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/&/g, "\\u0026")
		.replace(/'/g, "\\u0027")
		.replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function compareKeys(left: string, right: string): number {
	const a = Array.from(left);
	const b = Array.from(right);
	for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
		const diff = (a[i].codePointAt(0) ?? 0) - (b[i].codePointAt(0) ?? 0);
		if (diff !== 0) return diff;
	}
	return a.length - b.length;
}

/** Serialize with Python `json.dumps(sort_keys=True)` separators, as the template's `tojson` filter does. */
function dumpSorted(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (typeof value === "string") return jsonQuoted(value);
	if (Array.isArray(value)) return `[${value.map(dumpSorted).join(", ")}]`;
	if (typeof value === "object") {
		const entries = Object.entries(value)
			.sort(([left], [right]) => compareKeys(left, right))
			.map(([key, item]) => `${jsonQuoted(key)}: ${dumpSorted(item)}`);
		return `{${entries.join(", ")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function stripNewlines(value: string): string {
	return value.replace(/^\n+/, "").replace(/\n+$/, "");
}

function renderSystem(systemPrompt: string, tools: TraceInput["tools"]): string {
	if (tools.length === 0) return `${IM_START}system\n${systemPrompt}${IM_END}`;
	const prefix = systemPrompt.length > 0 ? `${systemPrompt}\n\n` : "";
	const lines = tools.map((tool) => `\n${dumpSorted(toolJson(tool))}`).join("");
	return `${IM_START}system\n${prefix}${TOOLS_HEADER}${lines}${TOOLS_FOOTER}${IM_END}`;
}

/** Render a trace with the vendored qwen3 chat template in full-transcript mode. */
export function renderQwen3(input: TraceInput, realism: boolean = input.realism ?? true): string {
	const turns = buildConversation({ ...input, realism });
	const lastIndex = turns.length - 1;
	const parts: string[] = [renderSystem(input.systemPrompt, input.tools)];
	let inToolGroup = false;

	for (const [index, turn] of turns.entries()) {
		if (turn.role === "user") {
			parts.push(`${IM_START}user\n${turn.text ?? ""}${IM_END}`);
			continue;
		}

		if (turn.role === "tool") {
			if (!inToolGroup) {
				parts.push(`${IM_START}user`);
				inToolGroup = true;
			}
			parts.push(`\n<tool_response>\n${turn.text ?? ""}\n</tool_response>`);
			if (index === lastIndex || turns[index + 1].role !== "tool") {
				parts.push(IM_END);
				inToolGroup = false;
			}
			continue;
		}

		const text = turn.text ?? "";
		const thinking = turn.thinking ?? "";
		const showThinking = index === lastIndex || thinking.length > 0;
		const body = showThinking ? `<think>\n${stripNewlines(thinking)}\n</think>\n\n${text.replace(/^\n+/, "")}` : text;
		parts.push(`${IM_START}assistant\n${body}`);

		const calls = turn.toolCalls ?? [];
		for (const [callIndex, call] of calls.entries()) {
			if (callIndex > 0 || text.length > 0) parts.push("\n");
			const args = typeof call.arguments === "string" ? call.arguments : dumpSorted(call.arguments);
			parts.push(`<tool_call>\n{"name": "${call.name}", "arguments": ${args}}\n</tool_call>`);
		}
		parts.push(IM_END);
	}

	return parts.join("");
}
