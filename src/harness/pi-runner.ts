import { appendFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	createAgentSession,
	DefaultResourceLoader,
	type InlineExtension,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { parseModelRef } from "../config.ts";
import { HarnessError } from "../errors.ts";
import type { EventInput, RunStore } from "../run-store.ts";
import { readPrompt } from "../task.ts";
import { describeTraceFailure, exportTraces } from "../trace/index.ts";
import type {
	CanonicalEvent,
	ResolvedTask,
	RunResult,
	TraceExportFailure,
	TraceExportSummary,
	Usage,
} from "../types.ts";
import { captureDiff } from "../workspace.ts";
import { buildPromptBundle } from "./prompt.ts";
import { assistantTurnError, finalizeStatus } from "./run-status.ts";
import { resolveToolNames } from "./tool-families.ts";

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function toUsage(usage: unknown): Usage | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const value = usage as Record<string, unknown>;
	const pick = (key: string): number | undefined =>
		typeof value[key] === "number" ? (value[key] as number) : undefined;
	return {
		input: pick("input"),
		output: pick("output"),
		cacheRead: pick("cacheRead"),
		cacheWrite: pick("cacheWrite"),
		totalTokens: pick("totalTokens"),
		cost: value.cost,
	};
}

function addUsage(total: Usage, next: Usage | undefined): Usage {
	if (!next) return total;
	return {
		input: (total.input ?? 0) + (next.input ?? 0),
		output: (total.output ?? 0) + (next.output ?? 0),
		cacheRead: (total.cacheRead ?? 0) + (next.cacheRead ?? 0),
		cacheWrite: (total.cacheWrite ?? 0) + (next.cacheWrite ?? 0),
		totalTokens: (total.totalTokens ?? 0) + (next.totalTokens ?? 0),
		cost: next.cost ?? total.cost,
	};
}

interface EventQueue {
	emit(event: EventInput): void;
	enqueue(task: () => Promise<void>): void;
	drain(): Promise<void>;
}

/**
 * Serialize all canonical event writes, including artifact-backed capture events,
 * so `seq` follows the order in which pi emitted them. A failed write is recorded
 * instead of rejecting the chain, so later events and run finalization still happen.
 */
function createEventQueue(run: RunStore): EventQueue {
	let chain: Promise<void> = Promise.resolve();
	const failures: string[] = [];
	let reported = false;

	const enqueue = (task: () => Promise<void>): void => {
		chain = chain.then(async () => {
			try {
				await task();
			} catch (error) {
				failures.push(error instanceof Error ? error.message : String(error));
			}
		});
	};

	return {
		enqueue,
		emit: (event) =>
			enqueue(async () => {
				await run.append(event);
			}),
		async drain() {
			await chain;
			if (failures.length > 0 && !reported) {
				reported = true;
				const messages = [...failures];
				failures.length = 0;
				enqueue(async () => {
					await run.append({
						type: "error",
						message: "event write failed",
						code: "capture_write_failed",
						stack: messages.join("; "),
					});
				});
				await chain;
			}
		},
	};
}

function createCaptureExtension(run: RunStore, queue: EventQueue): InlineExtension {
	let index = 0;
	return {
		name: "evalh-capture",
		hidden: true,
		factory: (pi) => {
			pi.on("before_provider_request", async (event) => {
				const requestId = `req-${String(++index).padStart(4, "0")}`;
				const relative = join("requests", `${requestId}.json`);
				const payload = `${JSON.stringify(event.payload, null, 2)}\n`;
				queue.enqueue(async () => {
					await run.writeArtifact(relative, payload);
					await run.append({ type: "model_request", requestId, path: relative });
				});
			});
			pi.on("after_provider_response", async (event) => {
				queue.emit({ type: "provider_response", status: event.status, headers: event.headers });
			});
		},
	};
}

export interface PiRunOptions {
	task: ResolvedTask;
	run: RunStore;
	workspaceDir: string;
}

export async function runPiTask(options: PiRunOptions): Promise<RunResult> {
	const { task, run, workspaceDir } = options;
	const config = task.config;
	const startedAt = Date.now();
	const modelRef = parseModelRef(config.model);
	const queue = createEventQueue(run);

	const modelRuntime = await ModelRuntime.create({});
	const model = modelRuntime.getModel(modelRef.provider, modelRef.id);
	if (!model) {
		throw new HarnessError(
			"model_not_found",
			`Model not available: ${config.model}`,
			"Authenticate with pi, or add a custom provider/model to ~/.pi/agent/models.json. Run `evalh doctor` for details.",
		);
	}

	const prompt = await readPrompt(task);
	await run.writeArtifact(join("logs", "prompt.md"), prompt);
	const bundle = await buildPromptBundle(task, workspaceDir);
	const toolNames = resolveToolNames(config.toolFamily, config.tools);

	const loader = new DefaultResourceLoader({
		cwd: workspaceDir,
		agentDir: agentDir(),
		extensionFactories: [createCaptureExtension(run, queue)],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		...(bundle.systemPrompt !== undefined ? { systemPrompt: bundle.systemPrompt } : {}),
		appendSystemPrompt: bundle.append,
	});
	await loader.reload();

	let session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	try {
		const created = await createAgentSession({
			cwd: workspaceDir,
			agentDir: agentDir(),
			modelRuntime,
			model,
			thinkingLevel: config.thinkingLevel as ThinkingLevel,
			...(toolNames !== undefined ? { tools: toolNames } : {}),
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(workspaceDir),
		});
		session = created.session;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new HarnessError("session_failed", `Could not start pi session: ${message}`);
	}

	const systemPrompt = session.systemPrompt;
	await run.writeArtifact(join("logs", "system-prompt.txt"), `${systemPrompt}\n`);
	const toolDefinitions = session.getAllTools().map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}));
	await run.writeArtifact(join("logs", "tools.json"), `${JSON.stringify(toolDefinitions, null, 2)}\n`);

	let turns = 0;
	let usage: Usage = {};
	let turnError: string | undefined;
	let promptError: string | undefined;
	let turnErrorReported = false;
	let limitHit = false;
	let timedOut = false;
	let interruptSignal: string | undefined;
	let responseCount = 0;

	let sessionChain: Promise<void> = Promise.resolve();

	const sessionPath = join(run.dir, run.meta.paths.sessionPath);
	const logSession = (event: unknown): void => {
		sessionChain = sessionChain.then(async () => {
			await appendFile(sessionPath, `${JSON.stringify({ ts: new Date().toISOString(), event })}\n`, "utf8");
		});
	};

	await run.setStatus("running");
	await run.append({
		type: "run_start",
		task: task.id,
		family: task.family,
		harness: config.harness,
		model: config.model,
		env: { ...config.env, cwd: config.env.cwd ?? workspaceDir },
	});

	const unsubscribe = session.subscribe((event) => {
		logSession(event);

		switch (event.type) {
			case "message_end": {
				const message = event.message as unknown as {
					role?: string;
					content?: unknown;
					usage?: unknown;
					stopReason?: string;
					errorMessage?: string;
				};
				if (message.role === "assistant") {
					turnError = assistantTurnError(message);
					if (turnError && !turnErrorReported) {
						turnErrorReported = true;
						queue.emit({ type: "error", message: turnError, code: "provider_error" });
					}
					const responseId = `resp-${String(++responseCount).padStart(4, "0")}`;
					const relative = join("responses", `${responseId}.json`);
					const rawMessage = `${JSON.stringify(event.message, null, 2)}\n`;
					queue.enqueue(async () => {
						await run.writeArtifact(relative, rawMessage);
						await run.append({ type: "response", role: "assistant", path: relative });
					});

					const messageUsage = toUsage(message.usage);
					usage = addUsage(usage, messageUsage);
					queue.emit({ type: "message", role: "assistant", content: message.content, usage: messageUsage });
					const content = Array.isArray(message.content) ? message.content : [];
					for (const block of content) {
						const candidate = block as { type?: string; id?: string; name?: string; arguments?: unknown };
						if (candidate.type === "toolCall" && candidate.id && candidate.name) {
							queue.emit({
								type: "tool_call",
								id: candidate.id,
								name: candidate.name,
								arguments: candidate.arguments ?? {},
							});
						}
					}
				} else if (message.role === "user") {
					queue.emit({ type: "message", role: "user", content: message.content });
				}
				break;
			}
			case "tool_execution_end": {
				queue.emit({
					type: "tool_result",
					id: event.toolCallId,
					name: event.toolName,
					content: (event.result as { content?: unknown })?.content ?? event.result,
					isError: event.isError,
					durationMs: event.durationMs,
				});
				break;
			}
			case "turn_end": {
				turns += 1;
				if (turns >= config.limits.maxTurns && !limitHit) {
					limitHit = true;
					try {
						session.dispose();
					} catch {
						// Already settling.
					}
				}
				break;
			}
			case "agent_end": {
				// The final assistant message is authoritative: a later successful turn clears an earlier error.
				for (const message of event.messages) {
					if (message.role !== "assistant") continue;
					turnError = assistantTurnError(message);
				}
				break;
			}
			default:
				break;
		}
	});

	const timer = setTimeout(() => {
		timedOut = true;
		try {
			session.dispose();
		} catch {
			// Already settling.
		}
	}, config.limits.timeoutSec * 1000);

	const onInterrupt = (signal: string): void => {
		if (interruptSignal) return;
		interruptSignal = signal;
		queue.emit({ type: "error", message: "interrupted", code: "interrupted", stack: signal });
		try {
			session.dispose();
		} catch {
			// Already settling.
		}
	};
	const onSigint = (): void => onInterrupt("SIGINT");
	const onSigterm = (): void => onInterrupt("SIGTERM");
	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigterm);

	try {
		await session.prompt(prompt, { expandPromptTemplates: false });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!timedOut && !limitHit && !interruptSignal) {
			promptError = message;
			queue.emit({ type: "error", message, stack: error instanceof Error ? error.stack : undefined });
		}
	} finally {
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
		clearTimeout(timer);
		unsubscribe();
		try {
			session.dispose();
		} catch {
			// Already disposed.
		}
	}

	const finalized = finalizeStatus({
		turnError,
		promptError,
		timedOut,
		timeoutSec: config.limits.timeoutSec,
		limitHit,
		maxTurns: config.limits.maxTurns,
		interruptSignal,
	});
	const status = finalized.status;
	const errorMessage = finalized.error;

	await queue.drain();
	await sessionChain;

	const durationMs = Date.now() - startedAt;
	try {
		await captureDiff(workspaceDir, run.meta.workspace.baseCommit, join(run.dir, run.meta.paths.diffPath));
	} catch (error) {
		queue.emit({
			type: "error",
			message: error instanceof Error ? error.message : String(error),
		});
		await queue.drain();
	}

	queue.emit({ type: "run_end", status, turns, usage, durationMs });
	await queue.drain();

	const events = await run.readEvents();
	const traceFailures: TraceExportFailure[] = [];
	const tracePaths = await exportTraces(
		{ events, systemPrompt, prompt, tools: toolDefinitions, config },
		join(run.dir, run.meta.paths.tracesDir),
		(failure) => traceFailures.push(failure),
	);
	const traces: TraceExportSummary = { paths: tracePaths, failures: traceFailures };

	await run.finish({ status, turns, usage, durationMs, error: errorMessage, traces });

	await writeFile(
		join(run.dir, run.meta.paths.logsDir, "runner.log"),
		[
			`task: ${task.family}/${task.id}`,
			`model: ${config.model}`,
			`harness: ${config.harness}`,
			`toolFamily: ${config.toolFamily}`,
			`status: ${status}`,
			`turns: ${turns}`,
			`durationMs: ${durationMs}`,
			errorMessage ? `error: ${errorMessage}` : undefined,
			...traceFailures.map(describeTraceFailure),
			"",
		]
			.filter((line): line is string => line !== undefined)
			.join("\n"),
		"utf8",
	);

	return { status, turns, usage, durationMs, error: errorMessage, traces };
}

export type { CanonicalEvent };
