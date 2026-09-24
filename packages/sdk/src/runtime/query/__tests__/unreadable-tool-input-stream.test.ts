import { describe, expect, it, vi } from 'vitest'

import { isProviderRequestError } from '../../../provider/errors.js'
import type { TurnId } from '../../../types/ids/index.js'
import type { LLMProvider, StreamChunk } from '../../../types/provider/index.js'
import type { SessionEvent } from '../../../types/session/index.js'
import type { Logger } from '../../../utils/logger.js'
import type { SessionEventDraft } from '../events.js'
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

function providerOf(chunks: StreamChunk[]): LLMProvider {
	return {
		id: 'fake',
		name: 'Fake',
		chatStream: async function* () {
			for (const c of chunks) yield c
		},
	} as unknown as LLMProvider
}

async function run(chunks: StreamChunk[]) {
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
		providerOf(chunks),
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

	it('reports the end of the text as the offset when the input simply ended', async () => {
		const { events } = await run([open(0, 'call_1'), args(0, '   '), finish('tool_calls')])
		expect(completed(events)[0]?.inputError).toMatchObject({
			reason: 'malformed',
			parseError: 'Unexpected end of JSON input',
			offset: 3,
			length: 3,
		})
	})

	it('measures the whole response beside the call: text, reasoning and every call', async () => {
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
			responseLength:
				'Planning the file.'.length + 'Here it is:'.length + '{"q":"fine"}'.length + cut.length,
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
