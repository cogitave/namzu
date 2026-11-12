/**
 * What the outcome record says of a call that did not run.
 *
 * The model here is SCRIPTED: each case fixes the tool calls and the words, so
 * nothing measures whether a model would make the call, only what the kernel's
 * record says once it has. A call the person declined, a rule refused, that
 * named no such tool, or that only launched work to go on elsewhere changed
 * nothing in the turn: the record must say `unchanged`, not that a command ran
 * that may have changed files. A call that did run still says it.
 *
 * - `verdict`: the outcome record's verdict (the SDK's `outcomeScorer`);
 * - `ran`: how many times the scripted command actually ran, read from the tool
 *   and not from the record, so a case cannot pass by the command having run
 *   and the record being silent about it.
 *
 * Plain JavaScript, as the other suites are: the runner imports it directly.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	InMemorySessionLog,
	MockLLMProvider,
	completionScorer,
	customScorer,
	defineTool,
	drainQuery,
	evalTurnFromTurn,
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
	outcomeScorer,
	runExperiment,
	toolset,
} from "@namzu/sdk";
import { z } from "zod";

const touch = { toolCalls: [{ id: "c1", name: "bash", args: { command: "touch made.txt" } }] };
const launch = {
	toolCalls: [{ id: "a1", name: "Agent", args: { description: "survey", background: true } }],
};
const say = (text) => ({ text });

function tools(counter) {
	return [
		defineTool({
			name: "bash",
			description: "run a command, for the eval suite",
			inputSchema: z.object({ command: z.string() }),
			category: "custom",
			permissions: [],
			readOnly: false,
			destructive: true,
			concurrencySafe: false,
			execute: async () => {
				counter.ran += 1;
				return { success: true, output: "ok" };
			},
		}),
		defineTool({
			name: "Agent",
			description: "launch a sub-agent, for the eval suite",
			inputSchema: z.object({ description: z.string(), background: z.boolean().optional() }),
			category: "custom",
			permissions: [],
			readOnly: false,
			destructive: false,
			concurrencySafe: true,
			execute: async (input) => ({
				success: true,
				output: "launched",
				...(input.background ? { launched: true } : {}),
			}),
		}),
	];
}

/** @param {{script: unknown[], decision?: unknown, rule?: boolean}} input */
async function runCase(input) {
	const scratch = await mkdtemp(join(tmpdir(), "namzu-eval-"));
	try {
		const counter = { ran: 0 };
		const sessionLog = new InMemorySessionLog({ sessionId: generateSessionId() });
		const turn = await drainQuery({
			provider: new MockLLMProvider({ turns: input.script }),
			toolsets: [toolset("did-not-run", tools(counter))],
			sessionLog,
			turnConfig: { model: "mock-model", timeoutMs: 30_000, tokenBudget: 1_000_000, maxIterations: 8, maxResponseTokens: 512 },
			...(input.rule
				? {
						authorizationGate: {
							enabled: true,
							rules: [{ type: "deny_by_name", toolNames: ["bash"] }],
							allowReadOnlyTools: false,
							denyDangerousPatterns: false,
							logDecisions: false,
						},
					}
				: {}),
			agentId: "agent_eval",
			agentName: "Eval Agent",
			workingDirectory: scratch,
			sessionId: sessionLog.sessionId,
			topicId: generateTopicId(),
			projectId: generateProjectId(),
			tenantId: generateTenantId(),
			messages: [{ role: "user", content: "do it", timestamp: 1 }],
			resumeHandler: async () => input.decision ?? { action: "continue" },
			retry: false,
		});
		return { ...evalTurnFromTurn(turn), ran: counter.ran };
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

const verdictScorer = customScorer("verdict", (turn, evalCase) =>
	outcomeScorer([evalCase.expected.verdict]).score(turn, evalCase),
);

const ranScorer = customScorer("ran", (turn, evalCase) => {
	const got = /** @type {any} */ (turn).ran;
	const ok = got === evalCase.expected.ran;
	return {
		score: ok ? 1 : 0,
		reason: ok ? `ran ${got}` : `ran ${got}, expected ${evalCase.expected.ran}`,
		details: { ran: got },
	};
});

export default async function callDidNotRunSuite() {
	return runExperiment({
		name: "kernel/call-did-not-run",
		disclosure: {
			mode: "scripted",
			roles: { agent: { provider: "MockLLMProvider", model: "scripted" } },
			routing: "off",
			reasoningEffort: "not applicable",
		},
		scorers: [verdictScorer, ranScorer, completionScorer()],
		run: (input) => runCase(input),
		cases: [
			{
				name: "a command that ran may have changed files",
				input: { script: [touch, say("Done.")] },
				expected: { verdict: "unknown", ran: 1 },
			},
			{
				name: "a command the person declined changed nothing",
				input: {
					script: [touch, say("Understood.")],
					decision: { action: "reject_tools", feedback: "The user declined this.", declined: {} },
				},
				expected: { verdict: "unchanged", ran: 0 },
			},
			{
				name: "a command a rule refused changed nothing",
				input: { rule: true, script: [touch, say("Blocked.")] },
				expected: { verdict: "unchanged", ran: 0 },
			},
			{
				name: "a call to a tool that is not there changed nothing",
				input: { script: [{ toolCalls: [{ id: "x", name: "no_such_tool", args: {} }] }, say("Could not.")] },
				expected: { verdict: "unchanged", ran: 0 },
			},
			{
				name: "a mere launch of a background sub-agent changed nothing",
				input: { script: [launch, say("Launched.")] },
				expected: { verdict: "unchanged", ran: 0 },
			},
			{
				name: "a launch followed by a command that ran still says it may have changed files",
				input: { script: [launch, touch, say("Done.")] },
				expected: { verdict: "unknown", ran: 1 },
			},
		],
	});
}
