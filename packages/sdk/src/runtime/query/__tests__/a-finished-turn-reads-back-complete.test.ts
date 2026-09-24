import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { foldSessionMessages } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { Toolset } from '../../../toolsets/types.js'
import { autoApproveHandler } from '../../../types/hitl/index.js'
import type { SessionEvent, SessionRecord, Turn } from '../../../types/session/index.js'
import { type QueryParams, drainQuery } from '../index.js'
import { memorySession, records } from './support/session.js'

/**
 * What a finished turn leaves in its session log, read back the way a host
 * reads it: the settling record carries the answer, the stop reason and the
 * budget, and the fold of the log is the conversation with the answer last.
 * `Turn.budget` and `turn_completed.budget` are the same projection taken at
 * two moments, and a host reading either has to get one answer.
 */

const ANSWER = 'the release is ready'

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

function echoToolset(): Toolset {
	return testToolset(
		defineTool({
			name: 'echo',
			description: 'echoes the text back',
			inputSchema: z.object({ text: z.string() }),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async () => ({ success: true, output: 'hi' }),
		}),
	)
}

async function dirWith(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix))
	dirs.push(dir)
	return dir
}

async function runToCompletion(): Promise<{
	turn: Turn
	events: SessionEvent[]
	log: SessionRecord[]
}> {
	const session = memorySession()
	const events: SessionEvent[] = []

	const turn = await drainQuery(
		{
			provider: new MockLLMProvider({
				turns: [
					{
						toolCalls: [{ id: 'c1', name: 'echo', args: { text: 'a' } }],
						finishReason: 'tool_calls',
					},
					{ text: ANSWER, usage: { promptTokens: 12, completionTokens: 7, totalTokens: 19 } },
				],
			}),
			toolsets: [echoToolset()],
			...session,
			agentId: 'agent_readback',
			agentName: 'Readback agent',
			messages: [{ role: 'user', content: 'check the release' }],
			workingDirectory: await dirWith('namzu-readback-work-'),
			resumeHandler: autoApproveHandler,
			authorizationGate: {
				enabled: true,
				rules: [{ type: 'allow_by_name', toolNames: ['echo'] }],
				allowReadOnlyTools: false,
				denyDangerousPatterns: false,
				logDecisions: false,
			},
			turnConfig: {
				model: 'mock-model',
				timeoutMs: 30_000,
				tokenBudget: 100_000,
				maxIterations: 4,
				maxResponseTokens: 256,
			},
		} as unknown as QueryParams,
		(event) => {
			events.push(event)
		},
	)

	return { turn, events, log: await records(session.sessionLog) }
}

describe('a successful turn read back from its session log', () => {
	it('opens with session_started and turn_started under the id it was returned with', async () => {
		const { turn, log } = await runToCompletion()

		expect(log[0]?.type).toBe('session_started')
		const started = log.find((record) => record.type === 'turn_started')
		expect(started?.turnId).toBe(turn.id)
		expect(started?.sessionId).toBe(turn.sessionId)
	})

	it('settles with a turn_completed record that carries the answer and the stop reason', async () => {
		const { turn, log } = await runToCompletion()

		const completed = log.at(-1)
		expect(completed?.type).toBe('turn_completed')
		if (completed?.type !== 'turn_completed') return
		expect(completed.result).toBe(ANSWER)
		expect(completed.stopReason).toBe('end_turn')
		expect(completed.settlement.status).toBe('completed')
		expect(completed.settlement.resultSource).toBe('model')
		expect(turn.result).toBe(ANSWER)
		expect(turn.stopReason).toBe('end_turn')
	})

	it('folds to a conversation whose tool results answer their own calls', async () => {
		const { log } = await runToCompletion()

		const messages = await foldSessionMessages(log)
		// The rebuilt system prompt is carried by turn_started, not recorded as
		// messages.
		expect(messages.map((message) => message.role)).toEqual([
			'user',
			'assistant',
			'tool',
			'assistant',
		])
		expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: ANSWER })
	})
})

describe('the budget a finished turn reports', () => {
	it('is the same number on the event, the record and the turn it returned', async () => {
		const { turn, events, log } = await runToCompletion()

		const completed = events.find(
			(event): event is Extract<SessionEvent, { type: 'turn_completed' }> =>
				event.type === 'turn_completed',
		)
		expect(completed).toBeDefined()
		expect(completed?.budget).toEqual(turn.budget)
		expect(completed?.budget).toBeDefined()
		expect(completed?.budget?.limit).toBe(100_000)
		const record = log.at(-1)
		expect(record?.type === 'turn_completed' ? record.budget : undefined).toEqual(turn.budget)
	})
})
