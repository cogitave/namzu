import { describe, expect, it, vi } from 'vitest'
import { AGUIAdapter, type AGUIRunContext } from '../adapter.js'
import { AGUIRequestError } from '../errors.js'
import { toNamzuMessages } from '../messages.js'

const input = {
	threadId: 'external-thread',
	runId: 'external-run',
	messages: [{ id: 'u1', role: 'user', content: 'Hello' }],
	tools: [],
	context: [],
	state: {},
	forwardedProps: {},
}

const request = (body: unknown = input, headers: Record<string, string> = {}) =>
	new Request('https://namzu.test/agent', {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify(body),
	})

describe('AG-UI HTTP admission', () => {
	it('returns 422 when host message admission rejects client history', async () => {
		const onError = vi.fn()
		const createQuery = vi.fn(({ input: received }: AGUIRunContext) => {
			toNamzuMessages(received.messages)
			throw new Error('invalid history must not reach query creation')
		})
		const response = await new AGUIAdapter({ createQuery, onError }).handle(
			request({
				...input,
				messages: [{ id: 'private-id', role: 'system', content: 'private client instructions' }],
			}),
		)
		expect(createQuery).toHaveBeenCalledOnce()
		expect(response.status).toBe(422)
		expect(await response.json()).toEqual({
			error: {
				code: 'INVALID_MESSAGE_HISTORY',
				message: 'Cannot convert AG-UI history: system messages require allowSystemMessages: true',
			},
		})
		expect(onError).not.toHaveBeenCalled()
	})

	it.each([
		[new Request('https://namzu.test/agent'), 405],
		[request(input, { 'content-type': 'text/plain' }), 415],
		[request(input, { accept: 'application/x-protobuf' }), 406],
		[request(input, { accept: 'text/event-stream;q=0' }), 406],
		[request(input, { accept: '*/*;q=1, text/event-stream;q=0' }), 406],
		[request({ ...input, runId: '' }), 422],
		[request({ ...input, messages: 'wrong' }), 422],
		[
			request({
				...input,
				tools: [{ name: 'browser_tool', description: 'Run in browser', parameters: {} }],
			}),
			422,
		],
		[request({ ...input, resume: [{ interruptId: 'approval', payload: true }] }), 422],
	])('refuses unsupported requests before creating a run (%s)', async (incoming, status) => {
		const createQuery = vi.fn(() => {
			throw new Error('must not run')
		})
		const response = await new AGUIAdapter({ createQuery }).handle(incoming)
		expect(response.status).toBe(status)
		expect(createQuery).not.toHaveBeenCalled()
		if (status === 405) expect(response.headers.get('allow')).toBe('POST')
	})

	it('bounds actual UTF-8 body bytes when content-length is absent or false', async () => {
		const createQuery = vi.fn(() => {
			throw new Error('must not run')
		})
		const adapter = new AGUIAdapter({ createQuery, maxRequestBytes: 64 })
		const response = await adapter.handle(
			request({ text: '😀'.repeat(40) }, { 'content-length': '1' }),
		)
		expect(response.status).toBe(413)
		expect(createQuery).not.toHaveBeenCalled()
	})

	it('rejects identities that cannot fit in a lifecycle event before invoking the host', async () => {
		const createQuery = vi.fn(() => {
			throw new Error('must not run')
		})
		const response = await new AGUIAdapter({ createQuery, maxEventBytes: 256 }).handle(
			request({ ...input, threadId: 'x'.repeat(500) }),
		)
		expect(response.status).toBe(422)
		expect(createQuery).not.toHaveBeenCalled()
	})

	it('rejects invalid UTF-8 instead of silently replacing message content', async () => {
		const createQuery = vi.fn(() => {
			throw new Error('must not run')
		})
		const bytes = new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])
		const response = await new AGUIAdapter({ createQuery }).handle(
			new Request('https://namzu.test/agent', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: bytes,
			}),
		)
		expect(response.status).toBe(400)
		expect(createQuery).not.toHaveBeenCalled()
	})

	it('rejects oversized initial state before invoking the host', async () => {
		const createQuery = vi.fn(() => {
			throw new Error('must not run')
		})
		const onError = vi.fn()
		const response = await new AGUIAdapter({ createQuery, onError, maxEventBytes: 256 }).handle(
			request({ ...input, state: { text: '😀'.repeat(100) } }),
		)
		expect(response.status).toBe(422)
		expect(createQuery).not.toHaveBeenCalled()
		expect(onError).not.toHaveBeenCalled()
	})

	it('returns explicit host refusal but hides unexpected setup errors', async () => {
		const forbidden = await new AGUIAdapter({
			createQuery: () => {
				throw new AGUIRequestError('Thread access denied.', 403, 'FORBIDDEN')
			},
		}).handle(request())
		expect(forbidden.status).toBe(403)
		expect(await forbidden.json()).toEqual({
			error: { code: 'FORBIDDEN', message: 'Thread access denied.' },
		})
		const error = new Error('secret credential /private/path')
		const onError = vi.fn()
		const failed = await new AGUIAdapter({
			createQuery: () => {
				throw error
			},
			onError,
		}).handle(request())
		expect(failed.status).toBe(500)
		expect(await failed.text()).not.toContain('secret')
		expect(onError).toHaveBeenCalledWith(error)
	})

	it('rejects malformed JSON without invoking the host', async () => {
		const createQuery = vi.fn(() => {
			throw new Error('must not run')
		})
		const malformed = new Request('https://namzu.test/agent', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{',
		})
		expect((await new AGUIAdapter({ createQuery }).handle(malformed)).status).toBe(400)
		expect(createQuery).not.toHaveBeenCalled()
	})

	it('cancels a stalled request body before any run is admitted', async () => {
		const createQuery = vi.fn(() => {
			throw new Error('must not run')
		})
		const abort = new AbortController()
		const canceled = vi.fn()
		const incoming = new Request('https://namzu.test/agent', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: new ReadableStream({ cancel: canceled }),
			signal: abort.signal,
			duplex: 'half',
		} as RequestInit)
		const pending = new AGUIAdapter({ createQuery }).handle(incoming)
		abort.abort()
		await pending
		expect(canceled).toHaveBeenCalledOnce()
		expect(createQuery).not.toHaveBeenCalled()
	})
})
