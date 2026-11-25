/**
 * Remove harness-identity leakage from trace text before it is rendered.
 *
 * Modeled on veloai's `scrub_cot.py`: the PI_* hint is dropped line by line, and any
 * sentence naming a model, the evaluation, or its grader is dropped as a whole.
 */

/** pi's "You can inspect PI_* environment variables..." rule, in any spacing. */
const PI_ENV_HINT = /PI[ \t]*_[ \t]*\*/i;

/** Whole sentences containing any of these terms (word boundaries avoid `evalh`). */
const IDENTITY_SENTENCE =
	/\b(?:Kimi|Claude|ChatGPT|GPT|Gemini|Llama|Mistral|Mixtral|Qwen|Grok|DeepSeek|Sonnet|Opus|Haiku|Nova|benchmark|eval|grader|rubric|judge|hidden evaluator|expected dirs\/answer|common tasks|should infer|likely semantic)\b/i;

/** Real host paths that would otherwise leak into an exported trace. */
const EVAL_PATH = /\/home\/[A-Za-z0-9._-]+|\/tmp\/pi-eval|\/tmp\/sbx/g;

function scrubLine(line: string): string {
	return line
		.split(/(?<=[.!?])\s+/)
		.filter((sentence) => !PI_ENV_HINT.test(sentence) && !IDENTITY_SENTENCE.test(sentence))
		.join(" ");
}

/** Scrub identity, benchmark, and host-path wording one line/sentence at a time. */
export function scrubText(text: string): string {
	return text
		.split("\n")
		.flatMap((line) => {
			if (line.length === 0) return [line];
			const cleaned = scrubLine(line);
			// A line made entirely of scrubbed sentences (e.g. the PI_* hint) goes away.
			return cleaned.length > 0 ? [cleaned] : [];
		})
		.join("\n")
		.replace(EVAL_PATH, "");
}
