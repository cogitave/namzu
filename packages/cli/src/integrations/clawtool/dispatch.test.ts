import { describe, expect, it, vi } from 'vitest'

import { type DispatchEvent, sendMessage } from './dispatch.js'

/** Build a Response that streams `lines` as NDJSON. */
function ndjsonResponse(lines: readonly string[]): Response {
	const body = `${lines.join('\n')}\n`
	return new Response(body, {
		status: 200,
		headers: { 'content-type': 'application/x-ndjson' },
	})
}

async function collect(it: AsyncIterable<DispatchEvent>): Promise<DispatchEvent[]> {
	const out: DispatchEvent[] = []
	for await (const ev of it) out.push(ev)
	return out
}

describe('sendMessage', () => {
	it('issues POST /v1/send_message with the right body + headers', async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(ndjsonResponse(['{"text":"hi"}']))
		await collect(
			sendMessage({
				endpoint: 'http://localhost:9999',
				token: 'tok',
				instance: 'claude',
				prompt: 'hello',
				fetch: fetchMock,
			}),
		)
		const call = fetchMock.mock.calls[0]
		expect(call?.[0]).toBe('http://localhost:9999/v1/send_message')
		expect(call?.[1]?.method).toBe('POST')
		const headers = call?.[1]?.headers as Record<string, string>
		expect(headers['Content-Type']).toBe('application/json')
		expect(headers.Authorization).toBe('Bearer tok')
		expect(JSON.parse(String(call?.[1]?.body))).toEqual({
			instance: 'claude',
			prompt: 'hello',
		})
	})

	it('extracts `text` from each NDJSON line and ends with done', async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(ndjsonResponse(['{"text":"hel"}', '{"text":"lo"}']))
		const events = await collect(
			sendMessage({
				endpoint: 'http://localhost:9999',
				token: '',
				instance: 'claude',
				prompt: 'x',
				fetch: fetchMock,
			}),
		)
		expect(events).toEqual([
			{ kind: 'delta', text: 'hel' },
			{ kind: 'delta', text: 'lo' },
			{ kind: 'done' },
		])
	})

	it('handles Anthropic-shaped content_block_delta frames', async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				ndjsonResponse([
					'{"type":"content_block_delta","delta":{"text":"foo"}}',
					'{"type":"message_stop"}',
				]),
			)
		const events = await collect(
			sendMessage({
				endpoint: 'http://localhost:9999',
				token: '',
				instance: 'claude',
				prompt: 'x',
				fetch: fetchMock,
			}),
		)
		expect(events).toEqual([{ kind: 'delta', text: 'foo' }, { kind: 'done' }])
	})

	it('handles OpenAI-shaped choices[0].delta.content frames', async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(ndjsonResponse(['{"choices":[{"delta":{"content":"hi"}}]}']))
		const events = await collect(
			sendMessage({
				endpoint: 'http://localhost:9999',
				token: '',
				instance: 'codex',
				prompt: 'x',
				fetch: fetchMock,
			}),
		)
		expect(events[0]).toEqual({ kind: 'delta', text: 'hi' })
	})

	it('falls back to plain-text passthrough for non-JSON lines', async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(ndjsonResponse(['raw text line']))
		const events = await collect(
			sendMessage({
				endpoint: 'http://localhost:9999',
				token: '',
				instance: 'aider',
				prompt: 'x',
				fetch: fetchMock,
			}),
		)
		expect(events[0]).toEqual({ kind: 'delta', text: 'raw text line\n' })
	})

	it('surfaces an in-band `error` field as an error event', async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(ndjsonResponse(['{"error":"upstream crashed"}']))
		const events = await collect(
			sendMessage({
				endpoint: 'http://localhost:9999',
				token: '',
				instance: 'claude',
				prompt: 'x',
				fetch: fetchMock,
			}),
		)
		expect(events[0]).toEqual({ kind: 'error', message: 'upstream crashed' })
	})

	it('translates non-2xx into an error event including HTTP code', async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({ error: 'instance not callable' }), {
				status: 400,
				headers: { 'content-type': 'application/json' },
			}),
		)
		const events = await collect(
			sendMessage({
				endpoint: 'http://localhost:9999',
				token: '',
				instance: 'aider',
				prompt: 'x',
				fetch: fetchMock,
			}),
		)
		expect(events[0]).toEqual({
			kind: 'error',
			message: 'clawtool /v1/send_message HTTP 400: instance not callable',
		})
	})

	it('omits the Bearer header when the token is empty', async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(ndjsonResponse([]))
		await collect(
			sendMessage({
				endpoint: 'http://localhost:9999',
				token: '',
				instance: 'claude',
				prompt: 'x',
				fetch: fetchMock,
			}),
		)
		const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>
		expect(headers.Authorization).toBeUndefined()
	})
})
