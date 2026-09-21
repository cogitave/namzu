import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { StructuredOutputConfig } from '../../../types/structured-output/index.js'
import {
	generateProjectId,
	generateTurnId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'
import {
	TEST_SCOPE,
	heldCheckpointStore,
	sessionWithCheckpoint,
	turnCheckpoints,
} from './support/session.js'

registerMock()
const schema = z.object({ score: z.number() })
function fixture(
	review: StructuredOutputConfig<typeof schema>['review'],
	maxReviews = 3,
	signal?: AbortSignal,
) {
	const provider = new MockLLMProvider({
		turns: [99, 2].map((score) => ({
			toolCalls: [{ name: 'structured_output', args: { score } }],
		})),
	})
	const request = vi.spyOn(provider, 'chatStream')
	const sessionId = generateSessionId()
	const params = {
		provider,
		tools: new ToolRegistry(),
		agentId: 'a',
		agentName: 'A',
		messages: [{ role: 'user' as const, content: 'Return a score below ten' }],
		workingDirectory: process.cwd(),
		turnConfig: {
			model: 'mock',
			tokenBudget: 100_000,
			timeoutMs: 30_000,
			maxIterations: 10,
		},
		projectId: generateProjectId(),
		sessionId,
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
		turnId: generateTurnId(),
		sessionLog: new InMemorySessionLog({ sessionId }),
		structuredOutput: { schema, review, maxReviews },
		signal,
	}
	return { params, request, run: () => drainQuery(params) }
}

describe('structured result host review', () => {
	it('corrects a schema-valid but semantically rejected result with retained feedback', async () => {
		const review = vi.fn((value: unknown) =>
			schema.parse(value).score < 10
				? { accept: true as const }
				: { accept: false as const, feedback: 'Score must be below ten' },
		)
		const f = fixture(review)
		const run = await f.run()
		expect(run.structuredOutput).toEqual({ score: 2 })
		expect(f.request).toHaveBeenCalledTimes(2)
		expect(review).toHaveBeenCalledTimes(2)
		expect(run.messages).toContainEqual(
			expect.objectContaining({
				content: 'Score must be below ten',
				source: { type: 'runtime-context', kind: 'answer-review' },
			}),
		)
	})
	it('does not publish rejected output when no corrections remain', async () => {
		const f = fixture(() => ({ accept: false, feedback: 'Rejected' }), 0)
		const run = await f.run()
		expect(run.stopReason).toBe('answer_rejected')
		expect(run.structuredOutput).toBeUndefined()
		expect(f.request).toHaveBeenCalledTimes(1)
	})
	it('fails closed when the reviewer throws', async () => {
		const f = fixture(() => {
			throw new Error('review unavailable')
		})
		const run = await f.run()
		expect(run.status).toBe('failed')
		expect(run.structuredOutput).toBeUndefined()
	})
	it('fails closed on a malformed rejection', async () => {
		const f = fixture(() => ({ accept: false, feedback: '' }))
		expect((await f.run()).status).toBe('failed')
	})
	it('cancels without waiting for an uncooperative reviewer', async () => {
		const controller = new AbortController()
		const f = fixture(
			() => {
				controller.abort()
				return new Promise(() => {})
			},
			3,
			controller.signal,
		)
		const run = await f.run()
		expect(run.status).toBe('cancelled')
		expect(run.structuredOutput).toBeUndefined()
	})
	it('preserves cancellation while saving an exhausted rejection', async () => {
		const controller = new AbortController()
		const f = fixture(() => ({ accept: false, feedback: 'Rejected' }), 0, controller.signal)
		const store = await heldCheckpointStore(f.params.sessionLog)
		const save = store.write.bind(store)
		vi.spyOn(store, 'write').mockImplementation(async (scope, checkpoint) => {
			const receipt = await save(scope, checkpoint)
			if (checkpoint.review.structuredAttempts === 1) controller.abort()
			return receipt
		})
		const run = await f.run()
		expect(run.status).toBe('cancelled')
		expect(run.stopReason).toBe('cancelled')
		expect(run.structuredOutput).toBeUndefined()
	})

	it.each([undefined, 0])(
		'requires intact receipts for large results (output limit %s)',
		async (maxToolOutputChars) => {
			const review = vi.fn(() => ({ accept: true as const }))
			const f = fixture(review)
			const text = 'a'.repeat(50_000)
			const run = await drainQuery({
				...f.params,
				provider: new MockLLMProvider({
					turns: [{ toolCalls: [{ name: 'structured_output', args: { text } }] }],
				}),
				structuredOutput: { schema: z.object({ text: z.string() }), review },
				maxToolOutputChars,
			})
			if (maxToolOutputChars === 0) {
				expect(run.structuredOutput).toEqual({ text })
				expect(review).toHaveBeenCalledTimes(1)
			} else {
				expect(run.status).toBe('failed')
				expect(run.structuredOutput).toBeUndefined()
				expect(review).not.toHaveBeenCalled()
			}
		},
	)

	it('isolates reviewer mutations from the validated published value', async () => {
		const f = fixture((output) => {
			if (typeof output === 'object' && output !== null) Object.assign(output, { score: -1 })
			return { accept: true }
		})
		expect((await f.run()).structuredOutput).toEqual({ score: 99 })
	})
	it('records exhaustion in the checkpoint, and a resume honours it', async () => {
		const f = fixture(() => ({ accept: false, feedback: 'Rejected' }), 0)
		await f.run()
		const checkpoints = await turnCheckpoints(f.params)
		expect(checkpoints.find((cp) => cp.review.structuredAttempts === 1)).toBeDefined()

		// A turn interrupted after that rejection continues without one more.
		const session = await sessionWithCheckpoint({
			messages: [createUserMessage('Return a score below ten'), createUserMessage('Rejected')],
			document: {
				review: { structuredAttempts: 1, answerAttempts: 0, nativeStructuredAttempts: 0 },
			},
			release: true,
		})
		f.request.mockClear()
		const run = await drainQuery({
			...f.params,
			...TEST_SCOPE,
			sessionId: session.sessionId,
			sessionLog: session.log,
			checkpointStore: session.store,
			turnId: session.turnId,
			tools: new ToolRegistry(),
			resumeFromCheckpoint: session.checkpointId,
		})
		expect(run.stopReason).toBe('answer_rejected')
		expect(run.structuredOutput).toBeUndefined()
		expect(f.request).not.toHaveBeenCalled()
	})
})
