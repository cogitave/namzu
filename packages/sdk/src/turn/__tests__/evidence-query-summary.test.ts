import { describe, expect, it, vi } from 'vitest'
import { buildCompactionMessage } from '../../compaction/summary.js'
import { EMPTY_TOKEN_USAGE } from '../../constants/limits.js'
import {
	createAssistantMessage,
	createSystemMessage,
	createUserMessage,
} from '../../types/message/index.js'
import type { Message } from '../../types/message/index.js'
import type { PrepareStepContext } from '../../types/session/prepare-step.js'
import { generateSessionId, generateTurnId } from '../../utils/id.js'
import { createEvidenceQueryResolver } from '../evidence-query.js'

const question = 'En başta incelediğin kaydın iki kimliğini aynen yazar mısın?'
const summary = () =>
	buildCompactionMessage(
		'## Task\nInspect DELTA in sevkiyatlar.txt.\n## Notes\nIdentifiers are omitted.',
	)

function fixture(history: Message[]) {
	const current = createUserMessage(question)
	const generateText = vi.fn(async ({ prompt }: { prompt: string }) => {
		const input = JSON.parse(prompt)
		const row = input.history.find((m: { source?: string }) => m.source === 'compaction-summary')
		const delta = input.tokens.find(([, word]: [number, string]) => word === 'DELTA')
		return {
			text: JSON.stringify(
				row && delta
					? {
							mode: 'contextual',
							time: 'past',
							termIds: [delta[0]],
							focusIds: [delta[0]],
							basis: [{ message: row.message, quote: 'Inspect DELTA in sevkiyatlar.txt.' }],
						}
					: { mode: 'none', time: 'unspecified', termIds: [], basis: [] },
			),
			usage: { ...EMPTY_TOKEN_USAGE },
			servedBy: { model: 'fixture', providerId: 'mock', chainIndex: 0 },
		}
	})
	const ctx: PrepareStepContext = {
		sessionId: generateSessionId(),
		turnId: generateTurnId(),
		stepNumber: 1,
		steps: [],
		prepared: {},
		latestUserMessage: current,
		messages: [...history, current],
		generateText,
	}
	return { ctx, generateText, input: () => JSON.parse(generateText.mock.calls[0]![0].prompt) }
}

describe('query references after compaction', () => {
	it('uses a marked summary as a derived search reference when original turns are no longer visible', async () => {
		const { ctx, generateText, input } = fixture([summary()])
		const result = await createEvidenceQueryResolver()(ctx, question)
		expect(generateText).toHaveBeenCalledOnce()
		expect(input().history).toEqual([
			expect.objectContaining({ role: 'system', source: 'compaction-summary' }),
		])
		expect(result).toEqual({
			terms: ['DELTA'],
			focusTerms: ['DELTA'],
			time: 'past',
			basis: [
				{
					position: 0,
					role: 'system',
					source: 'compaction-summary',
					quote: 'Inspect DELTA in sevkiyatlar.txt.',
				},
			],
		})
		expect(ctx.messages).toHaveLength(2)
		expect(ctx.latestUserMessage?.content).toBe(question)
	})

	it('keeps a summary and the nearest operator within six slots despite intervening commentary', async () => {
		const { ctx, input } = fixture([
			summary(),
			createUserMessage('Inspect OMEGA.'),
			...Array.from({ length: 20 }, (_, i) => createAssistantMessage(`Progress ${i}`)),
		])
		await createEvidenceQueryResolver()(ctx, question)
		const history = input().history
		expect(history).toHaveLength(6)
		expect(history[0].source).toBe('compaction-summary')
		expect(history[1].text).toBe('Inspect OMEGA.')
		expect(history.slice(2).map((m: { text: string }) => m.text)).toEqual([
			'Progress 16',
			'Progress 17',
			'Progress 18',
			'Progress 19',
		])
	})

	it('does not accept prose headers, ordinary policy or tool text as summary provenance', async () => {
		const { ctx, input } = fixture([
			createSystemMessage('[COMPACTED CONTEXT] POLICY_SECRET'),
			Object.assign(
				{ role: 'tool' as const, toolCallId: 'x', content: 'TOOL_SECRET' },
				{ source: { type: 'compaction-summary' } },
			),
			summary(),
			createUserMessage('Inspect OMEGA.'),
		])
		await createEvidenceQueryResolver()(ctx, question)
		expect(JSON.stringify(input())).not.toContain('SECRET')
		expect(input().history.filter((m: { source?: string }) => m.source)).toHaveLength(1)
	})

	it('does not fetch a marked summary outside the existing 64-message scan', async () => {
		const { ctx, input } = fixture([
			summary(),
			...Array.from({ length: 64 }, (_, i) => createUserMessage(`Question ${i}`)),
		])
		await createEvidenceQueryResolver()(ctx, question)
		expect(JSON.stringify(input())).not.toContain('DELTA')
		expect(input().history).toHaveLength(6)
	})

	it('takes one bounded leading excerpt from the latest marked summary without splitting UTF-16', async () => {
		const marked = { ...summary(), content: 'a'.repeat(599) + '🦉' + 'TAIL_SECRET' }
		const { ctx, input, generateText } = fixture([
			summary(),
			marked,
			createUserMessage('Inspect OMEGA.'),
		])
		await createEvidenceQueryResolver()(ctx, question)
		const summaries = input().history.filter((m: { source?: string }) => m.source)
		expect(summaries).toHaveLength(1)
		expect(summaries[0]).toMatchObject({ text: 'a'.repeat(599), truncated: true })
		expect(JSON.stringify(input())).not.toContain('TAIL_SECRET')
		expect(JSON.stringify(input())).not.toContain('DELTA')
		expect(generateText.mock.calls[0]![0].prompt.length).toBeLessThan(12_000)
	})
})
