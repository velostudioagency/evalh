import type { RunStatus } from "../types.ts";

/** Inputs that decide the terminal status of an eval run. */
export interface FinalizeStatusInput {
	/** Error text from a failed assistant turn, if one was observed. */
	turnError?: string | undefined;
	/** Error text thrown by the prompt call when no abort was in progress. */
	promptError?: string | undefined;
	timedOut: boolean;
	timeoutSec: number;
	limitHit: boolean;
	maxTurns: number;
	interruptSignal?: string | undefined;
}

/**
 * Choose the terminal status and error text for a run.
 *
 * A failed assistant turn wins over every abort reason: a provider error must never
 * be reported as a completed run. A prompt throw counts as a failure only when no
 * abort was in progress, matching the previous runner behaviour.
 */
export function finalizeStatus(input: FinalizeStatusInput): { status: RunStatus; error?: string } {
	if (input.turnError) return { status: "failed", error: input.turnError };
	if (input.timedOut) return { status: "aborted", error: `Timed out after ${input.timeoutSec}s` };
	if (input.limitHit) return { status: "aborted", error: `Stopped after ${input.maxTurns} turns` };
	if (input.interruptSignal) return { status: "aborted", error: `Interrupted by ${input.interruptSignal}` };
	if (input.promptError) return { status: "failed", error: input.promptError };
	return { status: "completed" };
}

/**
 * Return the error text carried by a failed assistant message, if any.
 *
 * Provider failures arrive as an assistant message with `stopReason: "error"` and
 * usually an `errorMessage` (for example a 401). A later successful turn clears the
 * error, so callers can treat the last assistant message as authoritative.
 */
export function assistantTurnError(message: {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
}): string | undefined {
	if (message.role !== "assistant") return undefined;
	// An abort also carries an errorMessage; leave those runs to the abort reasons in finalizeStatus.
	if (message.stopReason === "aborted") return undefined;
	if (message.errorMessage?.trim()) return message.errorMessage;
	if (message.stopReason === "error") return "Assistant turn ended with an error";
	return undefined;
}
