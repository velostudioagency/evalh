import { describe, expect, it } from "vitest";
import { scrubText } from "../src/trace/scrub.ts";

describe("scrubText", () => {
	it("removes the PI_* env inspection hint line", () => {
		const before = [
			"- Use read to examine files instead of cat or sed.",
			"- You can inspect PI_* environment variables for current model and session details.",
			"- Use edit for targeted changes.",
		].join("\n");

		expect(scrubText(before)).toBe(
			["- Use read to examine files instead of cat or sed.", "- Use edit for targeted changes."].join("\n"),
		);
	});

	it("removes identity sentences but keeps the rest", () => {
		const before = "This is normal. I am Claude and I should know. Another normal sentence.";
		expect(scrubText(before)).toBe("This is normal. Another normal sentence.");
	});

	it("removes benchmark/grader sentences and eval paths", () => {
		const before = "Run the tests. This is a hidden evaluator benchmark. Work in /home/dev/project and /tmp/sbx/cache. Done.";
		expect(scrubText(before)).toBe("Run the tests. Work in /project and /cache. Done.");
	});

	it("preserves ordinary text exactly", () => {
		const text = "Read the file, then edit it.\nRun `npm test`.\nOutput: 4.\n";
		expect(scrubText(text)).toBe(text);
	});
});
