import { trace } from '@opentelemetry/api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientFor, fakeMcpServer } from '../__fixtures__/fake-mcp-server.js'

const TRACE_ID = 'a'.repeat(32)
const SPAN_ID = 'b'.repeat(16)

function activeSpan(spanContext: Record<string, unknown>) {
	vi.spyOn(trace, 'getSpan').mockReturnValue({
		spanContext: () => spanContext,
	} as unknown as ReturnType<typeof trace.getSpan>)
}

async function callOnce(revision: 'newest' | 'previous') {
	const server = fakeMcpServer({
		revision,
		handlers: { 'tools/call': () => ({ result: { resultType: 'complete', content: [] } }) },
	})
	const client = clientFor(server)
	await client.connect()
	await client.callTool('t', {})
	const [call] = server.requestsFor('tools/call')
	await client.disconnect()
	return { call, server }
}

describe('trace context in _meta', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('carries traceparent and tracestate on a newest-revision request when a span is active', async () => {
		activeSpan({
			traceId: TRACE_ID,
			spanId: SPAN_ID,
			traceFlags: 1,
			traceState: { serialize: () => 'vendor=1' },
		})
		const { call } = await callOnce('newest')
		const meta = call?.params?._meta as Record<string, unknown>
		expect(meta.traceparent).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`)
		expect(meta.tracestate).toBe('vendor=1')
		// The protocol's own keys are still there beside it.
		expect(meta['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28')
	})

	it('sends nothing of the kind when telemetry is off', async () => {
		const { call } = await callOnce('newest')
		const meta = call?.params?._meta as Record<string, unknown>
		expect(
			Object.keys(meta).filter((k) => ['traceparent', 'tracestate', 'baggage'].includes(k)),
		).toEqual([])
	})

	it('sends nothing for a span context that is not valid W3C', async () => {
		activeSpan({ traceId: '0'.repeat(32), spanId: SPAN_ID, traceFlags: 1 })
		const { call } = await callOnce('newest')
		expect((call?.params?._meta as Record<string, unknown>).traceparent).toBeUndefined()
	})

	it('leaves a previous-revision request exactly as it was, span or not', async () => {
		activeSpan({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1 })
		const { call } = await callOnce('previous')
		expect(call?.params?._meta).toBeUndefined()
	})

	it('carries it on a read as on a call', async () => {
		activeSpan({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1 })
		const server = fakeMcpServer({
			revision: 'newest',
			handlers: { 'resources/read': () => ({ result: { resultType: 'complete', contents: [] } }) },
		})
		const client = clientFor(server)
		await client.connect()
		await client.readResource('file:///x')
		const [read] = server.requestsFor('resources/read')
		expect((read?.params?._meta as Record<string, unknown>).traceparent).toBe(
			`00-${TRACE_ID}-${SPAN_ID}-01`,
		)
		await client.disconnect()
	})
})
