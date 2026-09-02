import { describe, expect, it } from 'vitest'

import { CompactionConfigSchema } from '../../config/runtime.js'
import type { AssistantMessage, Message, ToolMessage } from '../../types/message/index.js'
import { DEFAULT_SOFT_TARGET, planCompaction, planSalienceWorkingSet } from '../plan.js'

/**
 * `strategy: 'salience'` starts holding the context at the soft target,
 * half the window by default, and reports what it did in the same shape
 * the stale-result pass does — so the phase commits it the same way.
 */

const call = (id: string, path: string): AssistantMessage => ({
	role: 'assistant',
	content: null,
	toolCalls: [
		{ id, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path }) } },
	],
})
const result = (id: string, text: string): ToolMessage => ({
	role: 'tool',
	toolCallId: id,
	content: text,
})

describe('the salience strategy', () => {
	const config = CompactionConfigSchema.parse({ strategy: 'salience', keepRecentMessages: 2 })

	it('is a cleared plan with stub counts, aimed at the soft target', () => {
		const messages: Message[] = [
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'edit src/a.ts' },
		]
		for (let i = 0; i < 5; i += 1)
			messages.push(
				call(`c${i}`, `lib/${i}.ts`),
				result(`c${i}`, `lib/${i}.ts ${'y '.repeat(2_000)}`),
			)
		messages.push({ role: 'assistant', content: 'done reading.' })
		const estimatedTokens = 12_000
		const plan = planSalienceWorkingSet({
			messages,
			config,
			contextWindowTokens: 20_000,
			estimatedTokens,
		})
		expect(plan.kind).toBe('cleared')
		expect(plan.clearedCount).toBeGreaterThan(0)
		expect(plan.stubbedCount).toBe(0)
		expect(estimatedTokens - plan.reclaimedTokens).toBeLessThanOrEqual(20_000 * DEFAULT_SOFT_TARGET)
		expect(plan.reliefWasEnough).toBe(true)
		expect(config.softTarget).toBeUndefined()
	})

	it('leaves the structured plan untouched for every other strategy', () => {
		const structured = CompactionConfigSchema.parse({ strategy: 'structured' })
		const plan = planCompaction({
			messages: [
				{ role: 'system', content: 'sys' },
				{ role: 'user', content: 'hi' },
			],
			config: structured,
			contextWindowTokens: 1_000,
			estimatedTokens: 900,
		})
		expect(plan.kind).toBe('skip')
	})
})
