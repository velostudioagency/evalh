import { describe, expect, it } from "vitest";
import { assistantTurnError, finalizeStatus } from "../src/harness/run-status.ts";

const base = {
	timedOut: false,
	timeoutSec: 30,
	limitHit: false,
	maxTurns: 10,
};

describe("finalizeStatus", () => {
	it("reports a provider turn error as failed instead of completed", () => {
		expect(finalizeStatus({ ...base, turnError: "401: Invalid API Key" })).toEqual({
			status: "failed",
			error: "401: Invalid API Key",
		});
	});

	it("lets a turn error outrank abort reasons", () => {
		expect(finalizeStatus({ ...base, timedOut: true, turnError: "401: Invalid API Key" })).toEqual({
			status: "failed",
			error: "401: Invalid API Key",
		});
	});

	it("reports a prompt throw as failed when nothing aborted", () => {
		expect(finalizeStatus({ ...base, promptError: "request failed" })).toEqual({
			status: "failed",
			error: "request failed",
		});
	});

	it("keeps an abort reason when the prompt threw during shutdown", () => {
		expect(finalizeStatus({ ...base, timedOut: true, promptError: "disposed" })).toEqual({
			status: "aborted",
			error: "Timed out after 30s",
		});
	});

	it("keeps the existing completed and aborted outcomes", () => {
		expect(finalizeStatus(base)).toEqual({ status: "completed" });
		expect(finalizeStatus({ ...base, timedOut: true })).toEqual({
			status: "aborted",
			error: "Timed out after 30s",
		});
		expect(finalizeStatus({ ...base, limitHit: true })).toEqual({
			status: "aborted",
			error: "Stopped after 10 turns",
		});
		expect(finalizeStatus({ ...base, interruptSignal: "SIGINT" })).toEqual({
			status: "aborted",
			error: "Interrupted by SIGINT",
		});
	});
});

describe("assistantTurnError", () => {
	it("uses the assistant errorMessage when present", () => {
		expect(assistantTurnError({ role: "assistant", stopReason: "error", errorMessage: "401: Invalid API Key" })).toBe(
			"401: Invalid API Key",
		);
	});

	it("falls back when an error stopReason has no message", () => {
		expect(assistantTurnError({ role: "assistant", stopReason: "error" })).toBe("Assistant turn ended with an error");
	});

	it("returns undefined for a successful, aborted, or non-assistant message", () => {
		expect(assistantTurnError({ role: "assistant", stopReason: "stop" })).toBeUndefined();
		expect(
			assistantTurnError({ role: "assistant", stopReason: "aborted", errorMessage: "disposed" }),
		).toBeUndefined();
		expect(assistantTurnError({ role: "user" })).toBeUndefined();
	});
});
