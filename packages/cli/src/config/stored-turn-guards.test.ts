import {
	InMemorySessionLog,
	type SessionRecordDraft,
	generateMessageId,
	generateProjectId,
	generateSessionId,
	generateTurnId,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import { readStoredTurnGuards, resolveTurnGuards } from './turn-guards.js'

async function sessionWithTurn(config: Record<string, unknown>) {
	const log = new InMemorySessionLog({ sessionId: generateSessionId() })
	const lease = await log.claim({ holder: 'test', ttlMs: 60_000 })
	if (!lease) throw new Error('claim failed')
	await log.append(lease, {
		type: 'session_started',
		projectId: generateProjectId(),
		cwd: '/w',
		agent: { id: 'a', name: 'A' },
	} as SessionRecordDraft)
	const turnId = generateTurnId()
	await log.beginTurn(lease, {
		turnId,
		userMessageId: generateMessageId(),
		config: config as never,
	})
	return { log, turnId }
}

describe('readStoredTurnGuards', () => {
	it('restores the limits the turn was started with, from its turn_started record', async () => {
		const { log, turnId } = await sessionWithTurn({
			model: 'm',
			tokenBudget: 5000,
			maxIterations: 7,
			timeoutMs: 90_000,
		})
		expect(await readStoredTurnGuards(log, turnId)).toEqual({
			tokenBudget: 5000,
			maxIterations: 7,
			timeoutMs: 90_000,
		})
	})

	it('answers undefined for a turn the log does not hold', async () => {
		const { log } = await sessionWithTurn({
			model: 'm',
			tokenBudget: 1,
			maxIterations: 1,
			timeoutMs: 1,
		})
		expect(await readStoredTurnGuards(log, generateTurnId())).toBeUndefined()
	})

	it('refuses a turn record that lacks one of its original limits', async () => {
		const { log, turnId } = await sessionWithTurn({ model: 'm', tokenBudget: 1, timeoutMs: 1 })
		await expect(readStoredTurnGuards(log, turnId)).rejects.toThrow(
			'Turn record does not contain its original limits',
		)
	})
})

describe('resolveTurnGuards', () => {
	it('layers later limits over earlier ones, 0 meaning unlimited', () => {
		expect(resolveTurnGuards({ tokenBudget: 10, maxIterations: 2 }, { maxIterations: 0 })).toEqual({
			tokenBudget: 10,
			maxIterations: 0,
			timeoutMs: 0,
		})
	})

	it('refuses a deadline that overflows platform timers', () => {
		expect(() => resolveTurnGuards({ timeoutMs: 2_147_483_648 })).toThrow('Invalid timeoutMs')
	})
})
