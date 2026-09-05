import { describe, expect, it } from 'vitest'

import { CompactionConfigSchema } from '../../config/runtime.js'
import type { Message, ToolMessage } from '../../types/message/index.js'
import { naiveKeepStartByTokens, planCompaction } from '../plan.js'
import { scoreMessages } from '../salience/score.js'
import { planWorkingSet } from '../salience/working-set.js'
import { estimateMessageTokens, estimateMessagesTokens } from '../token-estimate.js'

const screenshot = (data: string): ToolMessage => ({
	role: 'tool',
	toolCallId: 'frame',
	content: [{ type: 'image', mediaType: 'image/png', data }],
})

const capture: Message = {
	role: 'assistant',
	content: null,
	toolCalls: [{ id: 'frame', type: 'function', function: { name: 'screenshot', arguments: '{}' } }],
}

describe('multimodal token estimates', () => {
	it('does not turn compression size into visual context size', () => {
		const compact = screenshot('a'.repeat(400))
		const expanded = screenshot('a'.repeat(4_000_000))
		expect(estimateMessageTokens(compact)).toBeGreaterThan(0)
		expect(estimateMessageTokens(expanded)).toBe(estimateMessageTokens(compact))
		expect(estimateMessageTokens(expanded)).toBeLessThan(2_000)
	})

	it('charges inline and stored user attachments the same as tool content', () => {
		const inline: Message = {
			role: 'user',
			content: '',
			attachments: [{ mediaType: 'image/png', data: 'a'.repeat(400_000) }],
		}
		const stored: Message = {
			role: 'user',
			content: '',
			attachments: [{ type: 'stored', kind: 'image', mediaType: 'image/png', ref: 'frame' }],
		}
		expect(estimateMessageTokens(inline)).toBe(estimateMessageTokens(screenshot('abcd')))
		expect(estimateMessageTokens(stored)).toBe(estimateMessageTokens(inline))
	})

	it('includes native documents without tokenizing their encoded bytes', () => {
		const inline: Message = {
			role: 'user',
			content: '',
			attachments: [{ type: 'document', mediaType: 'application/pdf', data: 'a'.repeat(400_000) }],
		}
		const stored: Message = {
			role: 'user',
			content: '',
			attachments: [{ type: 'stored', kind: 'document', mediaType: 'application/pdf', ref: 'doc' }],
		}
		expect(estimateMessageTokens(inline)).toBeGreaterThan(0)
		expect(estimateMessageTokens(inline)).toBeLessThan(100_000)
		expect(estimateMessageTokens(stored)).toBe(estimateMessageTokens(inline))
	})

	it('counts the omission notice instead of reserving room for rejected image pixels', () => {
		const omitted: ToolMessage = {
			role: 'tool',
			toolCallId: 'frame',
			content: [
				{
					type: 'image',
					mediaType: 'image/png',
					data: 'a'.repeat(400_000),
					modelOmission: { reason: 'provider-rejected' },
				},
			],
		}
		expect(estimateMessageTokens(omitted)).toBeGreaterThan(0)
		expect(estimateMessageTokens(omitted)).toBeLessThan(200)
	})

	it('accounts for text blocks and document names consistently across user and tool messages', () => {
		const document = {
			type: 'document' as const,
			mediaType: 'application/pdf',
			data: 'a'.repeat(400_000),
			name: 'annual-report.pdf',
		}
		const user: Message = { role: 'user', content: 'Find totals.', attachments: [document] }
		const tool: Message = {
			role: 'tool',
			toolCallId: 'read',
			content: [{ type: 'text', text: 'Find ' }, { type: 'text', text: 'totals.' }, document],
		}
		expect(estimateMessageTokens(tool)).toBe(estimateMessageTokens(user))
	})

	it('retains a visual tail that fits instead of treating its bytes as huge text', () => {
		const messages: Message[] = [
			{ role: 'user', content: 'x'.repeat(80_000) },
			capture,
			screenshot('a'.repeat(400_000)),
			{ role: 'user', content: 'Continue.' },
		]
		expect(naiveKeepStartByTokens(messages, 2_000)).toBe(1)
	})

	it('includes tool arguments when deciding whether the tail fits', () => {
		const messages: Message[] = [
			{ role: 'user', content: 'Start.' },
			{
				role: 'assistant',
				content: null,
				toolCalls: [
					{
						id: 'write',
						type: 'function',
						function: { name: 'write', arguments: JSON.stringify({ content: 'x'.repeat(8_000) }) },
					},
				],
			},
			{ role: 'tool', toolCallId: 'write', content: 'saved' },
		]
		expect(naiveKeepStartByTokens(messages, 1_000)).toBe(2)
	})

	it('does not declare relief from saving encoded image bytes', () => {
		const messages: Message[] = [capture, screenshot('a'.repeat(400_000))]
		const plan = planCompaction({
			messages,
			config: CompactionConfigSchema.parse({ keepRecentToolResults: 0 }),
			estimatedTokens: 12_000,
			contextWindowTokens: 10_000,
		})
		expect(plan.kind).toBe('cleared')
		if (plan.kind !== 'cleared') throw new Error('Expected clear plan')
		expect(plan.charsReclaimed).toBeGreaterThan(390_000)
		expect(plan.reclaimedTokens).toBeLessThan(2_000)
		expect(plan.reclaimedTokens).toBe(
			estimateMessagesTokens(messages) - estimateMessagesTokens(plan.messages),
		)
		expect(plan.reliefWasEnough).toBe(false)
	})

	it('uses the same image cost for salience selection and the remaining budget', () => {
		const messages: Message[] = [
			capture,
			screenshot('a'.repeat(400_000)),
			{ role: 'user', content: 'z'.repeat(24_000) },
		]
		const scored = scoreMessages(messages, { goal: '', keepRecentMessages: 1 })
		expect(scored[1]?.tokens).toBe(estimateMessageTokens(messages[1] as Message))
		const before = estimateMessagesTokens(messages)
		const plan = planWorkingSet(messages, scored, { estimatedTokens: before, targetTokens: 5_000 })
		expect(plan.clearedCount).toBe(1)
		expect(plan.reclaimedTokens).toBe(before - estimateMessagesTokens(plan.messages))
		expect(plan.reachedTarget).toBe(false)
	})

	it('does not mistake matching captions or repeated calls for duplicate visual evidence', () => {
		const messages: Message[] = [
			capture,
			{
				...screenshot('a'.repeat(40_000)),
				content: [
					{ type: 'text', text: 'Current screen after the requested action.' },
					{ type: 'image', mediaType: 'image/png', data: 'a'.repeat(40_000) },
				],
			},
			{ ...capture, toolCalls: capture.toolCalls?.map((call) => ({ ...call, id: 'frame2' })) },
			{
				...screenshot('b'.repeat(40_000)),
				toolCallId: 'frame2',
				content: [
					{ type: 'text', text: 'Current screen after the requested action.' },
					{ type: 'image', mediaType: 'image/png', data: 'b'.repeat(40_000) },
				],
			},
		]
		const scored = scoreMessages(messages, { goal: 'screen', keepRecentMessages: 0 })
		expect(scored[1]?.redundancy).toBe(0)
		expect(scored[1]?.relevance).toBeGreaterThan(0)
	})
})
