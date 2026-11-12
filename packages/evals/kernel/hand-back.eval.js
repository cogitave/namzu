/**
 * A model that may hand a task back to a person.
 *
 * The model here is SCRIPTED: each case fixes the tool calls and the words, so
 * nothing measures whether a real model would hand a task back or would have
 * finished it. What is pinned is what the kernel does when it does, and when it
 * does not:
 *
 * - `handed-back`: whether the turn was handed back, and as which kind (the
 *   SDK's `handedBackScorer`);
 * - `verdict`: the outcome record's verdict, which stays the record of the work
 *   (a turn can change files and be handed back);
 * - `steps`: model calls made. A hand-back is the last one;
 * - `edits`: how many times the scripted `edit` tool actually ran, so a call
 *   made in the same step as the hand-back, or after it, is seen not to run;
 * - `closing`: the kernel's own sentence for the closing line, and that the
 *   model's words are labelled as the model's;
 * - `offered`: whether the tool and the guidance reached the model at all
 *   (with the setting off they must not);
 * - `goal`: how a goal round that was handed back ended.
 *
 * The exit status of `namzu exec` and the status of a scheduled run belong to
 * the command line package and are pinned by its own tests, not here.
 *
 * Plain JavaScript, as the other suites are: the runner imports it directly.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	GoalConfirmation,
	HAND_BACK_TOOL_NAME,
	InMemorySessionGoalStore,
	InMemorySessionStore,
	MockLLMProvider,
	SessionPaths,
	autoApproveHandler,
	buildSessionGoalTools,
	completionScorer,
	customScorer,
	defineTool,
	describeHandBack,
	drainQuery,
	evalTurnFromTurn,
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
	handBackModelLines,
	handedBackScorer,
	outcomeScorer,
	runExperiment,
	slugForCwd,
	toolset,
} from "@namzu/sdk";
import { z } from "zod";

const handBack = (kind, id = "h") => ({
	id,
	name: HAND_BACK_TOOL_NAME,
	args: {
		kind,
		blocker: "the check asserts 3 and the request says 4",
		tried: "read both and ran the check",
		needed: "say which number is right",
	},
});
const edit = (id = "e") => ({ id, name: "edit", args: { path: "a.ts" } });
const shell = { toolCalls: [{ id: "b", name: "bash", args: { command: "pnpm test" } }] };
const failingShell = { toolCalls: [{ id: "f", name: "bash", args: { command: "pnpm test --failing" } }] };
const say = (text) => ({ text });

/** An `edit` that changes the workspace, counted, and a `bash` that passes. */
function workTools(counter) {
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
			execute: async (input) => {
				counter.edits += 1;
				return {
					success: true,
					output: "edited",
					facts: { kind: "edit", path: input.path, replacements: 1 },
				};
			},
		}),
		defineTool({
			name: "bash",
			description: "run a command, for the eval suite",
			inputSchema: z.object({ command: z.string() }),
			category: "custom",
			permissions: [],
			readOnly: false,
			destructive: false,
			concurrencySafe: false,
			execute: async (input) => {
				const failing = input.command.includes("--failing");
				return {
					success: !failing,
					output: failing ? "1 failed" : "ok",
					facts: { kind: "command", command: input.command, exitCode: failing ? 1 : 0 },
				};
			},
		}),
	];
}

/** @param {{script: unknown[], handBack: boolean, goal?: boolean}} input */
async function runCase(input) {
	const scratch = await mkdtemp(join(tmpdir(), "namzu-eval-"));
	try {
		const sessions = new InMemorySessionStore();
		const tenantId = generateTenantId();
		const project = await sessions.createProject({ tenantId, name: "hand back" }, tenantId);
		const session = await sessions.createSession(
			{ projectId: project.id, topicId: generateTopicId(), currentActor: null },
			tenantId,
		);
		const goals = new InMemorySessionGoalStore({ sessions });
		const created = await goals.createGoal(
			{ sessionId: session.id, objective: "make the check pass" },
			tenantId,
		);
		const authority = input.goal ? await goals.admitRound(session.id, tenantId, created) : undefined;
		const confirmation = new GoalConfirmation({ store: goals, resolveAuthority: () => authority });
		const counter = { edits: 0 };
		const provider = new MockLLMProvider({ turns: input.script });
		const turn = await drainQuery({
			provider,
			toolsets: [
				toolset("hand-back", [
					...workTools(counter),
					...(authority ? buildSessionGoalTools(goals, () => authority, { confirmation }) : []),
				]),
			],
			turnConfig: {
				model: "mock-model",
				timeoutMs: 30_000,
				tokenBudget: 1_000_000,
				maxIterations: 20,
				maxResponseTokens: 512,
				...(input.handBack ? { handBack: true } : {}),
			},
			agentId: "agent_eval",
			agentName: "Eval Agent",
			workingDirectory: scratch,
			paths: new SessionPaths({ home: join(scratch, ".namzu"), slug: slugForCwd(scratch) }),
			sessionId: generateSessionId(),
			topicId: generateTopicId(),
			projectId: generateProjectId(),
			tenantId: generateTenantId(),
			messages: [{ role: "user", content: "make the check pass", timestamp: 1 }],
			resumeHandler: autoApproveHandler,
		});
		// What the host does after a goal round that was handed back.
		const ending =
			authority && turn.handedBack
				? await confirmation.handBack("turn", turn.handedBack)
				: undefined;
		const goal = await goals.getGoal(session.id, tenantId);
		const first = provider.requests[0];
		const offered = (first?.tools ?? []).some((t) => t.function.name === HAND_BACK_TOOL_NAME);
		const system = JSON.stringify((first?.messages ?? []).filter((m) => m.role === "system"));
		return {
			...evalTurnFromTurn(turn),
			edits: counter.edits,
			offered,
			guided: system.includes("Handing a task back"),
			closing: turn.handedBack ? describeHandBack(turn.handedBack) : "none",
			modelLines: turn.handedBack ? handBackModelLines(turn.handedBack) : [],
			goalEnding: ending ? `${ending.ending}:${goal?.phase}` : "none",
		};
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

const handedScorer = customScorer("handed-back", (turn, evalCase) =>
	handedBackScorer(
		evalCase.expected.kind ? { expectKind: evalCase.expected.kind } : {},
	).score(turn, evalCase),
);

const verdictScorer = customScorer("verdict", (turn, evalCase) =>
	outcomeScorer([evalCase.expected.verdict]).score(turn, evalCase),
);

/** Scores one field of the case result against `expected[key]`. */
const fieldScorer = (name, key, read = (turn) => turn[key]) =>
	customScorer(name, (turn, evalCase) => {
		const got = read(/** @type {any} */ (turn));
		const want = evalCase.expected[key];
		const ok = JSON.stringify(got) === JSON.stringify(want);
		return {
			score: ok ? 1 : 0,
			reason: ok ? `${name}: ${JSON.stringify(got)}` : `${name}: ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`,
			details: { [name]: got },
		};
	});

const modelWordsLabelled = customScorer("model-words-labelled", (turn) => {
	const t = /** @type {any} */ (turn);
	const lines = t.modelLines;
	const ok =
		lines.length === 0 ||
		(lines.length === 3 &&
			lines[0].startsWith("The model says it is blocked by: ") &&
			lines[1].startsWith("It tried: ") &&
			lines[2].startsWith("It needs a person to: ") &&
			!t.closing.includes("the check asserts"));
	return { score: ok ? 1 : 0, reason: ok ? "the model's words are labelled and kept out of the kernel's line" : "the model's words are not kept apart", details: {} };
});

const CONFLICT = "The model handed the task back to a person: the request conflicts with itself or with its checks.";
const MISSING = "The model handed the task back to a person: something needed is missing or not allowed.";
const DECISION = "The model handed the task back to a person: a decision is needed that belongs to a person.";

export default async function handBackSuite() {
	return runExperiment({
		name: "kernel/hand-back",
		// What this run is, written into the report: a scripted provider, so no
		// vendor, route or reasoning effort is involved.
		disclosure: {
			mode: "scripted",
			roles: { agent: { provider: "MockLLMProvider", model: "scripted" } },
			routing: "off",
			reasoningEffort: "not applicable",
		},
		scorers: [
			handedScorer,
			verdictScorer,
			fieldScorer("steps", "steps", (turn) => turn.steps.length),
			fieldScorer("edits", "edits"),
			fieldScorer("closing", "closing"),
			fieldScorer("offered", "offered"),
			fieldScorer("guided", "guided"),
			fieldScorer("goal", "goalEnding", (turn) => turn.goalEnding),
			modelWordsLabelled,
			completionScorer(),
		],
		run: (input) => runCase(input),
		cases: [
			{
				name: "hands back at once, and the turn ends there although the script goes on",
				input: { handBack: true, script: [{ toolCalls: [handBack("conflict")] }, { toolCalls: [edit()] }, say("Done.")] },
				expected: { kind: "conflict", verdict: "unchanged", steps: 1, edits: 0, closing: CONFLICT, offered: true, guided: true, goalEnding: "none" },
			},
			{
				name: "changes a file and then hands back: the record keeps its verdict beside it",
				input: { handBack: true, script: [{ toolCalls: [edit()] }, { toolCalls: [handBack("missing")] }, say("Done.")] },
				expected: { kind: "missing", verdict: "unchecked", steps: 2, edits: 1, closing: MISSING, offered: true, guided: true, goalEnding: "none" },
			},
			{
				name: "a failing check and then a hand-back: the verdict stays failing, the hand-back sits beside it",
				input: { handBack: true, script: [{ toolCalls: [edit()] }, failingShell, { toolCalls: [handBack("conflict")] }, say("Done.")] },
				expected: { kind: "conflict", verdict: "failing", steps: 3, edits: 1, closing: CONFLICT, offered: true, guided: true, goalEnding: "none" },
			},
			{
				name: "a goal round handed back ends as not confirmed and blocked",
				input: { handBack: true, goal: true, script: [{ toolCalls: [handBack("decision")] }, say("Done.")] },
				expected: { kind: "decision", verdict: "unchanged", steps: 1, edits: 0, closing: DECISION, offered: true, guided: true, goalEnding: "not-confirmed:blocked" },
			},
			{
				name: "calls the tool in a step with other calls: none of the others run",
				input: { handBack: true, script: [{ toolCalls: [edit("e1"), handBack("conflict"), edit("e2")] }, { toolCalls: [edit("e3")] }, say("Done.")] },
				expected: { kind: "conflict", verdict: "unchanged", steps: 1, edits: 0, closing: CONFLICT, offered: true, guided: true, goalEnding: "none" },
			},
			{
				name: "does the task and does not hand it back, with the tool on offer",
				input: { handBack: true, script: [{ toolCalls: [edit()] }, shell, say("Done and checked.")] },
				expected: { verdict: "checked", steps: 3, edits: 1, closing: "none", offered: true, guided: true, goalEnding: "none" },
			},
			{
				name: "setting off: the tool and the guidance are not there",
				input: { handBack: false, script: [say("Done.")] },
				expected: { verdict: "unchanged", steps: 1, edits: 0, closing: "none", offered: false, guided: false, goalEnding: "none" },
			},
			{
				name: "setting off: a call to the absent tool hands nothing back",
				input: { handBack: false, script: [{ toolCalls: [handBack("conflict")] }, say("I could not do it.")] },
				expected: { verdict: "unknown", steps: 2, edits: 0, closing: "none", offered: false, guided: false, goalEnding: "none" },
			},
		],
	});
}
