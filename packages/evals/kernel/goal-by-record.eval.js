/**
 * A goal that ends when the record of the work agrees.
 *
 * The model here is SCRIPTED: each case fixes the tool calls and the words,
 * so nothing measures whether a model would claim a goal is met, only what
 * the kernel does when it does. Every scenario is run twice, once with the
 * present behaviour (the model's report ends the goal) and once with the goal
 * confirmed by the record, and the same three things are scored for both:
 *
 * - `verdict`: what the kernel's record says about the work as the turn left
 *   it (the SDK's `outcomeScorer`), so a goal the present behaviour ended
 *   over a failing check is seen for what it was;
 * - `ending`: how the goal ended (`model:complete` for the present behaviour,
 *   or `confirmed`, `stated-not-checked`, `not-confirmed`);
 * - `steps`: how many model calls the case took, pinned so a change in the
 *   loop shows up as a score that moved. The count is in the score's details.
 *
 * Plain JavaScript, as the other suites are: the runner imports it directly.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	GoalConfirmation,
	InMemorySessionGoalStore,
	InMemorySessionStore,
	MockLLMProvider,
	SessionPaths,
	autoApproveHandler,
	buildSessionGoalTools,
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
	slugForCwd,
	toolset,
} from "@namzu/sdk";
import { z } from "zod";

const edit = { toolCalls: [{ id: "e", name: "edit", rawArguments: '{"path":"a.ts"}' }] };
const shell = (exit = 0) => ({
	toolCalls: [
		{
			id: "b",
			name: "bash",
			rawArguments: JSON.stringify({ command: "pnpm test", exit }),
		},
	],
});
const complete = (reasonCode) => ({
	toolCalls: [
		{
			id: "u",
			name: "update_goal",
			rawArguments: JSON.stringify({
				status: "complete",
				...(reasonCode ? { reasonCode, reason: "there is no test here" } : {}),
			}),
		},
	],
});
const say = (text) => ({ text });

/** An `edit` that changes the workspace and a `bash` that reports an exit status. */
function workTools() {
	return [
		defineTool({
			name: "edit",
			description: "edit a file, for the eval suite",
			inputSchema: z.object({ path: z.string() }),
			category: "custom",
			permissions: [],
			readOnly: false,
			destructive: false,
			concurrencySafe: false,
			execute: async (input) => ({
				success: true,
				output: "edited",
				facts: { kind: "edit", path: input.path, replacements: 1 },
			}),
		}),
		defineTool({
			name: "bash",
			description: "run a command, for the eval suite",
			inputSchema: z.object({ command: z.string(), exit: z.number().optional() }),
			category: "custom",
			permissions: [],
			readOnly: false,
			destructive: false,
			concurrencySafe: false,
			execute: async (input) => {
				const exitCode = input.exit ?? 0;
				return {
					success: exitCode === 0,
					output: exitCode === 0 ? "ok" : "failed",
					...(exitCode === 0 ? {} : { error: `Command exited with code ${exitCode}` }),
					facts: { kind: "command", command: input.command, exitCode },
				};
			},
		}),
	];
}

/** @param {{script: unknown[] | ((index: number) => unknown), confirmedBy: "model" | "record"}} input */
async function runCase(input) {
	const scratch = await mkdtemp(join(tmpdir(), "namzu-eval-"));
	try {
		const sessions = new InMemorySessionStore();
		const tenantId = generateTenantId();
		const project = await sessions.createProject(
			{ tenantId, name: "goal by record" },
			tenantId,
		);
		const session = await sessions.createSession(
			{ projectId: project.id, topicId: generateTopicId(), currentActor: null },
			tenantId,
		);
		const goals = new InMemorySessionGoalStore({ sessions });
		const created = await goals.createGoal(
			{
				sessionId: session.id,
				objective: "make the tests pass",
				confirmedBy: input.confirmedBy,
			},
			tenantId,
		);
		const authority = await goals.admitRound(session.id, tenantId, created);
		const confirmation = new GoalConfirmation({
			store: goals,
			resolveAuthority: () => authority,
		});
		const script = input.script;
		const turn = await drainQuery({
			provider: new MockLLMProvider(
				typeof script === "function"
					? { nextTurn: (_params, index) => script(index) }
					: { turns: script },
			),
			toolsets: [
				toolset("goal-by-record", [
					...workTools(),
					...buildSessionGoalTools(goals, () => authority, { confirmation }),
				]),
			],
			turnConfig: {
				model: "mock-model",
				timeoutMs: 30_000,
				tokenBudget: 1_000_000,
				maxIterations: 40,
				maxResponseTokens: 512,
				outcome: { beforeEnd: confirmation.beforeEnd("turn") },
			},
			agentId: "agent_eval",
			agentName: "Eval Agent",
			workingDirectory: scratch,
			paths: new SessionPaths({
				home: join(scratch, ".namzu"),
				slug: slugForCwd(scratch),
			}),
			sessionId: generateSessionId(),
			topicId: generateTopicId(),
			projectId: generateProjectId(),
			tenantId: generateTenantId(),
			messages: [{ role: "user", content: "make the tests pass", timestamp: 1 }],
			resumeHandler: autoApproveHandler,
		});
		const goal = await goals.getGoal(session.id, tenantId);
		const ending = confirmation.takeEnding("turn");
		return {
			...evalTurnFromTurn(turn),
			goalEnding: ending ? ending.ending : `model:${goal?.phase}`,
		};
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

const verdictScorer = customScorer("verdict", (turn, evalCase) =>
	outcomeScorer([evalCase.expected.verdict]).score(turn, evalCase),
);

const endingScorer = customScorer("ending", (turn, evalCase) => {
	const got = /** @type {{goalEnding?: string}} */ (turn).goalEnding;
	const want = evalCase.expected.ending;
	return {
		score: got === want ? 1 : 0,
		reason: got === want ? `the goal ended as ${got}` : `the goal ended as ${got}, expected ${want}`,
		details: { ending: got },
	};
});

const stepsScorer = customScorer("steps", (turn, evalCase) => {
	const got = turn.steps.length;
	const want = evalCase.expected.steps;
	return {
		score: got === want ? 1 : 0,
		reason: `${got} model calls${got === want ? "" : `, expected ${want}`}`,
		details: { steps: got },
	};
});

/** Edit, check, report, answer: the first attempt of a goal that never passes, then the same again. */
const neverPasses = (index) =>
	index === 0 ? edit : [shell(1), complete(), say("Done.")][(index - 1) % 3];

/** One scenario, run under the present behaviour and under the record. */
function pair(name, script, off, record) {
	return [
		{
			name: `${name} (the model's report ends the goal)`,
			input: { script, confirmedBy: "model" },
			expected: off,
		},
		{
			name: `${name} (the record confirms the goal)`,
			input: { script, confirmedBy: "record" },
			expected: record,
		},
	];
}

export default async function goalByRecord() {
	return runExperiment({
		name: "kernel/goal-by-record",
		scorers: [verdictScorer, endingScorer, stepsScorer, completionScorer()],
		run: (input) => runCase(input),
		cases: [
			...pair(
				"a goal reported met after a failing check, then fixed",
				[edit, shell(1), complete(), say("Done."), edit, shell(0), complete(), say("Fixed and checked.")],
				{ verdict: "failing", ending: "model:complete", steps: 4 },
				{ verdict: "checked", ending: "confirmed", steps: 8 },
			),
			...pair(
				"a goal reported met after editing past a passing check",
				[edit, shell(0), edit, complete(), say("Done."), shell(0), complete(), say("Checked again.")],
				{ verdict: "stale", ending: "model:complete", steps: 5 },
				{ verdict: "checked", ending: "confirmed", steps: 8 },
			),
			...pair(
				"a goal reported met with no check available",
				[edit, complete("no-check-available"), say("There is no test here.")],
				{ verdict: "unchecked", ending: "model:complete", steps: 3 },
				{ verdict: "unchecked", ending: "stated-not-checked", steps: 3 },
			),
			...pair(
				"a goal whose check never passes",
				neverPasses,
				{ verdict: "failing", ending: "model:complete", steps: 4 },
				{ verdict: "failing", ending: "not-confirmed", steps: 13 },
			),
		],
	});
}
