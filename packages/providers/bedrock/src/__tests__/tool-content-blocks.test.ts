import type { ChatCompletionParams } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { toBedrockMessages } from '../client.js'

/**
 * A tool result carrying content blocks was `JSON.stringify`d into the
 * text field, so a screenshot reached the model as a wall of quoted base64:
 * unreadable, and paid for by the character.
 *
 * This driver does not map image content — `supportsVision` is false and
 * says so — which makes the honest form the SDK's named placeholder. It
 * reports what was there and how big it was, so the model knows something
 * was withheld rather than believing it saw a JSON object.
 */

const PNG = 'iVBORw0KGgo='

function toolResultFor(content: unknown): Record<string, unknown> {
	const messages = toBedrockMessages([
		{ role: 'user', content: 'take a shot' },
		{
			role: 'assistant',
			content: null,
			toolCalls: [
				{ id: 'call_1', type: 'function', function: { name: 'screenshot', arguments: '{}' } },
			],
		},
		{ role: 'tool', toolCallId: 'call_1', content },
	] as unknown as ChatCompletionParams['messages'])

	const block = messages
		.flatMap((m) => m.content ?? [])
		.find((b) => (b as { toolResult?: unknown }).toolResult)
	return (block as unknown as { toolResult: Record<string, unknown> }).toolResult
}

function textOf(result: Record<string, unknown>): string {
	const content = result.content as Array<{ text?: string }>
	return content.map((c) => c.text ?? '').join('\n')
}

describe('a tool result the wire cannot carry is described, not dumped', () => {
	it('names the media type and size instead of the payload', () => {
		const text = textOf(toolResultFor([{ type: 'image', mediaType: 'image/png', data: PNG }]))

		expect(text).toContain('image/png')
		expect(text).toMatch(/\d+(\.\d+)? (B|KB|MB)/)
	})

	it('does not put the base64 payload in the text', () => {
		const text = textOf(
			toolResultFor([{ type: 'image', mediaType: 'image/png', data: 'A'.repeat(2048) }]),
		)

		// The bug in one assertion: the payload used to be JSON-quoted into
		// the text field, so the model paid for 2048 unreadable characters.
		expect(text).not.toContain('A'.repeat(64))
	})

	it('keeps the text blocks that sit alongside', () => {
		const text = textOf(
			toolResultFor([
				{ type: 'text', text: 'captured the window' },
				{ type: 'image', mediaType: 'image/png', data: PNG },
			]),
		)

		expect(text).toContain('captured the window')
		expect(text).toContain('image/png')
	})

	it('names a document by its filename', () => {
		const text = textOf(
			toolResultFor([
				{ type: 'document', mediaType: 'application/pdf', data: 'JVBER', name: 'lease.pdf' },
			]),
		)

		expect(text).toContain('lease.pdf')
		expect(text).toContain('application/pdf')
	})
})

describe('the plain cases are unchanged', () => {
	it('passes a string result straight through', () => {
		expect(textOf(toolResultFor('just text'))).toBe('just text')
	})

	it('passes text-only blocks through as their text', () => {
		expect(textOf(toolResultFor([{ type: 'text', text: 'only words' }]))).toBe('only words')
	})

	it('answers the tool call it was given', () => {
		expect(toolResultFor('x').toolUseId).toBe('call_1')
	})

	it('groups results answering one turn into a single message', () => {
		const messages = toBedrockMessages([
			{ role: 'user', content: 'read both' },
			{
				role: 'assistant',
				content: null,
				toolCalls: [
					{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } },
					{ id: 'call_2', type: 'function', function: { name: 'read', arguments: '{}' } },
				],
			},
			{ role: 'tool', toolCallId: 'call_1', content: 'one' },
			{ role: 'tool', toolCallId: 'call_2', content: 'two' },
		] as unknown as ChatCompletionParams['messages'])

		const resultTurns = messages.filter((m) =>
			(m.content ?? []).every((b) => (b as { toolResult?: unknown }).toolResult),
		)
		expect(resultTurns).toHaveLength(1)
		expect(resultTurns[0]?.content).toHaveLength(2)
	})
})
