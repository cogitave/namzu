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

import {
	MockLLMProvider,
	ToolRegistry,
	autoApproveHandler,
	createSlidingWindowReducer,
	customScorer,
	drainQuery,
	evalRunFromRun,
	runExperiment,
} from '@namzu/sdk'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

/** Long enough that a 2k window is comfortably exceeded. */
const BULK = 'the quick brown fox jumps over the lazy dog '.repeat(120)

function registry() {
	const tools = new ToolRegistry()
	tools.register({
		name: 'fetch_a_lot',
		description: 'Return a large block of text.',
		inputSchema: z.object({}),
		category: 'custom',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		execute: async () => ({ success: true, output: BULK }),
	})
	return tools
}

async function runCase(input) {
	const run = await drainQuery({
		provider: new MockLLMProvider({ turns: input.turns }),
		tools: registry(),
		runConfig: {
			model: 'mock-model',
			timeoutMs: 30_000,
			tokenBudget: 1_000_000,
			maxIterations: 6,
			maxResponseTokens: 256,
		},
		agentId: 'agent_ctx',
		agentName: 'Context Agent',
		workingDirectory: await mkdtemp(join(tmpdir(), 'namzu-eval-ctx-')),
		sessionId: 'ses_ctx',
		threadId: 'thd_ctx',
		projectId: 'prj_ctx',
		tenantId: 'tnt_ctx',
		messages: [{ role: 'user', content: 'go', timestamp: 1 }],
		resumeHandler: autoApproveHandler,
		...(input.compactionConfig ? { compactionConfig: input.compactionConfig } : {}),
		...(input.contextReducer ? { contextReducer: input.contextReducer } : {}),
	})

	const evalRun = evalRunFromRun(run)
	// The scorers below need the final history, which `EvalRun` does not
	// carry. Attached rather than widening the shared type for one suite.
	return Object.assign(evalRun, { finalMessages: run.messages ?? [] })
}

const call = (id) => ({ id, name: 'fetch_a_lot', rawArguments: '{}' })

/** A run must never end holding a tool result whose call is gone. */
const noOrphanedResults = customScorer('no-orphaned-tool-results', (run) => {
	const messages = run.finalMessages ?? []
	const callIds = new Set()
	for (const m of messages) {
		for (const tc of m.toolCalls ?? []) callIds.add(tc.id)
	}
	const orphans = messages
		.filter((m) => m.role === 'tool' && m.toolCallId && !callIds.has(m.toolCallId))
		.map((m) => m.toolCallId)

	return orphans.length === 0
		? { score: 1, reason: 'every tool result still has its call' }
		: {
				score: 0,
				reason: `orphaned tool results: ${orphans.join(', ')} — the provider rejects the next turn with a 400`,
				details: { orphans },
			}
})

/** The system prefix is the agent's identity; compaction must not eat it. */
const keepsTheSystemFloor = customScorer('keeps-system-floor', (run) => {
	const messages = run.finalMessages ?? []
	return messages[0]?.role === 'system'
		? { score: 1, reason: 'the leading system message survived' }
		: { score: 0, reason: `history now opens on ${messages[0]?.role ?? 'nothing'}` }
})

const settled = customScorer('settled', (run) =>
	run.error
		? { score: 0, reason: `run threw: ${run.error}` }
		: { score: 1, reason: `settled as ${run.stopReason ?? 'unknown'}` },
)

export default async function context() {
	return runExperiment({
		name: 'kernel/context',
		scorers: [noOrphanedResults, keepsTheSystemFloor, settled],
		run: (input) => runCase(input),
		cases: [
			{
				name: 'a run that outgrows its window still finishes',
				input: {
					turns: [
						{ toolCalls: [call('a')] },
						{ toolCalls: [call('b')] },
						{ toolCalls: [call('c')] },
						{ text: 'finished' },
					],
					compactionConfig: {
						strategy: 'structured',
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
				name: 'the cheap sliding window finishes too, and summarizes nothing',
				input: {
					turns: [
						{ toolCalls: [call('a')] },
						{ toolCalls: [call('b')] },
						{ toolCalls: [call('c')] },
						{ text: 'finished' },
					],
					compactionConfig: {
						strategy: 'sliding-window',
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
				name: 'a host reducer that declines leaves the run intact',
				input: {
					turns: [{ toolCalls: [call('a')] }, { text: 'finished' }],
					compactionConfig: {
						strategy: 'structured',
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
				name: 'a built-in reducer keeps the history usable',
				input: {
					turns: [
						{ toolCalls: [call('a')] },
						{ toolCalls: [call('b')] },
						{ text: 'finished' },
					],
					compactionConfig: {
						strategy: 'structured',
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
				name: 'no compaction configured is still a working run',
				input: {
					turns: [{ toolCalls: [call('a')] }, { text: 'finished' }],
				},
			},
		],
	})
}

export const tags = ['kernel', 'ci']
