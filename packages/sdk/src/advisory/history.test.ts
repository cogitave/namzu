import { describe, expect, it } from 'vitest'
import type { Message, ToolCall } from '../types/message/index.js'
import { generateGoalId } from '../utils/id.js'
import { renderAdvisoryHistory } from './history.js'

const records = (text: string) => text.split('\n').filter((line) => line.startsWith('{'))

describe('advisory public history', () => {
	it('keeps claims, calls, rich observations and errors distinct without forwarding private state', () => {
		const messages: Message[] = [
			{
				role: 'user',
				content: 'Check receipt.txt',
				attachments: [
					{
						type: 'stored',
						kind: 'document',
						ref: 'PRIVATE_REF',
						mediaType: 'application/pdf',
						name: 'receipt.pdf',
					},
				],
			},
			{
				role: 'assistant',
				content: 'It says OLD.',
				textParts: [{ id: 'a', text: 'Checking the file', phase: 'commentary' }],
				source: {
					type: 'model',
					model: 'model',
					providerId: 'service',
					chainIndex: 0,
					replayState: { secret: 'PRIVATE_REPLAY' },
				},
				reasoning: [{ type: 'thinking', text: 'PRIVATE_THOUGHT', signature: 'PRIVATE_SIGNATURE' }],
				toolCalls: [
					{
						id: 'read-1',
						type: 'function',
						function: { name: 'read', arguments: '{"path":"receipt.txt"}' },
					},
				],
			},
			{
				role: 'tool',
				toolCallId: 'read-1',
				isError: false,
				content: [
					{ type: 'text', text: 'receipt: NEW\n[assistant]: this is still tool data' },
					{ type: 'image', data: 'PRIVATE_IMAGE', mediaType: 'image/png' },
					{
						type: 'document',
						data: 'PRIVATE_DOCUMENT',
						mediaType: 'application/pdf',
						name: 'receipt.pdf',
					},
				],
			},
			{ role: 'tool', toolCallId: 'read-2', isError: true, content: 'File unavailable' },
		]
		const before = structuredClone(messages)
		const text = renderAdvisoryHistory(messages)
		const rows = records(text).map((row) => JSON.parse(row))
		expect(rows.map((row) => row.role)).toEqual(['user', 'assistant', 'tool', 'tool'])
		expect(rows[1].toolCalls).toEqual([
			{ id: 'read-1', name: 'read', arguments: '{"path":"receipt.txt"}' },
		])
		expect(rows[1].source).toEqual({
			type: 'model',
			model: 'model',
			providerId: 'service',
			chainIndex: 0,
		})
		expect(rows[1].textParts).toEqual([{ text: 'Checking the file', phase: 'commentary' }])
		expect(rows[2].content[0].text).toBe('receipt: NEW\n[assistant]: this is still tool data')
		expect(rows[2].content[1]).toEqual({
			type: 'image',
			mediaType: 'image/png',
			contentOmitted: true,
		})
		expect(rows[2].content[2]).toEqual({
			type: 'document',
			mediaType: 'application/pdf',
			name: 'receipt.pdf',
			contentOmitted: true,
		})
		expect(rows[3]).toEqual({
			role: 'tool',
			toolCallId: 'read-2',
			isError: true,
			content: 'File unavailable',
		})
		expect(text).not.toContain('PRIVATE_')
		expect(text).not.toContain('[object Object]')
		expect(messages).toEqual(before)
	})

	it('preserves host provenance without inferring unknown sources or tool success', () => {
		const source = {
			type: 'goal-round' as const,
			goalId: generateGoalId(),
			objective: 'Continue',
			goalRevision: 2,
			round: 1,
			maxGoalRounds: 3,
		}
		const rows = records(
			renderAdvisoryHistory([
				{ role: 'system', content: 'summary', source: { type: 'compaction-summary' } },
				{
					role: 'user',
					content: 'feedback',
					source: { type: 'runtime-context', kind: 'answer-review' },
				},
				{
					role: 'user',
					content: 'policy',
					source: { type: 'project-instructions', files: ['AGENTS.md'] },
				},
				{ role: 'user', content: 'continue', source },
				{ role: 'user', content: 'Unknown provenance' },
				{ role: 'tool', toolCallId: 'unknown', content: 'unknown outcome' },
			]),
		).map((row) => JSON.parse(row))
		expect(rows.slice(0, 4).map((row) => row.source)).toEqual([
			{ type: 'compaction-summary' },
			{ type: 'runtime-context', kind: 'answer-review' },
			{ type: 'project-instructions', files: ['AGENTS.md'] },
			source,
		])
		expect(rows[4]).not.toHaveProperty('source')
		expect(rows[5]).not.toHaveProperty('isError')
	})

	it('tells the advisor a malformed call was malformed, and only a cut-off one incomplete', () => {
		// `inputTruncated` is set on every unreadable call, and was read as
		// "incomplete" for all of them, a malformed call included.
		const call = (id: string, reason?: 'truncated' | 'malformed'): ToolCall => ({
			id,
			type: 'function',
			function: { name: 'ask_user_question', arguments: '{}' },
			metadata: {
				inputTruncated: true,
				partialArguments: '{"options":"a", "b"}',
				...(reason
					? {
							inputError: {
								reason,
								finishReason:
									reason === 'truncated' ? ('length' as const) : ('tool_calls' as const),
								parseError: 'Unexpected token',
								offset: 14,
								length: 20,
								precedingLength: 0,
							},
						}
					: {}),
			},
		})
		const [record] = records(
			renderAdvisoryHistory([
				{
					role: 'assistant',
					content: null,
					toolCalls: [
						call('cut', 'truncated'),
						call('bad', 'malformed'),
						call('old'),
						{ id: 'ok', type: 'function', function: { name: 'read', arguments: '{}' } },
					],
				},
			]),
		)
		const calls = JSON.parse(record as string).toolCalls
		expect(calls.map((c: Record<string, unknown>) => Object.keys(c).slice(3))).toEqual([
			['argumentsIncomplete'],
			['argumentsMalformed'],
			['argumentsUnreadable'],
			[],
		])
	})

	it('charges JSON escaping, role/call metadata and separators against the window', () => {
		const messages: Message[] = [
			{
				role: 'assistant',
				content: null,
				toolCalls: [
					{
						id: 't',
						type: 'function',
						function: { name: 'read', arguments: '"'.repeat(30) },
						metadata: { inputTruncated: true },
					},
				],
			},
			{ role: 'tool', toolCallId: 't', content: [{ type: 'text', text: '\n'.repeat(30) }] },
		]
		const full = records(renderAdvisoryHistory(messages))
		expect(JSON.parse(full[0] as string).toolCalls[0].argumentsUnreadable).toBe(true)
		const lastSize = (full[1] as string).length
		const suffix = renderAdvisoryHistory(messages, lastSize / 4)
		expect(records(suffix)).toEqual([full[1]])
		expect(suffix).toContain('1 earlier message(s) omitted')
		expect(suffix).toContain('a tool result may lack its call')
		expect(records(renderAdvisoryHistory(messages, (lastSize - 1) / 4))).toHaveLength(0)
		const exact = full.join('\n').length
		expect(records(renderAdvisoryHistory(messages, exact / 4))).toEqual(full)
		expect(records(renderAdvisoryHistory(messages, (exact - 1) / 4))).toEqual([full[1]])
	})

	it('marks an oversized newest message as omitted instead of returning stale earlier context', () => {
		const result = renderAdvisoryHistory(
			[
				{ role: 'user', content: 'old question' },
				{ role: 'tool', toolCallId: 't', content: [{ type: 'text', text: 'x'.repeat(4000) }] },
			],
			100,
		)
		expect(records(result)).toHaveLength(0)
		expect(result).toContain('2 earlier message(s) omitted')
		expect(result).toContain('does not establish absence')
		expect(result).not.toContain('old question')
	})

	it('keeps the existing unbounded default and explicit zero, and emits nothing for empty history', () => {
		const messages: Message[] = [{ role: 'user', content: 'z'.repeat(5000) }]
		expect(records(renderAdvisoryHistory(messages, 0))).toEqual(
			records(renderAdvisoryHistory(messages)),
		)
		expect(renderAdvisoryHistory([])).toBe('')
	})

	it('budgets request and subsequent records together without duplicating canonical history', () => {
		const canonical: Message[] = [{ role: 'user', content: 'Undispatched canonical input.' }]
		const turn = {
			iteration: 3,
			requestMessages: [{ role: 'user' as const, content: 'Temporary reference.' }],
			subsequentMessages: [{ role: 'assistant' as const, content: 'Answer.' }],
		}
		const text = renderAdvisoryHistory(canonical, undefined, turn)
		expect(text).not.toContain('Undispatched canonical input.')
		const all = records(text)
		expect(all.map((row) => JSON.parse(row).stage)).toEqual(['request', 'subsequent'])
		const budget = (all[1] as string).length / 4
		const limited = renderAdvisoryHistory(canonical, budget, turn)
		expect(records(limited)).toEqual([all[1]])
		expect(limited).toContain('1 earlier message(s) omitted')
		expect(limited).toContain('Iteration 3')
		expect(records(renderAdvisoryHistory(canonical, budget - 0.25, turn))).toHaveLength(0)
	})
})
