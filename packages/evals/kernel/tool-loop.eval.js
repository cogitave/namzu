/**
 * What the loop does with what the model says.
 *
 * These run against a SCRIPTED provider, so nothing here measures a model.
 * That is deliberate, and it is the only shape that belongs in a required CI
 * gate: the turns are fixed, so a score that moves means the kernel changed
 * its behaviour. A suite that calls a real provider measures two things at
 * once and cannot say which one moved — those belong behind a tag, run
 * deliberately, not on every push.
 *
 * Plain JavaScript rather than TypeScript because the runner imports a suite
 * with `import()` and the CI matrix spans Node versions that do not all strip
 * types. A build step for five files would be the more fragile answer.
 *
 * Every case pins an invariant this kernel has broken at least once.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MockLLMProvider,
	SessionPaths,
	toolset,
	autoApproveHandler,
	completionScorer,
	customScorer,
	drainQuery,
	evalTurnFromTurn,
	getBuiltinTools,
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
	runExperiment,
	slugForCwd,
	stepBudgetScorer,
	trajectoryScorer,
} from "@namzu/sdk";
import { z } from "zod";

const TOOL_NAMES = ["read_file", "write_file", "search"];

/**
 * @param {readonly string[]} failing
 * @returns {readonly import("@namzu/sdk").Toolset[]}
 */
function toolsets(failing = []) {
	return [
		toolset(
			"test",
			TOOL_NAMES.map((name) => ({
				name,
				description: `${name}, for the eval suite`,
				inputSchema: z.object({
					path: z.string().optional(),
					query: z.string().optional(),
				}),
				// Declared, not defaulted. Without these the permission gate parks
				// for an approval no one is there to give, and the suite hangs
				// rather than failing — which is how a gate reports success by
				// never finishing.
				category: "custom",
				permissions: [],
				readOnly: true,
				destructive: false,
				concurrencySafe: true,
				execute: async () =>
					failing.includes(name)
						? { success: false, output: "", error: `${name} refused` }
						: { success: true, output: `${name} ok` },
			})),
		),
	];
}

/**
 * The real `read` and `edit`, for a case that needs the tool's own input
 * handling rather than a stand-in. Only these two are offered: nothing else is
 * in the scripted turns.
 * @returns {readonly import("@namzu/sdk").Toolset[]}
 */
function fileToolsets() {
	return [
		toolset(
			"files",
			getBuiltinTools().filter((t) => t.name === "read" || t.name === "edit"),
		),
	];
}

/** @param {{turns: unknown[], maxIterations?: number, prepareStep?: unknown, failing?: string[], file?: {name: string, body: string}}} input */
async function runCase(input) {
	// One scratch directory per case, removed when the case ends. Every
	// case used to leave its directory, and the run state in it, behind.
	const scratch = await mkdtemp(join(tmpdir(), "namzu-eval-"));
	try {
		if (input.file) await writeFile(join(scratch, input.file.name), input.file.body);
		const provider = new MockLLMProvider({ turns: input.turns });
		const turn = await drainQuery({
			provider,
			toolsets: input.file ? fileToolsets() : toolsets(input.failing),
			turnConfig: {
				model: "mock-model",
				timeoutMs: 30_000,
				tokenBudget: 1_000_000,
				maxIterations: input.maxIterations ?? 8,
				maxResponseTokens: 512,
			},
			agentId: "agent_eval",
			agentName: "Eval Agent",
			// A fresh directory per case. Pointed at the repo root, every run
			// wrote into the repo's own live `.namzu/` state — a suite that
			// mutates the tree it is measuring is not a measurement, and sharing
			// that directory with real sessions is how this suite first hung.
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
			messages: [{ role: "user", content: "go", timestamp: 1 }],
			// An eval can never wait on a human, by definition. Left to default,
			// a tool call parks for an approval nobody is there to give and the
			// whole suite hangs — which reads as a PASSING gate, because a
			// promise that never settles takes the process to exit zero.
			resumeHandler: autoApproveHandler,
			...(input.prepareStep ? { prepareStep: input.prepareStep } : {}),
		});

		const evalTurn = evalTurnFromTurn(turn);
		// A case about a file is judged on the file, not on the closing text.
		if (input.file) {
			return {
				...evalTurn,
				output: await readFile(join(scratch, input.file.name), "utf8"),
			};
		}
		return evalTurn;
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

const call = (id, name) => ({ id, name, rawArguments: "{}" });
const callWith = (id, name, args) => ({
	id,
	name,
	rawArguments: JSON.stringify(args),
});

/** The file case's scorer: cases without `expectedFile` are not about a file. */
const fileScorer = customScorer("file-edited", (turn, evalCase) => {
	const want = /** @type {{expectedFile?: string}} */ (evalCase).expectedFile;
	if (want === undefined) return { score: 1, reason: "not a file case" };
	const ok = turn.output === want;
	return {
		score: ok ? 1 : 0,
		reason: ok ? "the file holds the edit" : "the file does not hold the edit",
	};
});

export default async function toolLoop() {
	return runExperiment({
		name: "kernel/tool-loop",
		scorers: [
			trajectoryScorer(),
			completionScorer(),
			stepBudgetScorer(8),
			fileScorer,
		],
		run: (input) => runCase(input),
		cases: [
			{
				name: "a turn with no tool calls settles on its text",
				input: { turns: [{ text: "the answer" }] },
				expectedTools: [],
				expected: "the answer",
			},
			{
				name: "every tool call in one turn runs, in the order it was issued",
				input: {
					turns: [
						{
							toolCalls: [
								call("a", "read_file"),
								call("b", "search"),
								call("c", "write_file"),
							],
						},
						{ text: "done" },
					],
				},
				// Order is load-bearing: results are written back by index so
				// `tool_result` order matches `tool_use` order. A batch that
				// reordered them would keep working until a provider noticed.
				expectedTools: ["read_file", "search", "write_file"],
				expected: "done",
			},
			{
				name: "a failing tool goes back to the model instead of killing the run",
				input: {
					turns: [
						{ toolCalls: [call("a", "read_file")] },
						{ text: "recovered" },
					],
					failing: ["read_file"],
				},
				expectedTools: ["read_file"],
				expected: "recovered",
			},
			{
				name: "a forced tool choice applies to the step that asked and no further",
				input: {
					turns: [{ toolCalls: [call("a", "read_file")] }, { text: "after" }],
					prepareStep: () => ({ toolChoice: "required" }),
				},
				// A forced choice that persisted would make the model call a
				// tool, read the result, and be forced again — an agent that
				// cannot stop. It stops here because the knob lives on the step.
				expectedTools: ["read_file"],
				expected: "after",
			},
			{
				name: "an edit call that sends an empty batch beside one edit is applied in one step",
				input: {
					file: { name: "levels.md", body: "# Levels\n\ndebug\ninfo\nwarn\n" },
					turns: [
						{ toolCalls: [callWith("a", "read", { path: "levels.md" })] },
						// What a small model sends when it fills every optional
						// field: an empty `edits` list beside the single edit it
						// means. That is the single edit, not a refusal that costs
						// the model a second call.
						{
							toolCalls: [
								callWith("b", "edit", {
									path: "levels.md",
									old_string: "info\nwarn",
									new_string: "info\nnotice\nwarn",
									edits: [],
								}),
							],
						},
						{ text: "done" },
					],
				},
				expectedTools: ["read", "edit"],
				expected: "done",
				expectedFile: "# Levels\n\ndebug\ninfo\nnotice\nwarn\n",
			},
		],
	});
}

export const tags = ["kernel", "ci"];
