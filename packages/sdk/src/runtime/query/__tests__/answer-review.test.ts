import { describe, expect, it, vi } from 'vitest'

import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import type { AnswerReview } from '../../../types/run/answer-review.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * The halt predicate is only consulted after tools have run, so there was
 * no seam at the point the model stops calling them: the run finalized
 * with whatever it had produced. Verify-then-fix — run the build, feed the
 * failure back, let it try again — meant starting a whole new run and
 * re-supplying the context the first one had already assembled.
 */

registerMock()

function scriptedRun(
	replies: readonly string[],
	reviewAnswer: (answer: string) => AnswerReview | Promise<AnswerReview>,
	maxAnswerReviews?: number,
) {
	let turn = 0
	const provider = new MockLLMProvider({
		turns: replies.map((text) => ({ text })),
	})
	// The mock cycles its scripted replies; the counter is what lets a test
	// assert how many turns the loop actually took.
	const original = provider.chatStream.bind(provider)
	provider.chatStream = ((params: never) => {
		turn++
		return original(params)
	}) as typeof provider.chatStream

	return {
		turns: () => turn,
		run: () =>
			drainQuery({
				provider,
				tools: new ToolRegistry(),
				agentId: 'a',
				agentName: 'A',
				messages: [{ role: 'user', content: 'go' }],
				workingDirectory: process.cwd(),
				runConfig: { model: 'mock', tokenBudget: 100_000, timeoutMs: 30_000, maxIterations: 10 },
				projectId: generateProjectId(),
				sessionId: generateSessionId(),
				topicId: generateTopicId(),
				tenantId: generateTenantId(),
				reviewAnswer: (answer: string) => reviewAnswer(answer),
				...(maxAnswerReviews !== undefined ? { maxAnswerReviews } : {}),
			}),
	}
}

describe('judging the answer a run is about to settle with', () => {
	it('accepts and settles without an extra turn', async () => {
		const review = vi.fn(() => ({ accept: true }) as AnswerReview)
		const scripted = scriptedRun(['the answer'], review)

		await scripted.run()

		expect(review).toHaveBeenCalledTimes(1)
		expect(scripted.turns()).toBe(1)
	})

	it('hands a rejected answer back and runs another turn', async () => {
		// The whole point: the model gets another go WITH the context it
		// already has, instead of the host starting a fresh run.
		let calls = 0
		const scripted = scriptedRun(['first', 'second'], () => {
			calls++
			return calls === 1 ? { accept: false, feedback: 'the build fails' } : { accept: true }
		})

		await scripted.run()
		expect(scripted.turns()).toBe(2)
	})

	it('sends the feedback as the next user turn', async () => {
		let seen: string | undefined
		let calls = 0
		const provider = new MockLLMProvider({ turns: [{ text: 'x' }] })
		const original = provider.chatStream.bind(provider)
		provider.chatStream = ((params: { messages: { role: string; content: string }[] }) => {
			const last = params.messages[params.messages.length - 1]
			if (calls > 0) seen = last?.content
			calls++
			return original(params as never)
		}) as typeof provider.chatStream

		const run = await drainQuery({
			provider,
			tools: new ToolRegistry(),
			agentId: 'a',
			agentName: 'A',
			messages: [{ role: 'user', content: 'go' }],
			workingDirectory: process.cwd(),
			runConfig: { model: 'mock', tokenBudget: 100_000, timeoutMs: 30_000, maxIterations: 4 },
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
			topicId: generateTopicId(),
			tenantId: generateTenantId(),
			reviewAnswer: () =>
				calls === 1 ? { accept: false, feedback: 'FIX: tests red' } : { accept: true },
		})

		// Prose, and in the slot the model reads — a code would have to be
		// explained to it anyway.
		expect(seen).toBe('FIX: tests red')
		expect(run.messages.find((message) => message.content === 'FIX: tests red')).toMatchObject({
			role: 'user',
			source: { type: 'runtime-context', kind: 'answer-review' },
		})
	})

	it('stops with a reason that names the reviewer, not a budget', async () => {
		// A reviewer that never accepts would otherwise burn the whole token
		// budget and end on `max_iterations`, sending the reader to look for
		// a loop instead of at the reviewer.
		const scripted = scriptedRun(['a'], () => ({ accept: false, feedback: 'no' }), 2)
		const run = await scripted.run()

		expect(run.stopReason).toBe('answer_rejected')
	})

	it('spends only the attempts it was given', async () => {
		const review = vi.fn(() => ({ accept: false, feedback: 'no' }) as AnswerReview)
		const scripted = scriptedRun(['a'], review, 2)
		await scripted.run()

		// Two rejections, then the third call is the one that exceeds the
		// limit and stops the run.
		expect(review).toHaveBeenCalledTimes(3)
	})

	it('accepts when the reviewer throws, and does not loop', async () => {
		// The opposite of what the safety gates do, deliberately. Those are
		// asked "is this dangerous", where failing closed costs one refused
		// operation. This is asked "is this good enough", where failing
		// closed means handing the answer back forever.
		const scripted = scriptedRun(['a'], () => {
			throw new Error('reviewer exploded')
		})

		const run = await scripted.run()
		expect(run.stopReason).not.toBe('answer_rejected')
		expect(scripted.turns()).toBe(1)
	})

	it('is not consulted at all when no reviewer was supplied', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })
		const run = await drainQuery({
			provider,
			tools: new ToolRegistry(),
			agentId: 'a',
			agentName: 'A',
			messages: [{ role: 'user', content: 'go' }],
			workingDirectory: process.cwd(),
			runConfig: { model: 'mock', tokenBudget: 100_000, timeoutMs: 30_000, maxIterations: 4 },
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
			topicId: generateTopicId(),
			tenantId: generateTenantId(),
		})

		// The default path must be byte-identical for every existing caller.
		expect(run.stopReason).not.toBe('answer_rejected')
	})
	it('hands the reviewer the answer the model actually produced', async () => {
		// What the feature is named for, and the one thing nothing here
		// asserted. Every other test in this file measures control flow — turn
		// counts, call counts, stop reasons — and passed identically whether
		// the mock was scripted or wired to a key `MockScript` does not read,
		// which is the state this file was in. Reverting `turns:` to
		// `responses:` fails only this test.
		const seen: string[] = []
		const scripted = scriptedRun(['the model said this'], (answer) => {
			seen.push(answer)
			return { accept: true }
		})

		await scripted.run()

		expect(seen).toEqual(['the model said this'])
	})
})
