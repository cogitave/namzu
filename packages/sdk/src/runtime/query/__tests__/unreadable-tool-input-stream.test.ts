import { describe, expect, it, vi } from 'vitest'

import { isProviderRequestError } from '../../../provider/errors.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import type { TurnId } from '../../../types/ids/index.js'
import type { LLMProvider, StreamChunk } from '../../../types/provider/index.js'
import type { SessionEvent } from '../../../types/session/index.js'
import type { Logger } from '../../../utils/logger.js'
import type { SessionEventDraft } from '../events.js'
import { unreadableToolInputMessage } from '../executor/tool-call-admission.js'
import { streamProviderTurn } from '../iteration/stream-turn.js'
import { PARTIAL_ARGUMENTS_EVENT_LIMIT } from '../iteration/tool-input.js'

/**
 * A streamed tool call whose arguments do not parse was always reported as
 * cut off, and the finish reason the stream reported was recorded and never
 * read. A model that wrote malformed JSON on a response that finished
 * normally was told its call had been cut off and to send less, which does
 * nothing for malformed JSON. And a stream that put two calls on one index
 * had the second call's arguments appended to the first's, and arguments
 * sent before the call's id were dropped — so the buffer that failed to parse
 * was not even what the model sent.
 */

const TURN_ID = '99b1ceae-1a8b-4b07-b56e-327eae34f058' as TurnId

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

/** An `Error` in the list is thrown there, as a dropped connection is. */
function providerOf(chunks: Array<StreamChunk | Error>): LLMProvider {
	return {
		id: 'fake',
		name: 'Fake',
		chatStream: async function* () {
			for (const c of chunks) {
				if (c instanceof Error) throw c
				yield c
			}
		},
	} as unknown as LLMProvider
}

async function run(chunks: Array<StreamChunk | Error> | LLMProvider) {
	const events: SessionEvent[] = []
	const pending: SessionEvent[] = []
	const emitEvent = async (e: SessionEventDraft) => {
		events.push(e as SessionEvent)
		pending.push(e as SessionEvent)
	}
	const drainPending = function* (): Generator<SessionEvent> {
		while (pending.length > 0) {
			const next = pending.shift()
			if (next) yield next
		}
	}
	const gen = streamProviderTurn(
		Array.isArray(chunks) ? providerOf(chunks) : chunks,
		{ model: 'm', messages: [] } as never,
		emitEvent,
		drainPending,
		TURN_ID,
		1,
		false,
		makeLogger(),
	)
	try {
		let next = await gen.next()
		while (!next.done) next = await gen.next()
		return { result: next.value, events, error: undefined as unknown }
	} catch (error) {
		return { result: undefined, events, error }
	}
}

const USAGE = {
	promptTokens: 1,
	completionTokens: 1,
	totalTokens: 2,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

const open = (index: number, id: string, name = 'ask'): StreamChunk => ({
	id: 'c',
	delta: { toolCalls: [{ index, id, type: 'function', function: { name, arguments: '' } }] },
})
const args = (index: number, fragment: string, id?: string): StreamChunk => ({
	id: 'c',
	delta: {
		toolCalls: [{ index, ...(id ? { id } : {}), function: { arguments: fragment } }],
	},
})
const close = (index: number, id: string): StreamChunk => ({
	id: 'c',
	delta: { toolCallEnd: { index, id } },
})
const finish = (finishReason: NonNullable<StreamChunk['finishReason']>): StreamChunk => ({
	id: 'c',
	delta: {},
	finishReason,
	usage: USAGE,
})

function completed(events: SessionEvent[]) {
	return events.filter(
		(e): e is Extract<SessionEvent, { type: 'tool_input_completed' }> =>
			e.type === 'tool_input_completed',
	)
}

describe('unreadable tool input is classified from how the response ended', () => {
	it("reads MockLLMProvider's truncateArguments as truncated, even with a call scripted after it", async () => {
		// Its documentation promised a `truncated` call. With a later call in
		// the script, the mock streamed that call after the cut, and the cut
		// call came out `malformed`.
		const { result, events } = await run(
			new MockLLMProvider({
				turns: [
					{
						toolCalls: [
							{
								name: 'write',
								args: { path: 'a.md', content: 'x'.repeat(40) },
								truncateArguments: true,
							},
							{ name: 'ask', args: { q: 'y' } },
						],
					},
				],
			}),
		)

		expect(completed(events)).toHaveLength(1)
		expect(completed(events)[0]).toMatchObject({
			inputTruncated: true,
			inputError: { reason: 'truncated', finishReason: 'length' },
		})
		expect(result?.response.message.toolCalls?.map((call) => call.function.name)).toEqual(['write'])
	})

	it('calls broken JSON on a normally finished response malformed, with the parser error', async () => {
		const broken = '{"question":"Which one?","options":["a" "b"]}'
		const { result, events } = await run([
			open(0, 'call_1'),
			args(0, broken),
			close(0, 'call_1'),
			finish('tool_calls'),
		])

		const [event] = completed(events)
		expect(event).toMatchObject({
			toolUseId: 'call_1',
			input: {},
			inputTruncated: true,
			partialArguments: broken,
			inputError: {
				reason: 'malformed',
				finishReason: 'tool_calls',
				offset: 40,
				length: broken.length,
			},
		})
		expect(event?.inputError?.parseError).toMatch(/position 40/)

		const call = result?.response.message.toolCalls?.[0]
		expect(call?.function.arguments).toBe('{}')
		expect(call?.metadata).toEqual({
			inputTruncated: true,
			partialArguments: broken,
			inputError: event?.inputError,
		})
	})

	it('calls a buffer the output limit stopped truncated, even when the block was closed first', async () => {
		// The Messages API closes an open tool_use block and only then reports
		// `max_tokens`, so the classification has to wait for the finish reason.
		const cut = '{"path":"notes.md","content":"The first half of a long'
		const { events } = await run([
			open(0, 'call_1', 'write'),
			args(0, cut),
			close(0, 'call_1'),
			finish('length'),
		])

		const types = events.map((e) => e.type)
		expect(types.indexOf('tool_input_completed')).toBeGreaterThan(-1)
		expect(completed(events)[0]).toMatchObject({
			inputTruncated: true,
			inputError: {
				reason: 'truncated',
				finishReason: 'length',
				offset: cut.length,
				length: cut.length,
			},
		})
	})

	it('calls a stream that ended without a finish reason truncated, with no finish reason', async () => {
		const cut = '{"path":"notes.md","content":"partial'
		const { events } = await run([open(0, 'call_1', 'write'), args(0, cut)])

		const [event] = completed(events)
		expect(event?.inputError?.reason).toBe('truncated')
		expect(event?.inputError).not.toHaveProperty('finishReason')
	})

	it('calls a response a content filter stopped truncated, not malformed', async () => {
		const { events } = await run([
			open(0, 'call_1'),
			args(0, '{"q":"hal'),
			finish('content_filter'),
		])
		expect(completed(events)[0]?.inputError).toMatchObject({
			reason: 'truncated',
			finishReason: 'content_filter',
		})
	})

	it('locates a Python literal in malformed arguments, though the parser names no position', async () => {
		const broken = '{"question":"Ship it?","multi":True}'
		const { events } = await run([
			open(0, 'call_1'),
			args(0, broken),
			close(0, 'call_1'),
			finish('tool_calls'),
		])
		expect(completed(events)[0]?.inputError).toMatchObject({
			reason: 'malformed',
			offset: broken.indexOf('True'),
		})
	})

	it('reports the end of the text as the offset when the input simply ended', async () => {
		const { events } = await run([open(0, 'call_1'), args(0, '   '), finish('tool_calls')])
		expect(completed(events)[0]?.inputError).toMatchObject({
			reason: 'malformed',
			parseError: 'Unexpected end of JSON input',
			offset: 3,
			length: 3,
		})
	})

	it('measures what came before the call: text, reasoning and earlier calls', async () => {
		// What decides whether the call itself or what came before it is to be
		// shortened after an output limit.
		const cut = '{"path":"a.md","content":"long'
		const { events } = await run([
			{ id: 'c', delta: { reasoning: { index: 0, text: 'Planning the file.' } } },
			{ id: 'c', delta: { content: 'Here it is:' } },
			open(0, 'call_1'),
			args(0, '{"q":"fine"}'),
			close(0, 'call_1'),
			open(1, 'call_2', 'write'),
			args(1, cut),
			finish('length'),
		])

		expect(completed(events).at(-1)?.inputError).toMatchObject({
			reason: 'truncated',
			length: cut.length,
			precedingLength: 'Planning the file.'.length + 'Here it is:'.length + '{"q":"fine"}'.length,
		})
	})

	it('caps the text on the event and keeps all of it on the message', async () => {
		const long = `{"content":"${'x'.repeat(PARTIAL_ARGUMENTS_EVENT_LIMIT + 500)}`
		const { result, events } = await run([
			open(0, 'call_1', 'write'),
			args(0, long),
			finish('length'),
		])

		const [event] = completed(events)
		expect(event?.partialArguments).toBe(long.slice(0, PARTIAL_ARGUMENTS_EVENT_LIMIT))
		expect(event?.inputError?.length).toBe(long.length)
		expect(result?.response.message.toolCalls?.[0]?.metadata?.partialArguments).toBe(long)
	})

	it('leaves a readable call alone and marks only the unreadable one', async () => {
		const { result, events } = await run([
			open(0, 'call_1'),
			args(0, '{"q":"fine"}'),
			close(0, 'call_1'),
			open(1, 'call_2'),
			args(1, '{"q":'),
			close(1, 'call_2'),
			finish('tool_calls'),
		])

		const [first, second] = completed(events)
		expect(first).toEqual(expect.objectContaining({ toolUseId: 'call_1', input: { q: 'fine' } }))
		expect(first).not.toHaveProperty('inputError')
		expect(second?.inputError?.reason).toBe('malformed')
		expect(result?.response.message.toolCalls?.[0]?.metadata).toBeUndefined()
	})
})

describe('only the call the response stopped on can have been cut off', () => {
	// An output limit, a content filter or a dropped stream stops a response
	// wherever it is, so it can cut only the call it was streaming then. Every
	// unreadable call used to be classified from the finish reason alone: a
	// closed call with a Python `True`, followed by a long call the limit cut,
	// was told it had been cut off after 11 characters, and that most of the
	// response had gone to what came before it. Nothing came before it; the
	// 3000 characters came after, and the `True` was never mentioned.
	const first = '{"q": True}'
	const long = `{"path":"a.md","content":"${'x'.repeat(3000)}`

	it('calls a closed call malformed when another call followed it and the limit cut that one', async () => {
		const { result, events } = await run([
			open(0, 'call_a'),
			args(0, first),
			close(0, 'call_a'),
			open(1, 'call_b', 'write'),
			args(1, long),
			close(1, 'call_b'),
			finish('length'),
		])

		const [a, b] = completed(events)
		expect(a?.inputError).toMatchObject({
			reason: 'malformed',
			finishReason: 'length',
			offset: first.indexOf('True'),
			length: first.length,
			precedingLength: 0,
		})
		expect(b?.inputError).toMatchObject({
			reason: 'truncated',
			finishReason: 'length',
			length: long.length,
			precedingLength: first.length,
		})

		const message = unreadableToolInputMessage(
			'ask',
			result?.response.message.toolCalls?.[0]?.metadata?.inputError,
		)
		expect(message).toContain('were not valid JSON')
		expect(message).toContain(`at character ${first.indexOf('True')}`)
		expect(message).not.toMatch(/cut off|came before/)
	})

	it.each([
		['text', { id: 'c', delta: { content: `Now let me explain: ${'y'.repeat(500)}` } }],
		['reasoning', { id: 'c', delta: { reasoning: { index: 0, text: 'Thinking it over.' } } }],
		[
			'a hosted search',
			{
				id: 'c',
				delta: { hostedTool: { id: 'ws_1', name: 'web_search', status: 'running' } },
			},
		],
	] as const)('calls a closed call malformed when %s followed it', async (_, later) => {
		for (const finishReason of ['length', 'content_filter'] as const) {
			const { events } = await run([
				open(0, 'call_a'),
				args(0, first),
				close(0, 'call_a'),
				later as StreamChunk,
				finish(finishReason),
			])
			expect(completed(events)[0]?.inputError).toMatchObject({
				reason: 'malformed',
				finishReason,
			})
		}
	})

	it('calls a closed call malformed and the call the dropped stream was on truncated', async () => {
		const { result, events } = await run([
			open(0, 'call_a'),
			args(0, '{"q": None}'),
			close(0, 'call_a'),
			open(1, 'call_b'),
			args(1, '{"q": "par'),
			new Error('socket hang up'),
		])

		const [a, b] = completed(events)
		expect(a?.inputError).toMatchObject({ reason: 'malformed', offset: 6 })
		expect(a?.inputError).not.toHaveProperty('finishReason')
		expect(b?.inputError).toMatchObject({ reason: 'truncated', precedingLength: 11 })
		expect(
			unreadableToolInputMessage(
				'ask',
				result?.response.message.toolCalls?.[0]?.metadata?.inputError,
			),
		).toContain('were not valid JSON')
	})

	it("still calls the last call cut off when only the driver's own text followed it", async () => {
		// A driver's sources appendix arrives after the model stopped. It is
		// not the model moving on from the call.
		const { events } = await run([
			open(0, 'call_1', 'write'),
			args(0, long),
			close(0, 'call_1'),
			{
				id: 'c',
				delta: { content: '\n\nSources:\n- https://example.com', contentOrigin: 'driver' },
			},
			finish('length'),
		])

		expect(completed(events)[0]?.inputError).toMatchObject({
			reason: 'truncated',
			finishReason: 'length',
			precedingLength: 0,
		})
	})

	it("does not count a call's name or id arriving late as output after the next call", async () => {
		const { events } = await run([
			open(0, 'call_a'),
			args(0, '{"q":"fine"}'),
			open(1, 'call_b'),
			args(1, '{"q":"par'),
			args(0, '', 'call_a'),
			finish('length'),
		])
		expect(completed(events).at(-1)).toMatchObject({
			toolUseId: 'call_b',
			inputError: { reason: 'truncated' },
		})
	})
})

describe('tool-call framing', () => {
	it('refuses a second call id on an index another call holds, instead of joining their arguments', async () => {
		const { error, events } = await run([
			open(0, 'call_a'),
			args(0, '{"q":"first"}'),
			args(0, '{"q":"second"}', 'call_b'),
			finish('tool_calls'),
		])

		expect(isProviderRequestError(error)).toBe(true)
		expect(error).toMatchObject({
			kind: 'server',
			providerId: 'fake',
			detail: 'the stream reused tool-call index 0 for call "call_b" while call "call_a" held it',
		})
		// Nothing of the second call reached the first call's buffer.
		expect(
			events.some((e) => e.type === 'tool_input_delta' && e.partialJson.includes('second')),
		).toBe(false)
		// The message still closes, so a host's cards do not hang open.
		expect(events.at(-1)).toMatchObject({ type: 'message_completed', stopReason: 'refusal' })
	})

	it('keeps arguments sent before the call id, and announces them once the id arrives', async () => {
		// The index says whose arguments these are. They used to be dropped
		// with a warning, and what was left failed to parse and was reported
		// as a cut-off call.
		const { error, result, events } = await run([
			{
				id: 'c',
				delta: { toolCalls: [{ index: 0, function: { name: 'ask', arguments: '{"q"' } }] },
			},
			args(0, ':"x"}', 'call_1'),
			finish('tool_calls'),
		])

		expect(error).toBeUndefined()
		const call = result?.response.message.toolCalls?.[0]
		expect(call).toMatchObject({ id: 'call_1', function: { name: 'ask', arguments: '{"q":"x"}' } })
		expect(call?.metadata).toBeUndefined()
		const lifecycle = events
			.filter((e) => e.type.startsWith('tool_input_'))
			.map((e) => [e.type, e.type === 'tool_input_delta' ? e.partialJson : undefined])
		expect(lifecycle).toEqual([
			['tool_input_started', undefined],
			['tool_input_delta', '{"q":"x"}'],
			['tool_input_completed', undefined],
		])
	})

	it('announces no delta before the call, when the name arrives after the arguments', async () => {
		const { result, events } = await run([
			args(0, '{"q":', 'call_1'),
			{ id: 'c', delta: { toolCalls: [{ index: 0, function: { name: 'ask' } }] } },
			args(0, '"x"}'),
			finish('tool_calls'),
		])

		expect(events.filter((e) => e.type.startsWith('tool_input_')).map((e) => e.type)).toEqual([
			'tool_input_started',
			'tool_input_delta',
			'tool_input_delta',
			'tool_input_completed',
		])
		expect(result?.response.message.toolCalls?.[0]?.function.arguments).toBe('{"q":"x"}')
	})

	it('takes the id from the block close when no fragment carried it', async () => {
		const { error, result } = await run([
			{ id: 'c', delta: { toolCalls: [{ index: 0, function: { name: 'ask', arguments: '{}' } }] } },
			close(0, 'call_1'),
			finish('tool_calls'),
		])

		expect(error).toBeUndefined()
		expect(result?.response.message.toolCalls?.[0]).toMatchObject({ id: 'call_1' })
	})

	it('completes a call under the id it runs with when the block close carries none', async () => {
		// The close's empty id was used for the completion, which then came
		// before the call was announced and named a different id from the
		// one the call ran under. AG-UI failed the run on it.
		const { error, result, events } = await run([
			{
				id: 'c',
				delta: { toolCalls: [{ index: 0, function: { name: 'ask', arguments: '{"q":1}' } }] },
			},
			close(0, ''),
			finish('tool_calls'),
		])

		expect(error).toBeUndefined()
		const call = result?.response.message.toolCalls?.[0]
		expect(call?.id).toMatch(/\S/)
		expect(call?.function.arguments).toBe('{"q":1}')
		const lifecycle = events.filter((e) => e.type.startsWith('tool_input_'))
		expect(lifecycle.map((e) => e.type)).toEqual([
			'tool_input_started',
			'tool_input_delta',
			'tool_input_completed',
		])
		expect(lifecycle.every((e) => 'toolUseId' in e && e.toolUseId === call?.id)).toBe(true)
	})

	it('completes a call under its own id when the block close names another', async () => {
		const { result, events } = await run([
			open(0, 'call_1'),
			args(0, '{"q":1}'),
			close(0, 'call_end'),
			finish('tool_calls'),
		])

		expect(result?.response.message.toolCalls?.[0]?.id).toBe('call_1')
		expect(completed(events)).toEqual([expect.objectContaining({ toolUseId: 'call_1' })])
	})

	it('sends no completion for a call it never announced', async () => {
		// A call whose name never arrives is never started, so a completion
		// for it would close something no consumer opened.
		const { events } = await run([
			args(0, '{"q":1}', 'call_1'),
			close(0, 'call_1'),
			finish('tool_calls'),
		])
		expect(events.filter((e) => e.type.startsWith('tool_input_'))).toEqual([])
	})

	it('gives a call whose id never arrives one, and runs it with all its arguments', async () => {
		// It used to reach the executor with an empty id, which no result can
		// name, and without the arguments dropped for arriving before it.
		const { error, result, events } = await run([
			{
				id: 'c',
				delta: { toolCalls: [{ index: 0, function: { name: 'ask', arguments: '{"q":' } }] },
			},
			args(0, '"x"}'),
			finish('tool_calls'),
		])

		expect(error).toBeUndefined()
		const call = result?.response.message.toolCalls?.[0]
		expect(call?.id).toMatch(/\S/)
		expect(call?.function).toEqual({ name: 'ask', arguments: '{"q":"x"}' })
		const lifecycle = events.filter((e) => e.type.startsWith('tool_input_'))
		expect(lifecycle.map((e) => e.type)).toEqual([
			'tool_input_started',
			'tool_input_delta',
			'tool_input_completed',
		])
		expect(lifecycle.every((e) => 'toolUseId' in e && e.toolUseId === call?.id)).toBe(true)
	})

	it('does not recover tool calls from a stream it refused', async () => {
		// A stream error after tool input normally becomes tool calls with a
		// retry hint; after a framing violation there is nothing to trust.
		const { error, result } = await run([open(0, 'call_a'), args(0, '{"q":1}'), open(0, 'call_b')])
		expect(isProviderRequestError(error)).toBe(true)
		expect(result).toBeUndefined()
	})

	it('accepts the same id repeated on every fragment', async () => {
		const { error, events } = await run([
			open(0, 'call_1'),
			args(0, '{"q":', 'call_1'),
			args(0, '"x"}', 'call_1'),
			finish('tool_calls'),
		])
		expect(error).toBeUndefined()
		expect(completed(events)[0]).toMatchObject({ toolUseId: 'call_1', input: { q: 'x' } })
	})
})
