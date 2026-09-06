import { describe, expect, it } from 'vitest'

import { CompactionConfigSchema } from '../../config/runtime.js'
import { MockLLMProvider } from '../../provider/mock.js'
import {
	type Message,
	createAssistantMessage,
	createToolMessage,
	createUserMessage,
} from '../../types/message/index.js'
import { WorkingStateManager } from '../manager.js'
import { compactNow } from '../manual.js'
import { buildVerifiedSummary } from '../verifier.js'

const EXCERPT_MARKER = '## Conversation Excerpt\n\n'
const config = CompactionConfigSchema.parse({
	keepRecentMessages: 2,
	llmVerification: true,
	richStateThreshold: 1_000,
	convoTextBudget: 4_000,
})

function excerpt(provider: MockLLMProvider): string {
	expect(provider.requests).toHaveLength(1)
	const prompt = provider.requests[0]?.messages.at(-1)?.content
	expect(typeof prompt).toBe('string')
	const start = String(prompt).indexOf(EXCERPT_MARKER)
	expect(start).toBeGreaterThanOrEqual(0)
	return String(prompt).slice(start + EXCERPT_MARKER.length)
}

describe('the compaction verifier receives readable, bounded evidence', () => {
	it('preserves rich result text and its call identity through host compaction', async () => {
		const call = createAssistantMessage(null, [
			{
				id: 'saved-receipt',
				type: 'function',
				function: { name: 'record_payment', arguments: '{"reference":"order-17"}' },
			},
		])
		call.reasoning = [{ type: 'redacted_thinking', encrypted: 'opaque-private-state' }]
		const messages: Message[] = [
			createUserMessage('Record the payment once and inspect the returned evidence.'),
			call,
			createToolMessage(
				[
					{ type: 'text', text: 'Payment recorded. Receipt: receipt-829. Do not charge again.' },
					{ type: 'image', mediaType: 'image/png', data: 'inline-image-bytes' },
					{
						type: 'document',
						mediaType: 'application/pdf',
						name: 'receipt.pdf',
						data: 'inline-document-bytes',
					},
				],
				'saved-receipt',
			),
			createAssistantMessage('The payment evidence has been received.'),
			createUserMessage('Continue with reconciliation.'),
			createAssistantMessage('Checking the ledger.'),
		]
		const original = structuredClone(messages)
		const provider = new MockLLMProvider({ turns: [{ text: 'COMPLETE' }] })

		const result = await compactNow({ messages, config, provider })

		expect(result?.shed).toBeGreaterThan(0)
		const text = excerpt(provider)
		expect(text).toContain('Payment recorded. Receipt: receipt-829. Do not charge again.')
		expect(text).toContain('record_payment')
		expect(text).toContain('order-17')
		expect(text.match(/saved-receipt/g)).toHaveLength(2)
		expect(text.indexOf('Record the payment once')).toBeLessThan(text.indexOf('record_payment'))
		expect(text.indexOf('record_payment')).toBeLessThan(text.indexOf('Payment recorded.'))
		expect(text).toContain('image/png')
		expect(text).toContain('receipt.pdf')
		expect(text).not.toContain('[object Object]')
		expect(text).not.toContain('inline-image-bytes')
		expect(text).not.toContain('inline-document-bytes')
		expect(JSON.stringify(provider.requests)).not.toContain('opaque-private-state')
		expect(messages).toEqual(original)
	})

	it('retains the reported tool failure alongside its result text', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'COMPLETE' }] })
		await buildVerifiedSummary(
			new WorkingStateManager(config),
			[
				createToolMessage(
					'Connection dropped after submission; outcome unknown.',
					'transfer',
					true,
				),
			],
			provider,
			config,
		)
		const text = excerpt(provider)
		expect(text).toContain('transfer')
		expect(text).toContain('isError=true')
		expect(text).toContain('outcome unknown')
	})

	it('names image and stored-document attachments even when user text is empty', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'COMPLETE' }] })
		await buildVerifiedSummary(
			new WorkingStateManager(config),
			[
				createUserMessage('', [
					{ mediaType: 'image/png', data: 'private-image-bytes' },
					{
						type: 'stored',
						kind: 'document',
						mediaType: 'application/pdf',
						name: 'contract.pdf',
						ref: 'private-store-key',
					},
				]),
			],
			provider,
			config,
		)
		const text = excerpt(provider)
		expect(text).toContain('image/png')
		expect(text).toContain('contract.pdf')
		expect(text).toContain('not included in this text excerpt')
		expect(text).not.toContain('private-image-bytes')
		expect(text).not.toContain('private-store-key')
	})

	it.each(['plain', 'blocks'] as const)(
		'counts rendered %s text, separators and the omission marker within the excerpt budget',
		async (kind) => {
			const provider = new MockLLMProvider({ turns: [{ text: 'COMPLETE' }] })
			const budget = 160
			const text = 'Receipt data: '.repeat(300)
			await buildVerifiedSummary(
				new WorkingStateManager(config),
				[
					createUserMessage('Inspect.'),
					createToolMessage(kind === 'plain' ? text : [{ type: 'text', text }], 'inspect'),
					createUserMessage('This later message does not fit.'),
				],
				provider,
				{ ...config, convoTextBudget: budget },
			)
			const rendered = excerpt(provider)
			expect(rendered.length).toBeLessThanOrEqual(budget)
			expect(rendered).toContain('Receipt data:')
			expect(rendered).not.toContain('[object Object]')
			expect(rendered).not.toContain('This later message does not fit.')
			expect(rendered.endsWith('…')).toBe(true)
		},
	)

	it.each(['tool arguments', 'attachment name'] as const)(
		'also bounds a huge %s without a message text body',
		async (kind) => {
			const provider = new MockLLMProvider({ turns: [{ text: 'COMPLETE' }] })
			const budget = 180
			const huge = `visible-detail-${'x'.repeat(100_000)}-unreachable-tail`
			const message =
				kind === 'tool arguments'
					? createAssistantMessage(null, [
							{
								id: 'large-call',
								type: 'function',
								function: { name: 'write', arguments: JSON.stringify({ content: huge }) },
							},
						])
					: createUserMessage('', [
							{ type: 'document', name: huge, mediaType: 'application/pdf', data: 'private-bytes' },
						])
			await buildVerifiedSummary(
				new WorkingStateManager(config),
				[message, createUserMessage('A later turn outside the budget.')],
				provider,
				{ ...config, convoTextBudget: budget },
			)
			const rendered = excerpt(provider)
			expect(rendered.length).toBeLessThanOrEqual(budget)
			expect(rendered).toContain('visible-detail-')
			expect(rendered).not.toContain('unreachable-tail')
			expect(rendered).not.toContain('private-bytes')
			expect(rendered).not.toContain('A later turn')
			expect(rendered.endsWith('…')).toBe(true)
		},
	)

	it.each([1, 8, 9])('keeps a %i-character excerpt inside even its role label', async (budget) => {
		const provider = new MockLLMProvider({ turns: [{ text: 'COMPLETE' }] })
		await buildVerifiedSummary(
			new WorkingStateManager(config),
			[createUserMessage('Longer than the entire budget.')],
			provider,
			{ ...config, convoTextBudget: budget },
		)
		const rendered = excerpt(provider)
		expect(rendered.length).toBeLessThanOrEqual(budget)
		expect(rendered.endsWith('…')).toBe(true)
	})

	it('does not split a Unicode character at the truncation boundary', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'COMPLETE' }] })
		await buildVerifiedSummary(
			new WorkingStateManager(config),
			[createUserMessage('🧾🧾🧾')],
			provider,
			{ ...config, convoTextBudget: '[user]: 🧾'.length },
		)
		expect(excerpt(provider)).toBe('[user]: …')
	})
})
