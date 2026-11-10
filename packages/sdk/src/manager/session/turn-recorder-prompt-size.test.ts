import { describe, expect, it } from 'vitest'

import { generateSessionId, generateTurnId } from '../../utils/id.js'
import { TurnRecorder } from './turn-recorder.js'

function recorder(): TurnRecorder {
	const sessionId = generateSessionId()
	return new TurnRecorder({
		sessionId,
		sessionLog: { sessionId },
		turnId: generateTurnId(),
		agentId: 'prompt-size',
		agentName: 'Prompt size',
		turnConfig: { model: 'mock-model', tokenBudget: 1_000_000, timeoutMs: 5_000 },
		providerId: 'mock',
		log: {
			info() {},
			warn() {},
			error() {},
			debug() {},
			child() {
				return this
			},
		} as never,
	} as never)
}

const base = {
	promptTokens: 4,
	completionTokens: 10,
	totalTokens: 14,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

describe('recordTurnUsage prompt size', () => {
	it('remembers the whole prompt when the driver keeps cache tokens apart', () => {
		const r = recorder()
		r.recordTurnUsage(
			{ ...base, cachedTokens: 26378, cacheWriteTokens: 163, fullPromptTokens: 26545 },
			{ providerId: 'mock', model: 'm' },
		)
		expect(r.lastPromptTokens).toBe(26545)
	})

	it('keeps promptTokens for a driver that includes cache in it', () => {
		const r = recorder()
		r.recordTurnUsage(
			{ ...base, promptTokens: 900, cachedTokens: 800 },
			{ providerId: 'mock', model: 'm' },
		)
		expect(r.lastPromptTokens).toBe(900)
	})
})
