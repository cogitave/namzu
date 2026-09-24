import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider } from '../../../provider/mock.js'
import { testToolset } from '../../../test-support/toolset.js'
import { ProviderError } from '../../../types/provider/errors.js'
import type { ChatCompletionParams, LLMProvider } from '../../../types/provider/index.js'
import type { SessionEvent } from '../../../types/session/index.js'
import { generateTurnId } from '../../../utils/id.js'
import { type QueryParams, drainQuery } from '../index.js'
import { type ResumeSessionParams, resumeSession } from '../resume-session.js'
import type { TurnStateScope } from '../turn-state.js'
import {
	heldCheckpointStore,
	memorySession,
	terminalRecords,
	turnCheckpoints,
} from './support/session.js'

/**
 * A retryable provider refusal pauses a turn on its newest checkpoint so a
 * host can resume it. The per-iteration checkpoint is written AFTER the
 * model answers, so a 429 on the turn's FIRST request found no checkpoint
 * to pause on and the turn settled FAILED — the user's message was taken,
 * nothing was done with it, and `/resume` and drain had nothing to
 * continue. The same fault one request later paused. Where in the turn a
 * rate limit lands is not a reason to lose the turn.
 */

const turnConfig = {
	model: 'mock-model',
	timeoutMs: 30_000,
	tokenBudget: 100_000,
	maxIterations: 4,
	maxResponseTokens: 256,
}

/** Refuses the first request with a classified 429, then answers. */
function limitedOnce(): LLMProvider & { requests: ChatCompletionParams[] } {
	const answers = new MockLLMProvider({ turns: [{ text: 'done' }] })
	let refused = false
	return {
		id: 'mock',
		name: 'Mock',
		capabilities: answers.capabilities,
		requests: answers.requests,
		async *chatStream(params: ChatCompletionParams) {
			if (!refused) {
				refused = true
				throw new ProviderError({
					code: 'rate_limit',
					message: 'the provider said 429',
					providerId: 'mock',
					status: 429,
				})
			}
			yield* answers.chatStream(params)
		},
	}
}

async function runUntilRefused() {
	const session = memorySession()
	const scope: TurnStateScope = {
		turnId: generateTurnId(),
		tenantId: session.tenantId,
		projectId: session.projectId,
		sessionId: session.sessionId,
		topicId: session.topicId,
	}
	const events: SessionEvent[] = []
	const provider = limitedOnce()
	const run = await drainQuery(
		{
			provider,
			toolsets: [],
			...session,
			agentId: 'agent_first_refusal',
			agentName: 'First refusal agent',
			messages: [{ role: 'user', content: 'go' }],
			workingDirectory: process.cwd(),
			turnId: scope.turnId,
			retry: false,
			turnConfig,
		} as unknown as QueryParams,
		(event) => {
			events.push(event)
		},
	)
	return { session, scope, events, run, provider }
}

describe('a retryable refusal on the turn’s first request', () => {
	it('parks the turn on a checkpoint instead of failing it', async () => {
		const { events, run, session, scope } = await runUntilRefused()

		expect(events.some((event) => event.type === 'turn_failed')).toBe(false)
		const paused = events.filter(
			(event): event is Extract<SessionEvent, { type: 'turn_paused' }> =>
				event.type === 'turn_paused',
		)
		expect(paused).toHaveLength(1)
		expect(run.stopReason).toBe('paused')
		expect(paused[0]?.failure?.retryable).toBe(true)

		// The checkpoint the event names exists, and it is the turn before
		// its first iteration: nothing the failed request did is counted.
		const checkpoints = await turnCheckpoints({ ...session, turnId: scope.turnId })
		expect(checkpoints.map((checkpoint) => checkpoint.checkpointId)).toEqual([
			paused[0]?.checkpointId,
		])
		expect(checkpoints[0]?.iteration).toBe(0)
		expect(checkpoints[0]?.guards.iteration).toBe(0)
		expect(await terminalRecords(session.sessionLog)).toHaveLength(0)
	})

	it('resumes to completion from that checkpoint', async () => {
		const { session, scope, provider } = await runUntilRefused()

		const resumed = await resumeSession({
			scope,
			sessionLog: session.sessionLog,
			checkpointStore: await heldCheckpointStore(session.sessionLog),
			sessionId: scope.sessionId,
			topicId: scope.topicId,
			projectId: scope.projectId,
			tenantId: scope.tenantId,
			provider,
			toolsets: [],
			agentId: 'agent_first_refusal',
			agentName: 'First refusal agent',
			workingDirectory: process.cwd(),
			retry: false,
			turnConfig,
		} as unknown as ResumeSessionParams)

		expect(resumed.resumed).toBe(true)
		if (!resumed.resumed) return
		expect(resumed.turn.id).toBe(scope.turnId)
		expect(resumed.turn.status).toBe('completed')
		expect(resumed.turn.result).toBe('done')
		// The resumed request carried the user's message the refusal left
		// unanswered.
		expect(JSON.stringify(provider.requests.at(-1)?.messages)).toContain('go')
		expect(await terminalRecords(session.sessionLog)).toHaveLength(1)
	})

	it('labels a resumed turn’s loop-start checkpoint with the iteration it resumed at', async () => {
		// Iteration 1 calls a tool and checkpoints; request 2 is refused and
		// the turn pauses. The resume's first request is refused too, before
		// the resumed loop has written a checkpoint of its own, so the pause
		// commits the resumed loop's start, which is iteration 1, not 0.
		const session = memorySession()
		const scope: TurnStateScope = {
			turnId: generateTurnId(),
			tenantId: session.tenantId,
			projectId: session.projectId,
			sessionId: session.sessionId,
			topicId: session.topicId,
		}
		const tools = testToolset({
			name: 'fetch_page',
			description: 'Fetch a page',
			inputSchema: z.object({ url: z.string() }),
			execute: async () => ({ success: true, output: 'ok' }),
		})
		const answers = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'fetch_page', args: { url: 'x' } }] }, { text: 'done' }],
		})
		let request = 0
		const provider: LLMProvider = {
			id: 'mock',
			name: 'Mock',
			capabilities: answers.capabilities,
			async *chatStream(params: ChatCompletionParams) {
				request += 1
				if (request === 2 || request === 3) {
					throw new ProviderError({
						code: 'rate_limit',
						message: 'the provider said 429',
						providerId: 'mock',
						status: 429,
					})
				}
				yield* answers.chatStream(params)
			},
		} as LLMProvider
		const common = {
			provider,
			toolsets: [tools],
			agentId: 'agent_first_refusal',
			agentName: 'First refusal agent',
			workingDirectory: process.cwd(),
			retry: false,
			permissionMode: 'auto',
			turnConfig,
		}
		const run = await drainQuery(
			{
				...common,
				...session,
				messages: [{ role: 'user', content: 'go' }],
				turnId: scope.turnId,
			} as unknown as QueryParams,
			() => {},
		)
		expect(run.stopReason).toBe('paused')
		const before = await turnCheckpoints({ ...session, turnId: scope.turnId })
		expect(before.map((checkpoint) => checkpoint.iteration)).toContain(1)

		const resumed = await resumeSession({
			...common,
			scope,
			sessionLog: session.sessionLog,
			checkpointStore: await heldCheckpointStore(session.sessionLog),
			sessionId: scope.sessionId,
			topicId: scope.topicId,
			projectId: scope.projectId,
			tenantId: scope.tenantId,
		} as unknown as ResumeSessionParams)
		expect(resumed.resumed).toBe(true)

		if (!resumed.resumed) return
		expect(resumed.turn.stopReason).toBe('paused')
		const known = new Set(before.map((checkpoint) => checkpoint.checkpointId))
		const added = (await turnCheckpoints({ ...session, turnId: scope.turnId })).filter(
			(checkpoint) => !known.has(checkpoint.checkpointId),
		)
		expect(added).toHaveLength(1)
		expect(added[0]?.guards.iteration).toBe(1)
		expect(added[0]?.iteration).toBe(1)
	})

	it('still fails a permanent refusal on the first request', async () => {
		const session = memorySession()
		const events: SessionEvent[] = []
		await drainQuery(
			{
				provider: {
					id: 'mock',
					name: 'Mock',
					// biome-ignore lint/correctness/useYield: it fails before producing anything
					async *chatStream() {
						throw new ProviderError({
							code: 'auth',
							message: 'the provider said 401',
							providerId: 'mock',
							status: 401,
						})
					},
				},
				toolsets: [],
				...session,
				agentId: 'agent_first_refusal',
				agentName: 'First refusal agent',
				messages: [{ role: 'user', content: 'go' }],
				workingDirectory: process.cwd(),
				retry: false,
				turnConfig,
			} as unknown as QueryParams,
			(event) => {
				events.push(event)
			},
		).catch(() => undefined)

		expect(events.some((event) => event.type === 'turn_paused')).toBe(false)
		expect(events.some((event) => event.type === 'turn_failed')).toBe(true)
		expect((await terminalRecords(session.sessionLog)).map((r) => r.type)).toEqual(['turn_failed'])
	})
})
