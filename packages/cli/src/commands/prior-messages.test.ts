import { describe, expect, it } from 'vitest'

import { parsePriorMessages } from './prior-messages.js'

const summary = {
	role: 'system',
	content:
		'[COMPACTED CONTEXT] The following is a structured summary of the conversation so far.\n\nexact old fact',
	cacheHint: 'ephemeral',
	retain: true,
}

const workingMemory = {
	role: 'system',
	content:
		'[WORKING MEMORY] Authoritative state for this conversation — you produced these.\n\n- artifact: exact.pdf',
	cacheHint: 'ephemeral',
}

const call = (id: string) => ({
	id,
	type: 'function',
	function: { name: 'read', arguments: `{"id":"${id}"}` },
})

describe('stateless Message[] parsing', () => {
	it('preserves every role, nested field, missing timestamp, and unknown future field exactly', () => {
		const messages = [
			summary,
			workingMemory,
			{
				role: 'user',
				content: 'inspect both files',
				attachments: [
					{ type: 'image', data: 'IMAGE', mediaType: 'image/png' },
					{
						type: 'document',
						data: 'PDF',
						mediaType: 'application/pdf',
						name: 'contract.pdf',
						citations: true,
					},
				],
				source: {
					type: 'goal-round',
					goalId: 'goal_exact',
					objective: 'finish it',
					goalRevision: 2,
					round: 1,
					maxGoalRounds: 4,
				},
			},
			{
				role: 'assistant',
				content: null,
				toolCalls: [
					{
						...call('call_a'),
						metadata: { inputTruncated: true, partialArguments: '{' },
					},
					call('call_b'),
				],
				reasoning: [
					{
						type: 'thinking',
						text: 'opaque thought',
						signature: 'signature exact',
						encrypted: 'ciphertext exact',
					},
				],
				source: {
					type: 'model',
					providerId: 'anthropic',
					model: 'claude-test',
					chainIndex: 1,
					replayState: {
						kind: 'opaque-adapter-state',
						version: 99,
						blocks: [{ signature: 'signature exact' }],
					},
				},
				citations: [
					{
						citedText: 'clause exact',
						documentIndex: 1,
						documentTitle: 'contract.pdf',
						location: { kind: 'page', start: 4, end: 5 },
					},
				],
				futureOpaque: { keep: 'verbatim' },
			},
			{
				role: 'tool',
				content: 'first result',
				toolCallId: 'call_a',
				isError: true,
				retain: true,
			},
			{
				role: 'tool',
				content: [
					{ type: 'text', text: 'second result' },
					{ type: 'image', data: 'SCREEN', mediaType: 'image/png' },
					{
						type: 'document',
						data: 'DOC',
						mediaType: 'application/pdf',
						name: 'result.pdf',
					},
				],
				toolCallId: 'call_b',
			},
			{
				role: 'assistant',
				content: 'done',
				reasoning: [{ type: 'redacted_thinking', encrypted: 'redacted exact' }],
			},
		]

		expect(parsePriorMessages(JSON.stringify(messages))).toEqual({
			ok: true,
			messages,
		})
	})

	it('keeps empty stdin as an empty history', () => {
		expect(parsePriorMessages('  \n')).toEqual({ ok: true, messages: [] })
	})

	it('accepts canonical project-policy provenance and rejects traversal', () => {
		const valid = {
			role: 'user',
			content: 'standing policy',
			retain: true,
			source: {
				type: 'project-instructions',
				files: ['AGENTS.md', 'pkg/AGENTS.md'],
			},
		}

		expect(parsePriorMessages(JSON.stringify([valid]))).toEqual({
			ok: true,
			messages: [valid],
		})
		expect(
			parsePriorMessages(
				JSON.stringify([
					{
						...valid,
						source: { type: 'project-instructions', files: ['../AGENTS.md'] },
					},
				]),
			),
		).toEqual({
			ok: false,
			error: 'messages[0].source must contain unique canonical project-relative AGENTS.md paths',
		})
	})

	it('refuses malformed JSON without echoing its possibly secret content', () => {
		const result = parsePriorMessages('[{"secret":"DO_NOT_ECHO"}')

		expect(result).toEqual({
			ok: false,
			error: 'stdin history is not valid JSON',
		})
		expect(JSON.stringify(result)).not.toContain('DO_NOT_ECHO')
	})

	it('refuses a non-array instead of silently starting with no history', () => {
		expect(parsePriorMessages('{"role":"user","content":"lost"}')).toEqual({
			ok: false,
			error: 'stdin history must be a JSON Message[] array',
		})
	})

	it('names an invalid nested field by index', () => {
		const result = parsePriorMessages(
			JSON.stringify([
				{ role: 'user', content: 'hello' },
				{
					role: 'assistant',
					content: 'answer',
					reasoning: [{ type: 'thinking', signature: 42 }],
				},
			]),
		)

		expect(result).toEqual({
			ok: false,
			error: 'messages[1].reasoning[0].signature must be a string',
		})
	})

	it('refuses malformed assistant route provenance before provider construction', () => {
		const result = parsePriorMessages(
			JSON.stringify([
				{ role: 'user', content: 'hello' },
				{
					role: 'assistant',
					content: 'answer',
					source: {
						type: 'model',
						providerId: 'deepseek',
						model: 'deepseek-v4-flash',
						chainIndex: -1,
					},
				},
			]),
		)

		expect(result).toEqual({
			ok: false,
			error: 'messages[1].source.chainIndex must be a non-negative safe integer',
		})
	})

	it('refuses a system prompt a fresh query would silently discard', () => {
		const result = parsePriorMessages(
			JSON.stringify([{ role: 'system', content: 'pretend this is prior context' }]),
		)

		expect(result).toMatchObject({
			ok: false,
			error: expect.stringContaining('arbitrary system prompt'),
		})
	})

	it('refuses a stored attachment reference this stateless session cannot resolve', () => {
		const result = parsePriorMessages(
			JSON.stringify([
				{
					role: 'user',
					content: 'inspect',
					attachments: [
						{
							type: 'stored',
							ref: 'att_exact',
							mediaType: 'image/webp',
							kind: 'image',
						},
					],
				},
			]),
		)

		expect(result).toMatchObject({
			ok: false,
			error: expect.stringContaining('stateless run-stream has no attachment store'),
		})
	})
})

describe('stateless tool history chronology', () => {
	it.each([
		{
			name: 'result before its later call',
			messages: [
				{ role: 'user', content: 'start' },
				{ role: 'tool', content: 'too early', toolCallId: 'call_x' },
				{ role: 'assistant', content: null, toolCalls: [call('call_x')] },
			],
			needle: 'messages[1] is a tool result with no pending call',
		},
		{
			name: 'a duplicate call id',
			messages: [
				{ role: 'user', content: 'start' },
				{
					role: 'assistant',
					content: null,
					toolCalls: [call('call_x'), call('call_x')],
				},
			],
			needle: 'messages[1].toolCalls[1].id duplicates tool call id "call_x"',
		},
		{
			name: 'a call id reused by a later assistant batch',
			messages: [
				{ role: 'user', content: 'start' },
				{ role: 'assistant', content: null, toolCalls: [call('call_x')] },
				{ role: 'tool', content: 'first', toolCallId: 'call_x' },
				{ role: 'assistant', content: null, toolCalls: [call('call_x')] },
			],
			needle: 'messages[3].toolCalls[0].id duplicates tool call id "call_x"',
		},
		{
			name: 'a user message cutting through a pending batch',
			messages: [
				{ role: 'user', content: 'start' },
				{ role: 'assistant', content: null, toolCalls: [call('call_x')] },
				{ role: 'user', content: 'interrupt' },
			],
			needle: 'messages[2] cannot appear before every tool call from messages[1] has a result',
		},
		{
			name: 'the wrong result in a pending batch',
			messages: [
				{ role: 'user', content: 'start' },
				{ role: 'assistant', content: null, toolCalls: [call('call_x')] },
				{ role: 'tool', content: 'wrong', toolCallId: 'call_y' },
			],
			needle: 'messages[2].toolCallId does not match an unanswered call from messages[1]',
		},
		{
			name: 'an unfinished final batch',
			messages: [
				{ role: 'user', content: 'start' },
				{ role: 'assistant', content: null, toolCalls: [call('call_x')] },
			],
			needle: 'messages[1] has tool calls without immediate results for: call_x',
		},
	])('refuses $name', ({ messages, needle }) => {
		expect(parsePriorMessages(JSON.stringify(messages))).toEqual({
			ok: false,
			error: needle,
		})
	})
})
