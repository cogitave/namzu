import type { ChatCompletionParams, StreamChunk } from '@namzu/sdk'
import { selectAssistantText } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import { CodexProvider, toCodexInput } from '../codex.js'

const route = { providerId: 'codex', model: 'fixture-model', chainIndex: 0 }
const reasoning = {
	type: 'reasoning',
	id: 'rs_fixture',
	summary: [],
	encrypted_content: 'opaque-fixture-not-real-reasoning',
}
const message = {
	type: 'message',
	id: 'msg_fixture',
	role: 'assistant',
	status: 'completed',
	phase: 'commentary',
	content: [{ type: 'output_text', text: 'Reading.', annotations: [] }],
}
const call = {
	type: 'function_call',
	id: 'fc_fixture',
	call_id: 'call_fixture',
	name: 'read',
	arguments: '{"path":"note.txt"}',
	status: 'completed',
}
const done = (output_index: number, item: unknown) => ({
	type: 'response.output_item.done',
	output_index,
	item,
})
const completed = (output?: unknown[]) => ({
	type: 'response.completed',
	response: {
		id: 'resp_fixture',
		...(output === undefined ? {} : { output }),
		usage: { input_tokens: 30, output_tokens: 7 },
	},
})

function providerFor(
	events: unknown[] | (() => unknown[]),
	beforeEvent?: (event: unknown) => void,
) {
	const provider = new CodexProvider({ accessToken: 'fixture', accountId: 'fixture' })
	const create = vi.fn(async () =>
		(async function* () {
			for (const event of typeof events === 'function' ? events() : events) {
				beforeEvent?.(event)
				yield event
			}
		})(),
	)
	;(provider as unknown as { client: unknown }).client = { responses: { create } }
	return provider
}

async function collect(provider: CodexProvider, signal?: AbortSignal) {
	const chunks: StreamChunk[] = []
	for await (const chunk of provider.chatStream({
		model: route.model,
		providerRoute: route,
		messages: [{ role: 'user', content: 'Read the note.' }],
		signal,
	}))
		chunks.push(chunk)
	return chunks
}

function assistant(
	chunks: StreamChunk[],
): Extract<ChatCompletionParams['messages'][number], { role: 'assistant' }> {
	return {
		role: 'assistant',
		content: chunks.at(-1)?.textParts
			? selectAssistantText(chunks.at(-1)!.textParts!)
			: chunks.map((c) => c.delta.content ?? '').join('') || null,
		...(chunks.at(-1)?.textParts ? { textParts: chunks.at(-1)!.textParts } : {}),
		toolCalls: [
			{
				id: call.call_id,
				type: 'function',
				function: { name: call.name, arguments: call.arguments },
			},
		],
		source: { type: 'model', ...route, replayState: chunks.at(-1)?.replayState },
	}
}

const toolEvents = [
	{ type: 'response.created', response: { id: 'resp_fixture' } },
	{ type: 'response.output_item.added', output_index: 2, item: { ...call, arguments: '' } },
	{
		type: 'response.function_call_arguments.delta',
		item_id: call.id,
		output_index: 2,
		delta: call.arguments,
	},
	{ type: 'response.output_text.delta', delta: 'Reading.' },
	// Deliberately non-arrival order and duplicate final item: output indices own order.
	done(2, call),
	done(0, reasoning),
	done(1, message),
	done(0, reasoning),
]

describe('Codex finalized output retention', () => {
	it('separates identical commentary and final items and replays both after persistence', async () => {
		const progress = {
			...message,
			id: 'progress',
			content: [{ type: 'output_text', text: 'Which record?', annotations: [] }],
		}
		const answer = { ...progress, id: 'answer', phase: 'final_answer' }
		const chunks = await collect(
			providerFor([
				{ type: 'response.output_item.added', output_index: 0, item: progress },
				{ type: 'response.output_text.delta', item_id: progress.id, delta: 'Which record?' },
				{ type: 'response.output_item.added', output_index: 1, item: answer },
				{ type: 'response.output_text.delta', item_id: answer.id, delta: 'Which record?' },
				completed([progress, answer]),
			]),
		)
		expect(chunks.filter((c) => c.delta.content).map((c) => c.delta.textPart?.phase)).toEqual([
			'commentary',
			'final_answer',
		])
		const saved = { ...assistant(chunks), toolCalls: [] }
		expect(saved.content).toBe('Which record?')
		expect(toCodexInput(JSON.parse(JSON.stringify([saved])), route)).toEqual([progress, answer])
		const modified = {
			...saved,
			textParts: saved.textParts!.map((part) => ({ ...part, text: 'Changed' })),
		}
		expect(toCodexInput([modified], route)).not.toEqual([progress, answer])
	})
	it.each([[], undefined])(
		'replays completed items when the terminal output is %j',
		async (output) => {
			const chunks = await collect(providerFor([...toolEvents, completed(output)]))
			expect(chunks.at(-1)).toMatchObject({
				finishReason: 'tool_calls',
				usage: { promptTokens: 30, completionTokens: 7, totalTokens: 37 },
				replayState: {
					content: 'Reading.',
					toolCalls: [{ id: call.call_id, name: call.name, arguments: call.arguments }],
					items: [reasoning, message, call],
				},
			})
			// The same durable message is eligible before and after JSON persistence.
			const messages: ChatCompletionParams['messages'] = [
				assistant(chunks),
				{ role: 'tool', toolCallId: call.call_id, content: 'Observed.' },
			]
			const expected = [
				reasoning,
				message,
				call,
				{ type: 'function_call_output', call_id: call.call_id, output: 'Observed.' },
			]
			expect(toCodexInput(messages, route)).toEqual(expected)
			expect(toCodexInput(JSON.parse(JSON.stringify(messages)), route)).toEqual(expected)
			expect(chunks.flatMap((c) => c.delta.toolCalls ?? []).filter((c) => c.id)).toHaveLength(1)
		},
	)

	it('uses a populated terminal snapshot without appending stale or duplicate streamed items', async () => {
		const finalMessage = { ...message, phase: 'final_answer' }
		const chunks = await collect(
			providerFor([
				...toolEvents,
				done(3, { ...reasoning, id: 'stale' }),
				completed([reasoning, finalMessage, call]),
			]),
		)
		expect(toCodexInput([assistant(chunks)], route)).toEqual([reasoning, finalMessage, call])
	})

	it('retains a tool-only turn with null content and ignores unfinished added items', async () => {
		const chunks = await collect(
			providerFor([
				{ type: 'response.output_item.added', output_index: 3, item: message },
				done(0, reasoning),
				done(1, call),
				completed([]),
			]),
		)
		expect(chunks.at(-1)).toMatchObject({
			finishReason: 'tool_calls',
			replayState: { content: null, items: [reasoning, call] },
		})
		expect(toCodexInput([assistant(chunks)], route)).toEqual([reasoning, call])
	})

	it('retains final text and hosted citations from the finalized message', async () => {
		const search = {
			type: 'web_search_call',
			id: 'ws_fixture',
			status: 'completed',
			action: { type: 'search', query: 'reference' },
		}
		const cited = {
			...message,
			content: [
				{
					type: 'output_text',
					text: 'Reading.',
					annotations: [
						{
							type: 'url_citation',
							url: 'https://example.com/reference',
							title: 'Reference',
							start_index: 0,
							end_index: 8,
						},
					],
				},
			],
		}
		const chunks = await collect(
			providerFor([
				{ type: 'response.output_text.delta', delta: 'Reading.' },
				done(0, search),
				done(1, cited),
				completed([]),
			]),
		)
		const m = { ...assistant(chunks), toolCalls: undefined }
		expect(m.content).toBe('Reading.\n\nSources: [Reference](<https://example.com/reference>)')
		expect(chunks.at(-1)?.finishReason).toBe('stop')
		expect(toCodexInput([m], route)).toEqual([search, cited])
		expect(chunks.flatMap((c) => c.delta.toolCalls ?? [])).toEqual([])
	})

	it('still rejects replay after message edits, tool edits, model changes or route changes', async () => {
		const chunks = await collect(providerFor([...toolEvents, completed([])]))
		const m = assistant(chunks)
		for (const changed of [
			{ ...m, content: 'Edited.' },
			{ ...m, toolCalls: [] },
			{
				...m,
				toolCalls: [
					{ ...m.toolCalls![0]!, function: { name: 'read', arguments: '{"path":"other.txt"}' } },
				],
			},
		])
			expect(toCodexInput([changed], route).some((i) => i.type === 'reasoning')).toBe(false)
		for (const changed of [
			{ ...route, model: 'other' },
			{ ...route, providerId: 'other' },
			{ ...route, chainIndex: 1 },
		]) {
			expect(toCodexInput([m], changed).some((i) => i.type === 'reasoning')).toBe(false)
		}
	})

	it('does not commit replay for a disconnected or incomplete response', async () => {
		for (const terminal of [
			[],
			[{ type: 'response.incomplete', response: { id: 'resp_fixture', output: [reasoning] } }],
		]) {
			const chunks = await collect(providerFor([done(0, reasoning), ...terminal]))
			expect(chunks.some((c) => c.replayState !== undefined || c.finishReason !== undefined)).toBe(
				false,
			)
		}
	})

	it('does not expose a completed replay state after cancellation or failure', async () => {
		const controller = new AbortController()
		const terminal = completed([])
		const cancellation = new Error('operator interrupted')
		const provider = providerFor([done(0, reasoning), terminal], (e) => {
			if (e === terminal) controller.abort(cancellation)
		})
		await expect(collect(provider, controller.signal)).rejects.toBe(cancellation)
		await expect(
			collect(
				providerFor([
					done(0, reasoning),
					{ type: 'response.failed', response: { id: 'resp_fixture' } },
				]),
			),
		).rejects.toThrow('Codex Responses stream failed')
	})

	it('keeps concurrent invocations isolated on a shared provider', async () => {
		let invocation = 0
		const provider = providerFor(() => [
			done(0, { ...reasoning, id: `rs_run${++invocation}` }),
			done(1, message),
			completed([]),
		])
		const results = await Promise.all([collect(provider), collect(provider)])
		for (const [i, chunks] of results.entries())
			expect(chunks.at(-1)?.replayState).toMatchObject({
				items: [{ ...reasoning, id: `rs_run${i + 1}` }, message],
			})
		expect(results[0]!.at(-1)?.replayState).not.toBe(results[1]!.at(-1)?.replayState)
	})
})
