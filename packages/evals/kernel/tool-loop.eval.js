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

import {
	MockLLMProvider,
	ToolRegistry,
	autoApproveHandler,
	completionScorer,
	drainQuery,
	evalRunFromRun,
	runExperiment,
	stepBudgetScorer,
	trajectoryScorer,
} from '@namzu/sdk'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

const TOOL_NAMES = ['read_file', 'write_file', 'search']

/**
 * @param {readonly string[]} failing
 * @returns {ToolRegistry}
 */
function registry(failing = []) {
	const tools = new ToolRegistry()
	for (const name of TOOL_NAMES) {
		tools.register({
			name,
			description: `${name}, for the eval suite`,
			inputSchema: z.object({ path: z.string().optional(), query: z.string().optional() }),
			// Declared, not defaulted. Without these the permission gate parks
			// for an approval no one is there to give, and the suite hangs
			// rather than failing — which is how a gate reports success by
			// never finishing.
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async () =>
				failing.includes(name)
					? { success: false, output: '', error: `${name} refused` }
					: { success: true, output: `${name} ok` },
		})
	}
	return tools
}

/** @param {{turns: unknown[], maxIterations?: number, prepareStep?: unknown, failing?: string[]}} input */
async function runCase(input) {
	const provider = new MockLLMProvider({ turns: input.turns })
	const run = await drainQuery({
		provider,
		tools: registry(input.failing),
		runConfig: {
			model: 'mock-model',
			timeoutMs: 30_000,
			tokenBudget: 1_000_000,
			maxIterations: input.maxIterations ?? 8,
			maxResponseTokens: 512,
		},
		agentId: 'agent_eval',
		agentName: 'Eval Agent',
		// A fresh directory per case. Pointed at the repo root, every run
		// wrote into the repo's own live `.namzu/` state — a suite that
		// mutates the tree it is measuring is not a measurement, and sharing
		// that directory with real sessions is how this suite first hung.
		workingDirectory: await mkdtemp(join(tmpdir(), 'namzu-eval-')),
		sessionId: 'ses_eval',
		threadId: 'thd_eval',
		projectId: 'prj_eval',
		tenantId: 'tnt_eval',
		messages: [{ role: 'user', content: 'go', timestamp: 1 }],
		// An eval can never wait on a human, by definition. Left to default,
		// a tool call parks for an approval nobody is there to give and the
		// whole suite hangs — which reads as a PASSING gate, because a
		// promise that never settles takes the process to exit zero.
		resumeHandler: autoApproveHandler,
		...(input.prepareStep ? { prepareStep: input.prepareStep } : {}),
	})

	return evalRunFromRun(run)
}

const call = (id, name) => ({ id, name, rawArguments: '{}' })

export default async function toolLoop() {
	return runExperiment({
		name: 'kernel/tool-loop',
		scorers: [trajectoryScorer(), completionScorer(), stepBudgetScorer(8)],
		run: (input) => runCase(input),
		cases: [
			{
				name: 'a turn with no tool calls settles on its text',
				input: { turns: [{ text: 'the answer' }] },
				expectedTools: [],
				expected: 'the answer',
			},
			{
				name: 'every tool call in one turn runs, in the order it was issued',
				input: {
					turns: [
						{ toolCalls: [call('a', 'read_file'), call('b', 'search'), call('c', 'write_file')] },
						{ text: 'done' },
					],
				},
				// Order is load-bearing: results are written back by index so
				// `tool_result` order matches `tool_use` order. A batch that
				// reordered them would keep working until a provider noticed.
				expectedTools: ['read_file', 'search', 'write_file'],
				expected: 'done',
			},
			{
				name: 'a failing tool goes back to the model instead of killing the run',
				input: {
					turns: [{ toolCalls: [call('a', 'read_file')] }, { text: 'recovered' }],
					failing: ['read_file'],
				},
				expectedTools: ['read_file'],
				expected: 'recovered',
			},
			{
				name: 'a forced tool choice applies to the step that asked and no further',
				input: {
					turns: [{ toolCalls: [call('a', 'read_file')] }, { text: 'after' }],
					prepareStep: () => ({ toolChoice: 'required' }),
				},
				// A forced choice that persisted would make the model call a
				// tool, read the result, and be forced again — an agent that
				// cannot stop. It stops here because the knob lives on the step.
				expectedTools: ['read_file'],
				expected: 'after',
			},
		],
	})
}

export const tags = ['kernel', 'ci']
