import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { asHarnessError } from "../errors.ts";
import type { TraceExportFailure, TraceFormat } from "../types.ts";
import type { TraceInput } from "./conversation.ts";
import { renderQwen3 } from "./qwen3.ts";

export type { TraceInput, TraceTool } from "./conversation.ts";
export { scrubText } from "./scrub.ts";

/** One exporter entry. `extension` is the file name written under traces/. */
export interface TraceRenderer {
	format: TraceFormat;
	extension: string;
	render(input: TraceInput, realism?: boolean): string;
}

function jsonlRenderer(): TraceRenderer {
	return {
		format: "jsonl",
		extension: "events.jsonl",
		render(input) {
			const lines = input.events.map((event) => JSON.stringify(event));
			return lines.length > 0 ? `${lines.join("\n")}\n` : "";
		},
	};
}

function qwen3Renderer(): TraceRenderer {
	return {
		format: "qwen3",
		extension: "qwen3.txt",
		render: (input, realism) => renderQwen3(input, realism),
	};
}

export const TRACE_RENDERERS: Record<TraceFormat, TraceRenderer> = {
	qwen3: qwen3Renderer(),
	jsonl: jsonlRenderer(),
};

/** File name for a trace format, matching the documented run layout. */
export function traceFileName(format: TraceFormat): string {
	return TRACE_RENDERERS[format].extension;
}

/** Render one line for the caller to print. */
export function describeTraceFailure(failure: TraceExportFailure): string {
	const hint = failure.hint ? ` (hint: ${failure.hint})` : "";
	return `trace ${failure.format} failed [${failure.code}]: ${failure.message}${hint}`;
}

/**
 * Write every requested trace format.
 *
 * Failures are collected rather than thrown so one failed export cannot abort a
 * run. `onFailure` is invoked once per failed format, after all writes.
 */
export async function exportTraces(
	input: TraceInput,
	tracesDir: string,
	onFailure?: (failure: TraceExportFailure) => void,
): Promise<string[]> {
	await mkdir(tracesDir, { recursive: true });

	const written: string[] = [];
	const failures: TraceExportFailure[] = [];
	const realism = input.realism ?? input.config.systemPrompt.realism;
	for (const format of input.config.trace.formats) {
		try {
			const renderer = TRACE_RENDERERS[format];
			const path = join(tracesDir, renderer.extension);
			await writeFile(path, renderer.render({ ...input, realism }, realism), "utf8");
			written.push(path);
		} catch (error) {
			const harnessError = asHarnessError(error);
			failures.push({
				format,
				code: harnessError.code,
				message: harnessError.message,
				hint: harnessError.hint,
			});
		}
	}

	for (const failure of failures) onFailure?.(failure);
	return written;
}
