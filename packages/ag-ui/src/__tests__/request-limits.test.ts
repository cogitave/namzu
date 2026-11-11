import { MessageSchema, RunAgentInputSchema } from '@ag-ui/core/schemas'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGUIAdapter, type AGUIAdapterOptions, type AGUITurnContext } from '../adapter.js'
import { AGUIRequestError } from '../errors.js'
import { DEFAULT_REQUEST_LIMITS, parseRunInput, resolveRequestLimits } from '../request.js'

afterEach(() => vi.restoreAllMocks())

const base = { threadId: 't', runId: 'r', state: {}, tools: [], context: [], forwardedProps: {} }

/** A raw JSON body, so a payload of tens of thousands of elements is not built twice. */
const post = (json: string, headers: Record<string, string> = {}) =>
	new Request('https://namzu.test/agent', {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
		body: json,
	})

const repeat = (element: string, count: number) => Array(count).fill(element).join(',')

function adapter(options: Partial<AGUIAdapterOptions> = {}) {
	const createQuery = vi.fn(({ input }: AGUITurnContext) => {
		throw new AGUIRequestError(JSON.stringify(input), 418, 'CAPTURED')
	})
	return { createQuery, adapter: new AGUIAdapter({ createQuery, ...options }) }
}

async function answer(response: Response) {
	return {
		status: response.status,
		body: (await response.json()) as { error: { code: string; message: string } },
	}
}

/** Run a request to the point the host's factory has seen the input, and return it. */
async function received(a: ReturnType<typeof adapter>, json: string) {
	const response = await a.adapter.handle(post(json))
	await response.text()
	return a.createQuery.mock.calls[0]?.[0].input as Record<string, any> | undefined
}

const N = 50_000

describe('what a rejected request can make validation do', () => {
	// The four shapes a reviewer measured at about 1 to 2 GB, scaled to N elements.
	const payloads: Record<string, string> = {
		'messages of bare numbers': `{"threadId":"t","runId":"r","messages":[${repeat('1', N)}]}`,
		'messages of empty objects': `{"threadId":"t","runId":"r","messages":[${repeat('{}', N)}]}`,
		'one message with many empty parts': `{"threadId":"t","runId":"r","messages":[{"id":"u","role":"user","content":[${repeat('{}', N)}]}]}`,
		'many tool messages with no content': `{"threadId":"t","runId":"r","messages":[${repeat('{"role":"tool"}', N)}]}`,
		'tools of empty objects': `{"threadId":"t","runId":"r","messages":[],"tools":[${repeat('{}', N)}]}`,
		'context of empty objects': `{"threadId":"t","runId":"r","messages":[],"context":[${repeat('{}', N)}]}`,
		'resume of empty objects': `{"threadId":"t","runId":"r","messages":[],"resume":[${repeat('{}', N)}]}`,
		'tool calls of empty objects': `{"threadId":"t","runId":"r","messages":[{"id":"a","role":"assistant","toolCalls":[${repeat('{}', N)}]}]}`,
	}

	it.each(Object.entries(payloads))(
		'answers 422 for %s before any schema runs, without echoing it',
		async (_name, json) => {
			const message = vi.spyOn(MessageSchema, 'safeParse')
			const whole = vi.spyOn(RunAgentInputSchema, 'safeParse')
			const { adapter: a, createQuery } = adapter()
			const { status, body } = await answer(await a.handle(post(json as string)))
			expect(status).toBe(422)
			expect(body.error.code).toBe('REQUEST_LIMIT_EXCEEDED')
			expect(body.error.message).toMatch(
				/^AG-UI request has more than \d+ [a-z ]+; raise max\w+ to accept it\.$/,
			)
			expect(message).not.toHaveBeenCalled()
			expect(whole).not.toHaveBeenCalled()
			expect(createQuery).not.toHaveBeenCalled()
		},
	)

	it.each([
		['messages of bare numbers', payloads['messages of bare numbers']],
		['messages of empty objects', payloads['messages of empty objects']],
		['many tool messages with no content', payloads['many tool messages with no content']],
	])(
		'with the count limit raised, %s fail at the first message and the rest are never parsed',
		async (_name, json) => {
			const message = vi.spyOn(MessageSchema, 'safeParse')
			const whole = vi.spyOn(RunAgentInputSchema, 'safeParse')
			const { adapter: a } = adapter({ maxMessages: 1_000_000 })
			const { status, body } = await answer(await a.handle(post(json as string)))
			expect(status).toBe(422)
			expect(body.error).toEqual({
				code: 'INVALID_REQUEST',
				message: 'Invalid AG-UI RunAgentInput.',
			})
			expect(message).toHaveBeenCalledTimes(1)
			expect(whole).not.toHaveBeenCalled()
		},
	)

	it('with the part limit raised, one message of empty parts is still one message parse', async () => {
		const message = vi.spyOn(MessageSchema, 'safeParse')
		const { adapter: a } = adapter({ maxPartsPerMessage: 1_000_000 })
		const { status } = await answer(
			await a.handle(post(payloads['one message with many empty parts'] as string)),
		)
		expect(status).toBe(422)
		expect(message).toHaveBeenCalledTimes(1)
	})

	it('stops at the first invalid message among valid ones', async () => {
		const message = vi.spyOn(MessageSchema, 'safeParse')
		const good = '{"id":"a","role":"user","content":"hi"}'
		const { adapter: a } = adapter()
		const json = `{"threadId":"t","runId":"r","messages":[${good},{"role":"tool"},${repeat(good, 100)}]}`
		expect((await answer(await a.handle(post(json as string)))).status).toBe(422)
		expect(message).toHaveBeenCalledTimes(2)
	})

	it('accepts exactly the limit and refuses one more', async () => {
		const limits = { maxMessages: 3, maxTools: 2, maxContextEntries: 2, maxResumeEntries: 2 }
		const msg = (i: number) => ({ id: `m${i}`, role: 'user', content: 'x' })
		const tool = (i: number) => ({ name: `t${i}`, description: 'd' })
		const context = (i: number) => ({ description: `c${i}`, value: 'v' })
		const resume = (i: number) => ({ interruptId: `i${i}`, status: 'resolved' })
		const at = {
			...base,
			messages: [1, 2, 3].map(msg),
			tools: [1, 2].map(tool),
			context: [1, 2].map(context),
			resume: [1, 2].map(resume),
		}
		const resolved = resolveRequestLimits(limits)
		expect(parseRunInput(at, resolved).messages).toHaveLength(3)
		expect(() => parseRunInput({ ...at, messages: [1, 2, 3, 4].map(msg) }, resolved)).toThrow(
			/messages/,
		)
		expect(() => parseRunInput({ ...at, tools: [1, 2, 3].map(tool) }, resolved)).toThrow(/tools/)
		expect(() => parseRunInput({ ...at, context: [1, 2, 3].map(context) }, resolved)).toThrow(
			/context/,
		)
		expect(() => parseRunInput({ ...at, resume: [1, 2, 3].map(resume) }, resolved)).toThrow(
			/resume/,
		)
		const parts = resolveRequestLimits({ maxPartsPerMessage: 2, maxToolCallsPerMessage: 2 })
		const text = { type: 'text', text: 'x' }
		const withParts = (n: number) => ({
			...base,
			messages: [{ id: 'u', role: 'user', content: Array(n).fill(text) }],
		})
		expect(parseRunInput(withParts(2), parts).messages).toHaveLength(1)
		expect(() => parseRunInput(withParts(3), parts)).toThrow(/content parts/)
		const call = (i: number) => ({
			id: `c${i}`,
			type: 'function',
			function: { name: 'f', arguments: '{}' },
		})
		const calls = (n: number) => ({
			...base,
			messages: [
				{ id: 'a', role: 'assistant', toolCalls: Array.from({ length: n }, (_, i) => call(i)) },
			],
		})
		expect(parseRunInput(calls(2), parts).messages).toHaveLength(1)
		expect(() => parseRunInput(calls(3), parts)).toThrow(/tool calls/)
	})

	it('refuses null, like any other invalid limit, for the new and the older options', () => {
		const cq = () => {
			throw new Error('unused')
		}
		for (const key of [
			...Object.keys(DEFAULT_REQUEST_LIMITS),
			'maxRequestBytes',
			'maxEventBytes',
			'maxPendingEvents',
		]) {
			expect(() => new AGUIAdapter({ createQuery: cq, [key]: null } as never)).toThrow(RangeError)
		}
		expect(
			() => new AGUIAdapter({ createQuery: cq, interrupts: { ttlMs: null } } as never),
		).toThrow(RangeError)
		expect(() => new AGUIAdapter({ createQuery: cq, maxMessages: undefined })).not.toThrow()
	})

	it('rejects invalid limit options', () => {
		for (const key of Object.keys(DEFAULT_REQUEST_LIMITS)) {
			expect(() => resolveRequestLimits({ [key]: 0 })).toThrow(RangeError)
			expect(() => resolveRequestLimits({ [key]: 1.5 })).toThrow(RangeError)
		}
	})
})

describe('the byte cap is checked before anything is parsed', () => {
	it.each([
		['a declared length', { 'content-length': '5000' }],
		['a streamed length with no declaration', {}],
	])(
		'refuses an over-cap body with 413 and never calls JSON.parse or a schema (%s)',
		async (_n, headers) => {
			const parse = vi.spyOn(JSON, 'parse')
			const message = vi.spyOn(MessageSchema, 'safeParse')
			const whole = vi.spyOn(RunAgentInputSchema, 'safeParse')
			const { adapter: a, createQuery } = adapter({ maxRequestBytes: 4096 })
			const json = `{"threadId":"t","runId":"r","messages":[${repeat('1', 5000)}]}`
			const response = await a.handle(post(json, headers))
			expect(response.status).toBe(413)
			expect(parse).not.toHaveBeenCalled()
			expect(message).not.toHaveBeenCalled()
			expect(whole).not.toHaveBeenCalled()
			expect(createQuery).not.toHaveBeenCalled()
		},
	)
})

describe('what the host receives for a valid request', () => {
	const parts = [
		{ type: 'text', text: 'hi' },
		{ type: 'image', source: { type: 'data', value: 'aQ==', mimeType: 'image/png' }, id: 'p1' },
		{
			type: 'image',
			source: { type: 'url', value: 'https://example.com/a.png', mimeType: 'image/png' },
		},
		{
			type: 'audio',
			source: { type: 'file', value: 'file-1', provider: 'openai' },
			metadata: { a: 1 },
		},
		{ type: 'video', source: { type: 'url', value: 'https://example.com/v.mp4' }, extra: true },
		{ type: 'document', source: { type: 'data', value: 'aQ==', mimeType: 'application/pdf' } },
	]
	const call = { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"a":1}' } }
	const valid: Record<string, unknown> = {
		minimal: { threadId: 't', runId: 'r', messages: [] },
		'the existing fixture': {
			threadId: 'external-thread',
			runId: 'external-run',
			messages: [{ id: 'u1', role: 'user', content: 'Hello' }],
			tools: [],
			context: [],
			state: {},
			forwardedProps: {},
		},
		'every part kind, tool calls and every role': {
			...base,
			state: { count: 1 },
			parentRunId: 'p',
			protocolVersion: '1.0',
			messages: [
				{ id: 'd', role: 'developer', content: 'rules', name: 'n' },
				{ id: 's', role: 'system', content: 'sys' },
				{ id: 'u', role: 'user', content: parts, metadata: { k: 'v' }, extraKey: 1 },
				{ id: 'u2', role: 'user', content: 'plain' },
				{ id: 'a', role: 'assistant', content: 'calling', toolCalls: [call], encryptedValue: 'e' },
				{ id: 'a2', role: 'assistant' },
				{ id: 't', role: 'tool', toolCallId: 'c1', content: 'text', error: 'oops' },
				{ id: 't2', role: 'tool', toolCallId: 'c1', content: [parts[0], parts[1], parts[5]] },
				{ id: 'ac', role: 'activity', activityType: 'card', content: { x: 1 } },
				{ id: 'r', role: 'reasoning', content: 'think', encryptedValue: 'e' },
			],
			tools: [{ name: 'pick', description: 'd', parameters: { type: 'object' }, extra: 1 }],
			context: [{ description: 'where', value: 'here', extra: 2 }],
			resume: [{ interruptId: 'i', status: 'resolved', payload: { ok: true } }],
			unknownTopLevel: { nested: [1, 2, 3] },
		},
		'null state and no tools or context': { threadId: 't', runId: 'r', state: null, messages: [] },
		'a falsy state': { threadId: 't', runId: 'r', state: 0, messages: [] },
	}
	const resolved = resolveRequestLimits({})

	it.each(Object.entries(valid))(
		'equals the single whole-request parse, same defaults and keys: %s',
		(_name, value) => {
			const whole = RunAgentInputSchema.safeParse(structuredClone(value))
			expect(whole.success).toBe(true)
			if (!whole.success) return
			expect(parseRunInput(structuredClone(value), resolved)).toStrictEqual(whole.data)
		},
	)

	it('leaves the object the caller handed in as it was, after a parse that succeeds and one that fails', () => {
		const make = () => ({
			...base,
			extra: { a: [1] },
			messages: [{ id: 'u', role: 'user', content: 'hi' }],
		})
		const snapshot = (o: Record<string, unknown>) => ({
			keys: Object.keys(o),
			messages: o.messages,
			json: JSON.stringify(o),
		})
		const ok = make()
		const before = snapshot(ok)
		const out = parseRunInput(ok, resolved)
		expect(snapshot(ok)).toEqual(before)
		expect(ok.messages).toBe(before.messages)
		expect(out).not.toBe(ok)
		expect(out.messages).not.toBe(ok.messages)
		const bad = { ...make(), tools: 'wrong' }
		const badBefore = snapshot(bad)
		expect(() => parseRunInput(bad, resolved)).toThrow('Invalid AG-UI RunAgentInput.')
		expect(snapshot(bad)).toEqual(badBefore)
		expect(bad.messages).toBe(badBefore.messages)
		const badMessage = { ...make(), messages: [{ role: 'tool' }] }
		const badMessageBefore = snapshot(badMessage)
		expect(() => parseRunInput(badMessage, resolved)).toThrow()
		expect(snapshot(badMessage)).toEqual(badMessageBefore)
	})

	it('validates a frozen input and one whose messages is an accessor, leaving both untouched', () => {
		const frozen = Object.freeze({
			...base,
			messages: Object.freeze([{ id: 'u', role: 'user', content: 'hi' }]),
		})
		expect(parseRunInput(frozen, resolved)).toStrictEqual(RunAgentInputSchema.parse(frozen))
		let reads = 0
		const accessor = {
			...base,
			get messages() {
				reads++
				return [{ id: 'u', role: 'user', content: 'hi' }]
			},
		}
		expect(parseRunInput(accessor, resolved).messages).toHaveLength(1)
		expect(Object.getOwnPropertyDescriptor(accessor, 'messages')?.get).toBeTypeOf('function')
		expect(reads).toBeGreaterThan(0)
	})

	it('reaches the host through the HTTP path with the same value', async () => {
		const { resume: _resume, ...value } = valid[
			'every part kind, tool calls and every role'
		] as Record<string, unknown>
		const input = await received(
			adapter({ frontendTools: { allow: ['pick'] } }),
			JSON.stringify(value),
		)
		expect(input).toStrictEqual(RunAgentInputSchema.parse(JSON.parse(JSON.stringify(value))))
	})

	it('keeps fields the protocol does not define, on the request and on each object', async () => {
		const body = {
			...base,
			extraTop: 'a',
			messages: [{ id: 'u', role: 'user', content: 'hi', extraMessage: 'b' }],
			tools: [{ name: 'n', description: 'd', extraTool: 'c' }],
			context: [{ description: 'd', value: 'v', extraContext: 'e' }],
		}
		const input = await received(adapter({ frontendTools: { allow: ['n'] } }), JSON.stringify(body))
		expect(input).toMatchObject(body)
	})

	it('drops a __proto__ key from every object and pollutes nothing', async () => {
		const json =
			'{"threadId":"t","runId":"r","__proto__":{"admin":true},' +
			'"messages":[{"id":"u","role":"user","content":"hi","__proto__":{"polluted":true}}],' +
			'"tools":[{"name":"n","description":"d","__proto__":{"t":1}}],' +
			'"context":[{"description":"d","value":"v","__proto__":{"c":1}}]}'
		const input = (await received(adapter({ frontendTools: { allow: ['n'] } }), json)) as Record<
			string,
			any
		>
		for (const object of [input, input.messages[0], input.tools[0], input.context[0]]) {
			expect(Object.getPrototypeOf(object)).toBe(Object.prototype)
			expect(Object.getOwnPropertyNames(object)).not.toContain('__proto__')
			expect(object.admin).toBeUndefined()
			expect(object.polluted).toBeUndefined()
		}
		expect(({} as Record<string, unknown>).admin).toBeUndefined()
		expect(({} as Record<string, unknown>).polluted).toBeUndefined()
	})
})
