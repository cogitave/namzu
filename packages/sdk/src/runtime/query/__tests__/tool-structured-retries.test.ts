import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { MockLLMProvider } from '../../../provider/mock.js'
import { testToolset } from '../../../test-support/toolset.js'
import { createAssistantMessage, createUserMessage } from '../../../types/message/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import { generateTurnId } from '../../../utils/id.js'
import { drainQuery } from '../index.js'
import {
	TEST_SCOPE,
	heldCheckpointStore,
	memorySession,
	records,
	sessionWithCheckpoint,
	turnCheckpoints,
} from './support/session.js'

const invalid: MockTurn = {
	toolCalls: [{ name: 'structured_output', args: { score: 'bad' } }],
}
const valid: MockTurn = { toolCalls: [{ name: 'structured_output', args: { score: 3 } }] }

function fixture(turns: MockTurn[], maxRetries?: number) {
	const provider = new MockLLMProvider({ turns })
	const params = {
		...memorySession(),
		provider,
		toolsets: [],
		agentId: 'tool-retries',
		agentName: 'Tool retries',
		messages: [createUserMessage('Return a score')],
		workingDirectory: process.cwd(),
		turnId: generateTurnId(),
		turnConfig: {
			model: 'mock',
			tokenBudget: 100_000,
			timeoutMs: 10_000,
			maxIterations: 12,
		},
		structuredOutput: { schema: z.object({ score: z.number() }), maxRetries },
	}
	return { provider, params }
}

describe('tool structured-output correction allowance', () => {
	it.each([0, 1, 2])('bounds invalid schema responses at maxRetries %s', async (maxRetries) => {
		const { provider, params } = fixture([invalid], maxRetries)
		const run = await drainQuery(params)
		expect(run.stopReason).toBe('structured_output_failed')
		expect(run.structuredOutput).toBeUndefined()
		expect(provider.requests).toHaveLength(maxRetries + 1)
		const checkpoints = await turnCheckpoints(params)
		expect(checkpoints.at(-1)?.review).toMatchObject({
			toolStructuredAttempts: maxRetries + 1,
			structuredAttempts: 0,
			nativeStructuredAttempts: 0,
		})
	})

	it('retains the default of two correction opportunities', async () => {
		const { provider, params } = fixture([invalid], undefined)
		params.structuredOutput.maxRetries = undefined
		const run = await drainQuery(params)
		expect(run.stopReason).toBe('structured_output_failed')
		expect(provider.requests).toHaveLength(3)
	})

	it.each([
		{ label: 'invalid JSON', call: { name: 'structured_output', rawArguments: '{broken' } },
		{
			label: 'truncated arguments',
			call: { name: 'structured_output', args: { score: 3 }, truncateArguments: true },
		},
	])('charges $label without another request when maxRetries is zero', async ({ call }) => {
		const { provider, params } = fixture([{ toolCalls: [call] }], 0)
		const run = await drainQuery(params)
		expect(run.stopReason).toBe('structured_output_failed')
		expect(provider.requests).toHaveLength(1)
		expect((await turnCheckpoints(params)).at(-1)?.review.toolStructuredAttempts).toBe(1)
	})

	it.each([
		{ label: 'prose', turn: { text: 'Here is a score' } },
		{ label: 'empty response', turn: { text: '' } },
		{ label: 'partial prose', turn: { text: 'The score is', finishReason: 'length' as const } },
	])('shares one counter between $label and schema errors', async ({ turn }) => {
		const { provider, params } = fixture([turn, invalid, valid], 1)
		const run = await drainQuery(params)
		expect(run.stopReason).toBe('structured_output_failed')
		expect(provider.requests).toHaveLength(2)
		expect(run.structuredOutput).toBeUndefined()
		expect((await turnCheckpoints(params)).at(-1)?.review.toolStructuredAttempts).toBe(2)
	})

	it('accepts a valid correction and exposes both the error and feedback to that request', async () => {
		const { provider, params } = fixture([invalid, valid], 1)
		const run = await drainQuery(params)
		expect(run.stopReason).toBe('end_turn')
		expect(run.structuredOutput).toEqual({ score: 3 })
		expect(provider.requests).toHaveLength(2)
		expect(provider.requests[1]?.messages).toContainEqual(
			expect.objectContaining({ role: 'tool', isError: true }),
		)
		expect(provider.requests[1]?.messages).toContainEqual(
			expect.objectContaining({ source: { type: 'runtime-context', kind: 'structured-output' } }),
		)
	})

	it('charges one batch for several invalid output calls, after every sibling result', async () => {
		const work = vi.fn(async () => ({ success: true, output: 'work completed' }))
		const { provider, params } = fixture(
			[
				{
					toolCalls: [
						{ name: 'structured_output', args: { score: 'bad' } },
						{ name: 'work', args: {} },
						{ name: 'structured_output', args: { score: null } },
					],
				},
			],
			0,
		)
		const run = await drainQuery({
			...params,
			toolsets: [
				testToolset({
					name: 'work',
					description: 'Work',
					inputSchema: z.object({}),
					execute: work,
				}),
			],
		})
		expect(run.stopReason).toBe('structured_output_failed')
		expect(provider.requests).toHaveLength(1)
		expect(work).toHaveBeenCalledTimes(1)
		expect(run.messages.filter((message) => message.role === 'tool')).toHaveLength(3)
		const checkpoint = (await turnCheckpoints(params)).at(-1)
		expect(checkpoint?.review.toolStructuredAttempts).toBe(1)
		const through = (await records(params.sessionLog)).filter(
			(record) => record.seq <= (checkpoint?.throughSeq ?? 0),
		)
		expect(through.filter((record) => record.type === 'tool_completed')).toHaveLength(3)
	})

	it('does not ask again when the correction checkpoint cannot be committed', async () => {
		const { provider, params } = fixture([invalid, valid], 1)
		const store = await heldCheckpointStore(params.sessionLog)
		vi.spyOn(store, 'write').mockRejectedValue(new Error('checkpoint storage unavailable'))
		const run = await drainQuery({ ...params, checkpointStore: store })
		expect(run.stopReason).toBe('error')
		expect(run.lastError).toContain('checkpoint storage unavailable')
		expect(provider.requests).toHaveLength(1)
		expect(run.structuredOutput).toBeUndefined()
	})

	it('honours restored exhaustion before requesting or preparing a step', async () => {
		const { provider, params } = fixture([valid], 0)
		const beforeStep = vi.fn(() => undefined)
		const session = await sessionWithCheckpoint({
			messages: [createUserMessage('Return a score'), createAssistantMessage('invalid')],
			document: {
				review: {
					structuredAttempts: 0,
					answerAttempts: 0,
					nativeStructuredAttempts: 0,
					toolStructuredAttempts: 1,
				},
			},
			release: true,
		})
		const run = await drainQuery({
			...params,
			...TEST_SCOPE,
			sessionId: session.sessionId,
			sessionLog: session.log,
			checkpointStore: session.store,
			turnId: session.turnId,
			resumeFromCheckpoint: session.checkpointId,
			beforeStep,
		})
		expect(run.stopReason).toBe('structured_output_failed')
		expect(provider.requests).toHaveLength(0)
		expect(beforeStep).not.toHaveBeenCalled()
	})

	it('charges a recovered invalid pending call once without revalidating or requesting', async () => {
		const { provider, params } = fixture([valid], 0)
		const refinement = vi.fn(() => true)
		const session = await sessionWithCheckpoint({
			messages: [
				createUserMessage('Return a score'),
				{
					...createAssistantMessage(''),
					toolCalls: [
						{
							id: 'invalid-output',
							type: 'function',
							function: { name: 'structured_output', arguments: '{"score":"bad"}' },
						},
					],
				},
			],
		})
		await session.log.append(session.lease, {
			type: 'tool_executing',
			turnId: session.turnId,
			toolUseId: 'invalid-output',
			toolName: 'structured_output',
			input: { score: 'bad' },
		})
		await session.log.append(session.lease, {
			type: 'tool_completed',
			turnId: session.turnId,
			toolUseId: 'invalid-output',
			toolName: 'structured_output',
			result: 'Schema rejected the model arguments',
			isError: true,
			inputFailure: 'schema_validation',
		})
		await session.log.release(session.lease)
		const run = await drainQuery({
			...params,
			...TEST_SCOPE,
			sessionId: session.sessionId,
			sessionLog: session.log,
			checkpointStore: session.store,
			turnId: session.turnId,
			resumeFromCheckpoint: session.checkpointId,
			structuredOutput: {
				schema: z.object({ score: z.number() }).refine(refinement),
				maxRetries: 0,
			},
		})
		expect(run.stopReason).toBe('structured_output_failed')
		expect(provider.requests).toHaveLength(0)
		expect(refinement).not.toHaveBeenCalled()
		expect(run.messages.filter((message) => message.role === 'tool')).toHaveLength(1)
		const checkpoints = await session.store.list(session.scope)
		expect(checkpoints.at(-1)?.review.toolStructuredAttempts).toBe(1)
	})
})
