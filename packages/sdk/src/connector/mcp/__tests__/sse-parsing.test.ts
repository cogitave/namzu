import { afterEach, describe, expect, it, vi } from 'vitest'

import { StreamableHttpTransport, parseSseMessages } from '../streamable-http.js'

/**
 * W8: the one genuinely new piece of SSE work — event-`id` capture, used
 * only to arm a legacy `Last-Event-ID` reconnect — plus explicit coverage
 * that a `:`-prefixed comment line was, and remains, ignored rather than
 * treated as malformed.
 *
 * The parser was already correct on three counts before this: `data:` with
 * or without a leading space, multi-line data joined with `\n`, and the
 * empty-data priming event skipped as a message. Those are re-asserted here
 * alongside the new behaviour so a future change to this function has one
 * place that describes all of it.
 */
describe('parseSseMessages', () => {
	it('skips the empty-data priming event as a message but records its id', () => {
		const raw = ['id: e1', 'data:', '', 'data: {"jsonrpc":"2.0","id":1,"result":{}}', ''].join('\n')

		const result = parseSseMessages(raw)

		expect(result.messages).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }])
		expect(result.lastEventId).toBe('e1')
	})

	it('ignores a `:`-prefixed comment line rather than treating it as malformed', () => {
		const raw = [': keep-alive', 'data: {"jsonrpc":"2.0","id":1,"result":{}}', ''].join('\n')

		expect(() => parseSseMessages(raw)).not.toThrow()
		expect(parseSseMessages(raw).messages).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }])
	})

	it('ignores a comment-only event entirely: no message, no id', () => {
		const raw = ': just a keep-alive\n\n'

		const result = parseSseMessages(raw)

		expect(result.messages).toEqual([])
		expect(result.lastEventId).toBeUndefined()
	})

	it('parses `data:` with zero, one and two leading spaces', () => {
		const raw = [
			'data:{"jsonrpc":"2.0","id":1,"result":"zero"}',
			'',
			'data: {"jsonrpc":"2.0","id":2,"result":"one"}',
			'',
			'data:  {"jsonrpc":"2.0","id":3,"result":"two"}',
			'',
		].join('\n')

		const result = parseSseMessages(raw)

		expect(result.messages.map((m) => m.result)).toEqual(['zero', 'one', 'two'])
	})

	it('joins multi-line data with a newline', () => {
		// The join is what makes this valid JSON at all: without the `\n`
		// between the two `data:` lines, "1," and "\"result\"" would run
		// together into one unparseable token.
		const raw = ['data: {"jsonrpc":"2.0","id":1,', 'data: "result":"ok"}', ''].join('\n')

		const result = parseSseMessages(raw)

		expect(result.messages).toEqual([{ jsonrpc: '2.0', id: 1, result: 'ok' }])
	})

	it('remembers the id from the last event that carried one, when a later event carries none', () => {
		const raw = [
			'id: e1',
			'data: {"jsonrpc":"2.0","id":1,"result":"first"}',
			'',
			'data: {"jsonrpc":"2.0","id":2,"result":"second"}',
			'',
		].join('\n')

		expect(parseSseMessages(raw).lastEventId).toBe('e1')
	})

	it('updates the id when a later event carries a new one', () => {
		const raw = [
			'id: e1',
			'data: {"jsonrpc":"2.0","id":1,"result":"first"}',
			'',
			'id: e2',
			'data: {"jsonrpc":"2.0","id":2,"result":"second"}',
			'',
		].join('\n')

		expect(parseSseMessages(raw).lastEventId).toBe('e2')
	})

	it('still skips the empty-data priming event and the [DONE] sentinel as messages', () => {
		const raw = [
			'data:',
			'',
			'data: [DONE]',
			'',
			'data: {"jsonrpc":"2.0","id":1,"result":1}',
			'',
		].join('\n')

		expect(parseSseMessages(raw).messages).toEqual([{ jsonrpc: '2.0', id: 1, result: 1 }])
	})
})

/**
 * `Last-Event-ID` is gated exactly the way `Mcp-Session-Id` itself is: both
 * live behind `if (this.sessionId)` in `buildHeaders()`. A modern connection
 * never sends `initialize` (`MCPClient` probes with `server/discover`
 * instead — see `client.ts`'s `probeDiscover`), so it never captures a
 * session id, and therefore never reaches the `Last-Event-ID` branch either
 * — structurally, not by a second era flag threaded through the transport.
 */
describe('Last-Event-ID resumption (Streamable HTTP transport)', () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('arms Last-Event-ID on the request after a reconnect, once a fresh session exists to carry it', async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			// 1. initialize -> session sid_old
			.mockResolvedValueOnce(
				new Response(null, { status: 204, headers: { 'mcp-session-id': 'sid_old' } }),
			)
			// 2. tools/list -> an SSE body carrying an event id
			.mockResolvedValueOnce(
				new Response(
					'id: e1\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n',
					{ status: 200, headers: { 'content-type': 'text/event-stream' } },
				),
			)
			// 3. the best-effort session DELETE close() sends
			.mockResolvedValueOnce(new Response(null, { status: 204 }))
			// 4. the reconnect's fresh initialize -> a NEW session
			.mockResolvedValueOnce(
				new Response(null, { status: 204, headers: { 'mcp-session-id': 'sid_new' } }),
			)
			// 5. the next request on the new session
			.mockResolvedValueOnce(new Response(null, { status: 204 }))
		vi.stubGlobal('fetch', fetchMock)

		const transport = new StreamableHttpTransport({
			type: 'streamable-http',
			url: 'https://mcp.example.test/rpc',
		})
		await transport.connect()
		await transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
		await transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
		await transport.close()
		await transport.connect()
		await transport.send({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} })
		await transport.send({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} })

		// Not on the fresh initialize itself — the new session doesn't exist
		// yet when that request goes out.
		const freshInitialize = fetchMock.mock.calls[3]
		expect(
			(freshInitialize?.[1]?.headers as Record<string, string> | undefined)?.['Last-Event-ID'],
		).toBeUndefined()

		const finalRequest = fetchMock.mock.calls.at(-1)
		const headers = finalRequest?.[1]?.headers as Record<string, string> | undefined
		expect(headers?.['Mcp-Session-Id']).toBe('sid_new')
		expect(headers?.['Last-Event-ID']).toBe('e1')
	})

	it('never sends Last-Event-ID when no session was ever established (the modern shape)', async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(
					'id: e9\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n',
					{ status: 200, headers: { 'content-type': 'text/event-stream' } },
				),
			)
			.mockResolvedValueOnce(new Response(null, { status: 204 }))
		vi.stubGlobal('fetch', fetchMock)

		const transport = new StreamableHttpTransport({
			type: 'streamable-http',
			url: 'https://mcp.example.test/rpc',
		})
		await transport.connect()
		// A modern connection never sends `initialize`, so this transport
		// never captures a session id at all — the structural reason it
		// cannot reach the Last-Event-ID branch, event id captured or not.
		await transport.send({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} })
		await transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })

		const lastCall = fetchMock.mock.calls.at(-1)
		const headers = lastCall?.[1]?.headers as Record<string, string> | undefined
		expect(headers?.['Last-Event-ID']).toBeUndefined()
		expect(headers?.['Mcp-Session-Id']).toBeUndefined()
	})
})
