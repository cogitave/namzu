import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { CompactionConfigSchema } from '../../../config/runtime.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { testToolset } from '../../../test-support/toolset.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { Toolset } from '../../../toolsets/types.js'
import type { HITLDecisionRequest, HITLResumeDecision } from '../../../types/hitl/index.js'
import { type Message, createRuntimeContextMessage } from '../../../types/message/index.js'
import type { MockScript, MockTurn } from '../../../types/provider/index.js'
import type { SessionEvent } from '../../../types/session/index.js'
import type { ToolPauseOutcome, ToolResult } from '../../../types/tool/index.js'
import { generateTurnId } from '../../../utils/id.js'
import { readParks, restoreCheckpointContext } from '../checkpoint.js'
import { drainQuery } from '../index.js'
import { resumeSession } from '../resume-session.js'
import {
	heldCheckpointStore,
	memorySession,
	records,
	rewriteSession,
	terminalRecords,
	turnCheckpoints,
} from './support/session.js'

const schema = z.object({ score: z.number() })
const invalid: MockTurn = {
	toolCalls: [{ id: 'invalid-output', name: 'structured_output', args: { score: 'bad' } }],
}
const valid: MockTurn = { toolCalls: [{ name: 'structured_output', args: { score: 3 } }] }

function fixture(turns: MockTurn[], maxRetries = 1, nextTurn?: MockScript['nextTurn']) {
	const provider = new MockLLMProvider({ turns, nextTurn })
	const params = {
		...memorySession(),
		provider,
		toolsets: [] as Toolset[],
		agentId: 'structured-retry-durability',
		agentName: 'Structured retry durability',
		messages: [{ role: 'user' as const, content: 'Do the work, then return a structured score.' }],
		workingDirectory: process.cwd(),
		turnId: generateTurnId(),
		turnConfig: {
			model: 'mock',
			tokenBudget: 100_000,
			timeoutMs: 10_000,
			maxIterations: 8,
		},
		structuredOutput: { schema, maxRetries },
	}
	return { params, provider }
}

/** Cut a real completed run at its durable request, as a process killed there would leave it. */
async function interruptedAtDecision(
	params: ReturnType<typeof fixture>['params'],
	matches: (request: HITLDecisionRequest) => boolean,
) {
	const log = await rewriteSession(params.sessionLog, [params], (draft) => draft, {
		through: (draft) => draft.type === 'decision_requested' && matches(draft.request),
	})
	const park = (await readParks(log)).find((candidate) => matches(candidate.pending.request))
	if (!park || park.pending.resolvedAt !== undefined) {
		throw new Error('The copied log contains no outstanding matching decision.')
	}
	return { log, park, store: await heldCheckpointStore(log) }
}

describe('tool structured retry durability through the real query', () => {
	it('keeps the combined correction count after real compaction removes its feedback history', async () => {
		const work = vi.fn(async () => ({ success: true, output: 'The ordinary work finished.' }))
		const pending: Message[] = []
		const turns: MockTurn[] = [
			{ text: `FIRST_PROSE_CORRECTION ${'background facts '.repeat(2_000)}` },
			{ toolCalls: [{ name: 'work', args: {} }] },
			{ toolCalls: [{ name: 'work', args: {} }] },
			invalid,
			valid,
		]
		const f = fixture(turns, 1, (_request, index) => {
			if (index === 1)
				pending.push(createRuntimeContextMessage('A worker reported progress.', 'task-completion'))
			return turns[index] ?? valid
		})
		Object.assign(f.provider, {
			resolveContextWindow: async (model: string) => (model === 'narrow' ? 6_000 : 200_000),
		})
		const events: SessionEvent[] = []
		const run = await drainQuery(
			{
				...f.params,
				inboundMessages: () => pending.splice(0),
				toolsets: [
					testToolset({
						name: 'work',
						description: 'Work',
						inputSchema: z.object({}),
						execute: work,
					}),
				],
				compactionConfig: CompactionConfigSchema.parse({
					strategy: 'structured',
					llmVerification: false,
					clearToolResults: false,
					keepRecentMessages: 2,
				}),
				prepareStep: ({ stepNumber }) => (stepNumber === 4 ? { model: 'narrow' } : undefined),
			},
			(event) => {
				events.push(event)
			},
		)

		expect(run.stopReason).toBe('structured_output_failed')
		expect(run.structuredOutput).toBeUndefined()
		expect(f.provider.requests).toHaveLength(4)
		expect(work).toHaveBeenCalledTimes(2)
		expect(events).toContainEqual(expect.objectContaining({ type: 'compaction_shed' }))
		expect(f.provider.requests[1]?.messages).toContainEqual(
			expect.objectContaining({ source: { type: 'runtime-context', kind: 'structured-output' } }),
		)
		expect(f.provider.requests[3]?.messages).not.toContainEqual(
			expect.objectContaining({ source: { type: 'runtime-context', kind: 'structured-output' } }),
		)
		expect(f.provider.requests[3]?.messages).not.toContainEqual(
			expect.objectContaining({ role: 'assistant', content: turns[0]?.text }),
		)
		expect((await turnCheckpoints(f.params)).at(-1)?.review.toolStructuredAttempts).toBe(2)
	})

	it('charges a newly executed invalid pending call once before requesting a model on resume', async () => {
		const sibling = vi.fn(async () => ({ success: true, output: 'ALREADY_FINISHED_SIBLING' }))
		const tools = testToolset(
			defineTool({
				name: 'work',
				description: 'Work',
				inputSchema: z.object({}),
				category: 'custom',
				permissions: [],
				readOnly: false,
				destructive: false,
				concurrencySafe: false,
				// Wait for this receipt before the output call starts, so the crash
				// prefix proves one answered sibling and one untouched call.
				executionBarrier: true,
				execute: sibling,
			}),
		)
		const f = fixture(
			[
				{
					toolCalls: [
						{ id: 'finished-sibling', name: 'work', args: {} },
						{ id: 'invalid-output', name: 'structured_output', args: { score: 'bad' } },
					],
				},
				valid,
			],
			0,
		)
		await drainQuery({
			...f.params,
			toolsets: [tools],
			reviewAllowedCalls: () => true,
			resumeHandler: async () => ({ action: 'approve_tools' }),
		})
		const log = await rewriteSession(f.params.sessionLog, [f.params], (draft) => draft, {
			through: (draft) => draft.type === 'tool_completed' && draft.toolUseId === 'finished-sibling',
		})
		const store = await heldCheckpointStore(log)
		expect((await store.list(f.params)).at(-1)?.review.toolStructuredAttempts).toBe(0)
		expect(
			(await records(log))
				.filter((record) => record.type === 'tool_executing')
				.map((record) => record.toolUseId),
		).toEqual(['finished-sibling'])
		const document = (await store.list(f.params)).at(-1)
		if (!document) throw new Error('The crashed batch had no checkpoint.')
		expect(
			(await restoreCheckpointContext(log, document)).messages.flatMap((message) =>
				message.role === 'assistant' ? (message.toolCalls ?? []) : [],
			),
		).toEqual([
			expect.objectContaining({ id: 'finished-sibling' }),
			expect.objectContaining({ id: 'invalid-output' }),
		])
		expect((await records(log)).filter((record) => record.type === 'tool_completed')).toHaveLength(
			1,
		)
		const provider = new MockLLMProvider({ turns: [valid] })
		const preprocess = vi.fn((value: unknown) => value)
		const outcome = await resumeSession({
			...f.params,
			scope: f.params,
			sessionLog: log,
			checkpointStore: store,
			provider,
			toolsets: [tools],
			structuredOutput: { schema: z.preprocess(preprocess, schema), maxRetries: 0 },
			pendingDecision: { action: 'approve_tools' },
			resumeHandler: async () => ({ action: 'continue' }),
		})

		expect(outcome.resumed).toBe(true)
		if (!outcome.resumed) throw new Error('The interrupted tool review did not resume.')
		expect(outcome.turn.stopReason).toBe('structured_output_failed')
		expect(outcome.turn.structuredOutput).toBeUndefined()
		expect(provider.requests).toHaveLength(0)
		expect(preprocess).toHaveBeenCalledOnce()
		const completed = (await records(log)).filter((record) => record.type === 'tool_completed')
		expect(completed).toHaveLength(2)
		expect(completed[1]).toMatchObject({
			toolUseId: 'invalid-output',
			isError: true,
			inputFailure: 'schema_validation',
		})
		expect(sibling).toHaveBeenCalledOnce()
		expect((await store.list(f.params)).at(-1)?.review.toolStructuredAttempts).toBe(1)
	})

	it('checkpoints the correction and every handoff sibling, then resumes without charging twice', async () => {
		const handoff = {
			kind: 'human-required',
			reason: 'Finish signing in, then continue.',
		} as const
		const signIn = vi.fn(
			async (): Promise<ToolResult> => ({
				success: false,
				output: 'The page needs a sign-in.',
				error: 'Sign-in required.',
				handoff,
			}),
		)
		const sibling = vi.fn(async () => ({ success: true, output: 'SIBLING_RECEIPT' }))
		const tools = testToolset(
			{ name: 'sign_in', description: 'Sign in', inputSchema: z.object({}), execute: signIn },
			{ name: 'note', description: 'Note', inputSchema: z.object({}), execute: sibling },
		)
		const f = fixture([
			{
				toolCalls: [
					{ id: 'invalid-output', name: 'structured_output', args: { score: 'bad' } },
					{ id: 'sign-in', name: 'sign_in', args: {} },
					{ id: 'sibling', name: 'note', args: {} },
				],
			},
		])
		const events: SessionEvent[] = []
		const run = await drainQuery({ ...f.params, toolsets: [tools] }, (event) => {
			events.push(event)
		})
		expect(run.stopReason).toBe('paused')
		expect(f.provider.requests).toHaveLength(1)
		expect(await terminalRecords(f.params.sessionLog)).toHaveLength(0)
		const paused = events.find((event) => event.type === 'turn_paused')
		if (paused?.type !== 'turn_paused')
			throw new Error('The handoff did not pause on a checkpoint.')
		const store = await heldCheckpointStore(f.params.sessionLog)
		const checkpoint = await store.read(f.params, paused.checkpointId)
		expect(checkpoint?.review.toolStructuredAttempts).toBe(1)
		const committed = (await records(f.params.sessionLog)).filter(
			(record) => record.seq <= (checkpoint?.throughSeq ?? 0),
		)
		expect(committed.filter((record) => record.type === 'tool_completed')).toHaveLength(3)
		expect(
			committed.filter((record) => record.type === 'message' && record.role === 'tool'),
		).toHaveLength(3)

		const provider = new MockLLMProvider({ turns: [valid] })
		const resumed = await resumeSession({
			...f.params,
			scope: f.params,
			checkpointStore: store,
			provider,
			toolsets: [tools],
			resumeHandler: async () => ({ action: 'continue' }),
		})
		expect(resumed.resumed).toBe(true)
		if (!resumed.resumed) throw new Error('The handoff checkpoint did not resume.')
		expect(resumed.turn.structuredOutput).toEqual({ score: 3 })
		expect(provider.requests).toHaveLength(1)
		expect(JSON.stringify(provider.requests[0]?.messages)).toContain('SIBLING_RECEIPT')
		expect(JSON.stringify(provider.requests[0]?.messages)).toContain('The page needs a sign-in.')
		expect(signIn).toHaveBeenCalledOnce()
		expect(sibling).toHaveBeenCalledOnce()
		expect((await store.list(f.params)).at(-1)?.review.toolStructuredAttempts).toBe(1)
	})

	it('retains the restored count when a resumed tool reparks before the iteration loop starts', async () => {
		const seen: ToolPauseOutcome[] = []
		const pauses = defineTool({
			name: 'two_pauses',
			description: 'Ask two successive questions during one tool call.',
			inputSchema: z.object({}),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: false,
			execute: async (_input, context) => {
				if (!context.requestPause) throw new Error('The query did not bind its pause capability.')
				for (const name of ['first', 'second']) {
					seen.push(
						await context.requestPause({
							name,
							prompt: `Answer ${name}.`,
							options: [{ id: 'yes', label: 'Yes' }],
						}),
					)
				}
				return { success: true, output: 'Both pause requests finished.' }
			},
		})
		const tools = testToolset(pauses)
		const f = fixture([
			{ text: 'A prose response needs its first correction.' },
			{ toolCalls: [{ id: 'questions', name: 'two_pauses', args: {} }] },
			valid,
		])
		await drainQuery({
			...f.params,
			toolsets: [tools],
			resumeHandler: async () => ({ action: 'continue' }),
		})
		const crashed = await interruptedAtDecision(
			f.params,
			(request) =>
				request.type === 'user_question' && request.question.questionId === 'questions:first',
		)
		expect(
			(await crashed.store.read(f.params, crashed.park.checkpointId))?.review
				.toolStructuredAttempts,
		).toBe(1)
		seen.length = 0
		const order: string[] = []
		const provider = new MockLLMProvider({ turns: [valid] })
		const resumed = await resumeSession({
			...f.params,
			scope: f.params,
			sessionLog: crashed.log,
			checkpointStore: crashed.store,
			toolsets: [tools],
			provider,
			pendingDecision: {
				action: 'answer_question',
				questionId: 'questions:first',
				selectedOptionIds: ['yes'],
			},
			beforeStep: () => {
				order.push('iteration-loop')
				return undefined
			},
			resumeHandler: async (request): Promise<HITLResumeDecision> => {
				if (request.type === 'user_question') order.push(request.question.questionId)
				return { action: 'continue' }
			},
		})

		expect(resumed.resumed).toBe(true)
		if (!resumed.resumed) throw new Error('The first question did not resume.')
		expect(resumed.turn.structuredOutput).toEqual({ score: 3 })
		expect(provider.requests).toHaveLength(1)
		expect(order).toEqual(['questions:second', 'iteration-loop'])
		expect(seen[0]).toEqual({ status: 'answered', selectedOptionIds: ['yes'] })
		const secondPark = (await readParks(crashed.log)).find(
			(candidate) =>
				candidate.pending.request.type === 'user_question' &&
				candidate.pending.request.question.questionId === 'questions:second',
		)
		if (!secondPark) throw new Error('The resumed tool did not write its second question park.')
		expect(
			(await crashed.store.read(f.params, secondPark.checkpointId))?.review.toolStructuredAttempts,
		).toBe(1)
	})
})
