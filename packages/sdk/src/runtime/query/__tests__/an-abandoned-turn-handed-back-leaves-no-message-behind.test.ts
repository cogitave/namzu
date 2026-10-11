import { describe, expect, it } from 'vitest'

import { MockLLMProvider } from '../../../provider/mock.js'
import { foldSessionMessages } from '../../../store/session-log/index.js'
import { ProviderError } from '../../../types/provider/errors.js'
import type { ChatCompletionParams, LLMProvider } from '../../../types/provider/index.js'
import { generateTurnId } from '../../../utils/id.js'
import { abandonTurn } from '../abandon-turn.js'
import { type QueryParams, drainQuery } from '../index.js'
import { memorySession } from './support/session.js'

/**
 * "Continue without this reply" gives the person's message back to a message
 * box. The abandoned turn's prompt used to stay in the context the next turn
 * carries, so sending the restored message put it in front of the provider
 * twice. A caller that hands the prompt back says so, and only then does the
 * turn stop contributing messages; the default keeps them, as it always did.
 */

const turnConfig = {
	model: 'mock-model',
	timeoutMs: 30_000,
	tokenBudget: 100_000,
	maxIterations: 4,
	maxResponseTokens: 256,
}

const PROMPT = 'please summarise the quarter'

/** Refuses the first request with a retryable 503, then answers. */
function unavailableOnce(answered = 0): LLMProvider & { requests: ChatCompletionParams[] } {
	const answers = new MockLLMProvider({
		turns: [
			...Array.from({ length: answered }, () => ({ text: 'earlier answer' })),
			{ text: 'done' },
		],
	})
	let refused = false
	let calls = 0
	return {
		id: 'mock',
		name: 'Mock',
		capabilities: answers.capabilities,
		requests: answers.requests,
		async *chatStream(params: ChatCompletionParams) {
			if (!refused && calls++ >= answered) {
				refused = true
				throw new ProviderError({
					code: 'server_error',
					message: 'the provider said 503',
					providerId: 'mock',
					status: 503,
				})
			}
			yield* answers.chatStream(params)
		},
	}
}

function copiesOf(params: ChatCompletionParams | undefined, text: string): number {
	return (params?.messages ?? []).filter(
		(message) => typeof message.content === 'string' && message.content.includes(text),
	).length
}

/** Stop a turn on a 503, close it, then send the restored prompt as a new turn. */
async function sendAgainAfterClosing(withdrawMessages: boolean) {
	const session = memorySession()
	const provider = unavailableOnce()
	const base = {
		provider,
		toolsets: [],
		...session,
		agentId: 'agent_continue_without',
		agentName: 'Continue without',
		workingDirectory: process.cwd(),
		retry: false,
		turnConfig,
	}
	const stoppedTurn = generateTurnId()
	const stopped = await drainQuery({
		...base,
		messages: [{ role: 'user', content: PROMPT }],
		turnId: stoppedTurn,
	} as unknown as QueryParams)
	expect(stopped.stopReason).toBe('paused')

	// What a host that caches the conversation holds when the person continues.
	const cache = await foldSessionMessages(
		(await session.sessionLog.readAll()).entries.map((e) => e.record),
	)
	expect(cache.map((message) => message.role)).toEqual(['user'])

	await abandonTurn(session.sessionId, stoppedTurn, 'the person continued without the reply', {
		log: session.sessionLog,
		...(withdrawMessages ? { withdrawMessages: true } : {}),
	})

	const next = await drainQuery({
		...base,
		messages: [...cache, { role: 'user', content: PROMPT }],
		turnId: generateTurnId(),
	} as unknown as QueryParams)
	expect(next.status).toBe('completed')
	const folded = await foldSessionMessages(
		(await session.sessionLog.readAll()).entries.map((e) => e.record),
	)
	return { sent: provider.requests.at(-1), folded, session }
}

describe('an abandoned turn whose prompt went back to the message box', () => {
	it('puts the person’s message in front of the provider once when it is sent again', async () => {
		const { sent, folded } = await sendAgainAfterClosing(true)
		expect(copiesOf(sent, PROMPT)).toBe(1)
		expect(sent?.messages.filter((message) => message.role === 'assistant')).toEqual([])
		// The context the next turn carries holds the re-sent prompt and its answer, nothing of the closed turn.
		expect(folded.map((message) => message.role)).toEqual(['user', 'assistant'])
	})

	it('keeps the abandoned turn in the log, withdrawn only from the context', async () => {
		const { session } = await sendAgainAfterClosing(true)
		const records = (await session.sessionLog.readAll()).entries.map((e) => e.record)
		expect(
			records.filter((record) => record.type === 'message' && record.role === 'user'),
		).toHaveLength(2)
		const failed = records.find((record) => record.type === 'turn_failed')
		expect(failed?.type === 'turn_failed' && failed.failure?.code).toBe('abandoned')
	})

	it('keeps the abandoned turn’s messages in the context when the caller did not hand them back', async () => {
		const { sent } = await sendAgainAfterClosing(false)
		expect(copiesOf(sent, PROMPT)).toBe(2)
	})
})

describe('a conversation with earlier turns', () => {
	it.each([
		['a cache that carries message ids', true],
		['a cache that carries none', false],
	])('sends the restored prompt once on %s', async (_label, withIds) => {
		const session = memorySession()
		const provider = unavailableOnce(1)
		const base = {
			provider,
			toolsets: [],
			...session,
			agentId: 'agent_continue_without',
			agentName: 'Continue without',
			workingDirectory: process.cwd(),
			retry: false,
			turnConfig,
		}
		const first = await drainQuery({
			...base,
			messages: [{ role: 'user', content: 'an earlier question' }],
			turnId: generateTurnId(),
		} as unknown as QueryParams)
		expect(first.status).toBe('completed')
		const records = async () => (await session.sessionLog.readAll()).entries.map((e) => e.record)
		const cacheBefore = await foldSessionMessages(await records())
		const stoppedTurn = generateTurnId()
		const stopped = await drainQuery({
			...base,
			messages: [...cacheBefore, { role: 'user', content: PROMPT }],
			turnId: stoppedTurn,
		} as unknown as QueryParams)
		expect(stopped.stopReason).toBe('paused')
		await abandonTurn(session.sessionId, stoppedTurn, 'the person continued', {
			log: session.sessionLog,
			withdrawMessages: true,
		})
		// The host's cache is what it held before the stopped turn.
		const cache = withIds
			? cacheBefore
			: cacheBefore.map(({ id: _id, ...rest }) => rest as (typeof cacheBefore)[number])
		const next = await drainQuery({
			...base,
			messages: [...cache, { role: 'user', content: PROMPT }],
			turnId: generateTurnId(),
		} as unknown as QueryParams)
		expect(next.status).toBe('completed')
		expect(copiesOf(provider.requests.at(-1), PROMPT)).toBe(1)
		expect(copiesOf(provider.requests.at(-1), 'an earlier question')).toBe(1)
	})
})
