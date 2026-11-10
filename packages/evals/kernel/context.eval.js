/**
 * What the loop does when the context runs out.
 *
 * Compaction is the mechanism most likely to be changed by someone tuning a
 * number — a threshold, a recent-window size, a reset fraction — and the
 * most likely to break silently when they do: a run that compacts too
 * eagerly still finishes, just more expensively and with more paraphrased
 * away. That is exactly the shape a unit test does not catch and a
 * behaviour gate does.
 *
 * Scripted provider, so a score that moves is the kernel moving.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	COMPACTION_HEADER,
	COMPACTION_RESUME_NOTE,
	MockLLMProvider,
	SessionPaths,
	toolset,
	autoApproveHandler,
	createSlidingWindowReducer,
	customScorer,
	drainQuery,
	evalTurnFromTurn,
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
	runExperiment,
	slugForCwd,
} from "@namzu/sdk";
import { z } from "zod";

/** Long enough that a 2k window is comfortably exceeded. */
const BULK = "the quick brown fox jumps over the lazy dog ".repeat(120);

function toolsets() {
	return [
		toolset("test", [
			{
				name: "fetch_a_lot",
				description: "Return a large block of text.",
				inputSchema: z.object({}),
				category: "custom",
				permissions: [],
				readOnly: true,
				destructive: false,
				concurrencySafe: true,
				execute: async () => ({ success: true, output: BULK }),
			},
		]),
	];
}

async function runCase(input) {
	// One scratch directory per case, removed when the case ends. Every
	// case used to leave its directory, and the run state in it, behind.
	const scratch = await mkdtemp(join(tmpdir(), "namzu-eval-ctx-"));
	try {
		const turn = await drainQuery({
			provider: new MockLLMProvider({ turns: input.turns }),
			toolsets: toolsets(),
			turnConfig: {
				model: "mock-model",
				timeoutMs: 30_000,
				tokenBudget: 1_000_000,
				maxIterations: 6,
				maxResponseTokens: 256,
			},
			agentId: "agent_ctx",
			agentName: "Context Agent",
			workingDirectory: scratch,
			// State under the scratch directory, not the default root: the
			// directory is removed below, and with it everything the run wrote.
			paths: new SessionPaths({
				home: join(scratch, ".namzu"),
				slug: slugForCwd(scratch),
			}),
			sessionId: generateSessionId(),
			topicId: generateTopicId(),
			projectId: generateProjectId(),
			tenantId: generateTenantId(),
			messages: input.messages ?? [{ role: "user", content: "go", timestamp: 1 }],
			resumeHandler: autoApproveHandler,
			...(input.compactionConfig
				? { compactionConfig: input.compactionConfig }
				: {}),
			...(input.contextReducer ? { contextReducer: input.contextReducer } : {}),
		});

		const evalTurn = evalTurnFromTurn(turn);
		// The scorers below need the final history, which `EvalTurn` does not
		// carry. Attached rather than widening the shared type for one suite.
		return Object.assign(evalTurn, { finalMessages: turn.messages ?? [] });
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

const call = (id) => ({ id, name: "fetch_a_lot", rawArguments: "{}" });

/** A run must never end holding a tool result whose call is gone. */
const noOrphanedResults = customScorer("no-orphaned-tool-results", (turn) => {
	const messages = turn.finalMessages ?? [];
	const callIds = new Set();
	for (const m of messages) {
		for (const tc of m.toolCalls ?? []) callIds.add(tc.id);
	}
	const orphans = messages
		.filter(
			(m) => m.role === "tool" && m.toolCallId && !callIds.has(m.toolCallId),
		)
		.map((m) => m.toolCallId);

	return orphans.length === 0
		? { score: 1, reason: "every tool result still has its call" }
		: {
				score: 0,
				reason: `orphaned tool results: ${orphans.join(", ")} — the provider rejects the next turn with a 400`,
				details: { orphans },
			};
});

/** The system prefix is the agent's identity; compaction must not eat it. */
const keepsTheSystemFloor = customScorer("keeps-system-floor", (turn) => {
	const messages = turn.finalMessages ?? [];
	return messages[0]?.role === "system"
		? { score: 1, reason: "the leading system message survived" }
		: {
				score: 0,
				reason: `history now opens on ${messages[0]?.role ?? "nothing"}`,
			};
});

const settled = customScorer("settled", (turn) =>
	turn.error
		? { score: 0, reason: `turn threw: ${turn.error}` }
		: { score: 1, reason: `settled as ${turn.stopReason ?? "unknown"}` },
);

/**
 * A summary that replaces history must close on how to pick the work back up.
 * Scripted, so this checks the text the model would be handed, not how a
 * model behaves on it: that a finished step is not redone needs a live model.
 */
const summaryTellsHowToResume = customScorer(
	"summary-tells-how-to-resume",
	(turn) => {
		const summaries = (turn.finalMessages ?? []).filter(
			(m) =>
				typeof m.content === "string" && m.content.startsWith(COMPACTION_HEADER),
		);
		if (summaries.length === 0) {
			return { score: 1, reason: "no summary in this run, nothing to close" };
		}
		const bad = summaries.filter(
			(m) => m.content.split(COMPACTION_RESUME_NOTE).length !== 2,
		);
		return bad.length === 0
			? { score: 1, reason: "every summary closes on the resume note, once" }
			: { score: 0, reason: `${bad.length} summary without exactly one resume note` };
	},
);

export default async function context() {
	return runExperiment({
		name: "kernel/context",
		scorers: [
			noOrphanedResults,
			keepsTheSystemFloor,
			settled,
			summaryTellsHowToResume,
		],
		run: (input) => runCase(input),
		cases: [
			{
				name: "a run that outgrows its window still finishes",
				input: {
					turns: [
						{ toolCalls: [call("a")] },
						{ toolCalls: [call("b")] },
						{ toolCalls: [call("c")] },
						{ text: "finished" },
					],
					compactionConfig: {
						strategy: "structured",
						contextWindowTokens: 2_000,
						keepRecentMessages: 2,
						triggerThreshold: 0.5,
						resetThreshold: 0.4,
						llmVerification: false,
						richStateThreshold: 1_000,
						clearToolResults: true,
					},
				},
			},
			{
				// The cases above never fold history (their summary scorer passes
				// for lack of a summary); this one starts over the window, so the
				// first request is the one right after a compaction.
				name: "after a compaction the summary says how to carry on",
				input: {
					turns: [{ text: "finished" }],
					messages: [
						{ role: "user", content: "first request", timestamp: 1 },
						{ role: "assistant", content: `earlier work ${BULK}`, timestamp: 2 },
						{ role: "user", content: "second request", timestamp: 3 },
						{ role: "assistant", content: `more work ${BULK}`, timestamp: 4 },
						{ role: "user", content: "third request", timestamp: 5 },
					],
					compactionConfig: {
						strategy: "structured",
						contextWindowTokens: 1_000,
						keepRecentMessages: 2,
						llmVerification: false,
						clearToolResults: false,
					},
				},
			},
			{
				name: "the cheap sliding window finishes too, and summarizes nothing",
				input: {
					turns: [
						{ toolCalls: [call("a")] },
						{ toolCalls: [call("b")] },
						{ toolCalls: [call("c")] },
						{ text: "finished" },
					],
					compactionConfig: {
						strategy: "sliding-window",
						contextWindowTokens: 2_000,
						keepRecentMessages: 4,
						triggerThreshold: 0.5,
						resetThreshold: 0.4,
						llmVerification: false,
						richStateThreshold: 1_000,
						clearToolResults: true,
					},
				},
			},
			{
				name: "a host reducer that declines leaves the run intact",
				input: {
					turns: [{ toolCalls: [call("a")] }, { text: "finished" }],
					compactionConfig: {
						strategy: "structured",
						contextWindowTokens: 2_000,
						keepRecentMessages: 2,
						triggerThreshold: 0.5,
						resetThreshold: 0.4,
						llmVerification: false,
						richStateThreshold: 1_000,
						clearToolResults: true,
					},
					// Declining is a first-class answer, and the run must carry on
					// rather than treat it as a failure.
					contextReducer: () => undefined,
				},
			},
			{
				name: "a built-in reducer keeps the history usable",
				input: {
					turns: [
						{ toolCalls: [call("a")] },
						{ toolCalls: [call("b")] },
						{ text: "finished" },
					],
					compactionConfig: {
						strategy: "structured",
						contextWindowTokens: 2_000,
						keepRecentMessages: 3,
						triggerThreshold: 0.5,
						resetThreshold: 0.4,
						llmVerification: false,
						richStateThreshold: 1_000,
						clearToolResults: true,
					},
					contextReducer: createSlidingWindowReducer(),
				},
			},
			{
				name: "no compaction configured is still a working run",
				input: {
					turns: [{ toolCalls: [call("a")] }, { text: "finished" }],
				},
			},
		],
	});
}

export const tags = ["kernel", "ci"];
