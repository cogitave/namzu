import { type Message, MessageSchema } from '@ag-ui/core'
import { describe, expect, it } from 'vitest'
import { AGUIRequestError } from '../errors.js'
import { toNamzuMessages } from '../messages.js'

const parse = (input: unknown): Message => MessageSchema.parse(input)
const call = (id = 'call:1', args = '{ "city": "Paris" }') => ({
	id,
	type: 'function' as const,
	function: { name: 'weather', arguments: args },
})
const assistant = (calls = [call()]) =>
	parse({ id: 'assistant', role: 'assistant', content: 'Checking.', toolCalls: calls })
const tool = (id = 'result', toolCallId = 'call:1') =>
	parse({ id, role: 'tool', toolCallId, content: 'Sunny' })

describe('toNamzuMessages', () => {
	it.each([
		{ history: [{ id: 'secret-id', role: 'system', content: 'secret policy' }] },
		{
			history: [
				{ id: 'secret-id', role: 'tool', toolCallId: 'secret-call', content: 'secret output' },
			],
		},
		{ history: [{ id: 'secret-id', role: 'secret-invalid-role', content: 'secret content' }] },
		{
			history: [
				{
					id: 'secret-id',
					role: 'user',
					content: [{ type: 'binary', mimeType: 'secret-type', data: 'YQ==' }],
				},
			],
		},
	])(
		'classifies invalid history as a public 422 without exposing its values: %j',
		({ history }) => {
			const convert = () => toNamzuMessages(history as Message[])
			expect(convert).toThrow(AGUIRequestError)
			expect(convert).toThrow(
				expect.objectContaining({ status: 422, code: 'INVALID_MESSAGE_HISTORY' }),
			)
			try {
				convert()
			} catch (error) {
				expect((error as Error).message).not.toContain('secret')
			}
		},
	)

	it('preserves conversation and complete parallel tool rounds without carrying client metadata', () => {
		const history = [
			parse({ id: 'user', role: 'user', content: 'Weather?', metadata: { tenantId: 'untrusted' } }),
			assistant([call(), call('call:2')]),
			tool('second-result', 'call:2'),
			tool(),
			parse({ id: 'answer', role: 'assistant', content: 'It is sunny.' }),
		]
		expect(toNamzuMessages(history)).toEqual([
			{ role: 'user', content: 'Weather?' },
			{ role: 'assistant', content: 'Checking.', toolCalls: [call(), call('call:2')] },
			{ role: 'tool', toolCallId: 'call:2', content: 'Sunny' },
			{ role: 'tool', toolCallId: 'call:1', content: 'Sunny' },
			{ role: 'assistant', content: 'It is sunny.' },
		])
	})

	it.each(['system', 'developer'])('requires explicit trust for %s messages', (role) => {
		const history = [parse({ id: 'policy', role, content: 'Trusted policy' })]
		expect(() => toNamzuMessages(history)).toThrow('allowSystemMessages: true')
		expect(toNamzuMessages(history, { allowSystemMessages: true })).toEqual([
			{ role: 'system', content: 'Trusted policy' },
		])
	})

	it('omits display-only messages even inside tool rounds, without leaking reasoning', () => {
		expect(
			toNamzuMessages([
				assistant(),
				parse({ id: 'thought', role: 'reasoning', content: 'Private', encryptedValue: 'opaque' }),
				parse({ id: 'card', role: 'activity', activityType: 'card', content: { text: 'A card' } }),
				tool(),
			]),
		).toEqual([
			{ role: 'assistant', content: 'Checking.', toolCalls: [call()] },
			{ role: 'tool', toolCallId: 'call:1', content: 'Sunny' },
		])
	})

	it('preserves tool error verdicts and absent assistant text', () => {
		expect(
			toNamzuMessages([
				parse({ id: 'assistant', role: 'assistant', toolCalls: [call()] }),
				parse({
					id: 'result',
					role: 'tool',
					toolCallId: 'call:1',
					content: 'Failed',
					error: 'Failed',
				}),
			]),
		).toEqual([
			{ role: 'assistant', content: null, toolCalls: [call()] },
			{ role: 'tool', toolCallId: 'call:1', content: 'Failed', isError: true },
		])
	})

	it.each([
		{ metadata: { namzu: { isError: true } }, isError: true },
		{ metadata: { namzu: { isError: false } }, isError: undefined },
		{ metadata: { namzu: { isError: 'true' } }, isError: undefined },
		{ metadata: { namzu: { isError: 1 } }, isError: undefined },
		{ metadata: { namzu: { isError: null } }, isError: undefined },
		{ metadata: { namzu: null }, isError: undefined },
		{ metadata: { namzu: [] }, isError: undefined },
		{ metadata: { namzu: 'true' }, isError: undefined },
		{ metadata: { namzu: true }, isError: undefined },
		{ metadata: { isError: true }, isError: undefined },
		{ metadata: { namzu: { approved: true } }, isError: undefined },
	])('projects only a literal tool failure verdict from metadata: %j', ({ metadata, isError }) => {
		const result = toNamzuMessages([
			assistant(),
			parse({ id: 'result', role: 'tool', toolCallId: 'call:1', content: 'Tool output', metadata }),
		])
		expect(result[1]).toEqual({
			role: 'tool',
			toolCallId: 'call:1',
			content: 'Tool output',
			...(isError ? { isError } : {}),
		})
	})

	it('keeps an official error verdict when metadata claims success', () => {
		const result = toNamzuMessages([
			assistant(),
			parse({
				id: 'result',
				role: 'tool',
				toolCallId: 'call:1',
				content: 'Failed',
				error: 'Failed',
				metadata: { namzu: { isError: false } },
			}),
		])
		expect(result[1]).toMatchObject({ isError: true })
	})

	it.each([
		{ name: 'unmatched result', history: [tool()], error: 'unmatched tool result' },
		{
			name: 'duplicate result',
			history: [assistant(), tool(), tool('another-result')],
			error: 'duplicate tool result',
		},
		{ name: 'pending call', history: [assistant()], error: 'unresolved tool calls' },
		{
			name: 'interrupted tool batch',
			history: [assistant(), parse({ id: 'next', role: 'user', content: 'Go on' }), tool()],
			error: 'unresolved tool calls',
		},
		{
			name: 'duplicate call IDs',
			history: [assistant([call(), call()]), tool()],
			error: 'duplicate tool call ID',
		},
		{
			name: 'invalid arguments',
			history: [assistant([call('call:1', '{')]), tool()],
			error: 'invalid JSON arguments',
		},
		{
			name: 'duplicate message IDs',
			history: [
				parse({ id: 'same', role: 'user', content: 'Hi' }),
				parse({ id: 'same', role: 'reasoning', content: 'Thought' }),
			],
			error: 'duplicate message ID',
		},
	])('rejects $name before history can reach query repair', ({ history, error }) => {
		expect(() => toNamzuMessages(history)).toThrow(error)
	})

	it('copies supported inline image/document data and preserves text and attachment order', () => {
		const message = parse({
			id: 'multimodal',
			role: 'user',
			content: [
				{ type: 'text', text: 'First' },
				{ type: 'image', source: { type: 'data', value: 'aW1hZ2U=', mimeType: 'image/png' } },
				{ type: 'text', text: 'Second' },
				{ type: 'document', source: { type: 'data', value: 'cGRm', mimeType: 'application/pdf' } },
				{ type: 'binary', data: 'dGV4dA==', mimeType: 'text/plain', filename: 'notes.txt' },
			],
		})
		expect(toNamzuMessages([message])).toEqual([
			{
				role: 'user',
				content: 'First\nSecond',
				attachments: [
					{ type: 'image', data: 'aW1hZ2U=', mediaType: 'image/png' },
					{ type: 'document', data: 'cGRm', mediaType: 'application/pdf' },
					{ type: 'document', data: 'dGV4dA==', mediaType: 'text/plain', name: 'notes.txt' },
				],
			},
		])
	})

	it.each([
		{ type: 'image', source: { type: 'url', value: 'https://example.com/image.png' } },
		{ type: 'document', source: { type: 'url', value: 'file:///private.pdf' } },
		{ type: 'binary', mimeType: 'image/png', id: 'remote-attachment' },
		{
			type: 'binary',
			mimeType: 'image/png',
			data: 'aW1hZ2U=',
			url: 'https://example.com/image.png',
		},
		{ type: 'binary', mimeType: 'audio/wav', data: 'YXVkaW8=' },
		{ type: 'audio', source: { type: 'data', value: 'YXVkaW8=', mimeType: 'audio/wav' } },
		{ type: 'video', source: { type: 'data', value: 'dmlkZW8=', mimeType: 'video/mp4' } },
		{ type: 'image', source: { type: 'data', value: '!!!', mimeType: 'image/png' } },
		{ type: 'image', source: { type: 'data', value: 'YQ==', mimeType: 'text/plain' } },
	])('refuses unsupported rich content instead of dropping it: %j', (part) => {
		const message = parse({ id: 'rich', role: 'user', content: [part] })
		expect(() => toNamzuMessages([message])).toThrow('Cannot convert AG-UI history')
	})

	it('validates JavaScript callers against the official message schema', () => {
		const malformed = { id: 'bad', role: 'user', content: [{ type: 'unknown' }] }
		expect(() => toNamzuMessages([malformed as Message])).toThrow('invalid message at index 0')
	})

	it('refuses unsupported encrypted conversational content', () => {
		const message = parse({ id: 'encrypted', role: 'assistant', encryptedValue: 'opaque' })
		expect(() => toNamzuMessages([message])).toThrow('encrypted assistant content is unsupported')
	})

	it('does not retain mutable aliases to input tool calls', () => {
		const message = assistant()
		const result = toNamzuMessages([message, tool()])
		if (message.role === 'assistant' && message.toolCalls?.[0]) {
			message.toolCalls[0].function.arguments = '{ "changed": true }'
		}
		expect(result[0]).toMatchObject({ toolCalls: [call()] })
	})
})
