import { describe, expect, it } from 'vitest'

import { ProviderRequestError } from '../../../provider/errors.js'
import {
	createAssistantMessage,
	createToolMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import type { Message } from '../../../types/message/index.js'
import type {
	ChatCompletionParams,
	LLMProvider,
	StreamChunk,
} from '../../../types/provider/index.js'
import {
	MAX_REPAIRS_PER_REQUEST,
	RequestRepair,
	classifyRequestRejection,
} from '../iteration/request-repair.js'

const USAGE = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}
const call = { id: 'call_1', type: 'function' as const, function: { name: 'x', arguments: '{}' } }

function provider(reject: (p: ChatCompletionParams) => string | undefined, status = 400) {
	const requests: ChatCompletionParams[] = []
	const fake: LLMProvider & { id: string } = {
		id: 'fake',
		name: 'Fake',
		async *chatStream(params): AsyncIterable<StreamChunk> {
			requests.push(params)
			const detail = reject(params)
			if (detail !== undefined) {
				throw new ProviderRequestError({
					kind: 'bad_request',
					providerId: 'fake',
					status,
					detail,
				})
			}
			yield { id: 'a', delta: { content: 'ok' } }
			yield { id: 'a', delta: {}, finishReason: 'stop', usage: USAGE }
		},
	}
	return { fake, requests }
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<void> {
	for await (const _ of stream) {
		// drained
	}
}

const base = (messages: ChatCompletionParams['messages']): ChatCompletionParams => ({
	model: 'm1',
	messages,
})

describe('tool pairing before every send', () => {
	const dangling = (): Message[] => [
		createUserMessage('go'),
		createAssistantMessage('calling', [call]),
		createUserMessage('next'),
	]

	it('gives an unanswered call a result before the first send, without a rejection', async () => {
		const { fake, requests } = provider(() => undefined)
		const messages = dangling()
		await drain(new RequestRepair().stream(fake, base(messages)))
		expect(requests).toHaveLength(1)
		expect(requests[0]?.messages.some((m) => m.role === 'tool')).toBe(true)
		// Stored history is untouched.
		expect(messages.some((m) => m.role === 'tool')).toBe(false)
	})

	it('removes an orphan result', async () => {
		const { fake, requests } = provider(() => undefined)
		await drain(
			new RequestRepair().stream(
				fake,
				base([
					createUserMessage('go'),
					createToolMessage('stray', 'call_x'),
					createUserMessage('n'),
				]),
			),
		)
		expect(requests[0]?.messages.some((m) => m.role === 'tool')).toBe(false)
	})
})

describe('what is retried', () => {
	it('leaves an unrelated 400 alone', async () => {
		const { fake, requests } = provider(() => 'messages: text content blocks must be non-empty')
		await expect(
			drain(new RequestRepair().stream(fake, base([createUserMessage('hi')]))),
		).rejects.toBeInstanceOf(ProviderRequestError)
		expect(requests).toHaveLength(1)
	})

	it('does not repeat a repair that did not help', async () => {
		const { fake, requests } = provider(() => 'Unsupported value: temperature does not support 0.2')
		await expect(
			drain(
				new RequestRepair().stream(fake, { ...base([createUserMessage('hi')]), temperature: 0.2 }),
			),
		).rejects.toBeInstanceOf(ProviderRequestError)
		// One resend without the parameter; the second rejection names nothing left to drop.
		expect(requests).toHaveLength(2)
	})

	it('remembers a refused parameter for the route, so later sends do not fail first', async () => {
		const { fake, requests } = provider((p) =>
			p.effort !== undefined ? "Unsupported parameter: 'reasoning_effort'" : undefined,
		)
		const repair = new RequestRepair()
		await drain(repair.stream(fake, { ...base([createUserMessage('a')]), effort: 'high' }))
		await drain(repair.stream(fake, { ...base([createUserMessage('b')]), effort: 'high' }))
		expect(requests.map((r) => r.effort)).toEqual(['high', undefined, undefined])
		// Another model is asked again.
		await drain(
			repair.stream(fake, { ...base([createUserMessage('c')]), model: 'm2', effort: 'high' }),
		)
		expect(requests[3]?.effort).toBe('high')
	})

	it('does not resend once output has begun', async () => {
		let sent = 0
		const fake: LLMProvider = {
			id: 'fake',
			name: 'Fake',
			async *chatStream(): AsyncIterable<StreamChunk> {
				sent++
				yield { id: 'a', delta: { content: 'partial' } }
				throw new ProviderRequestError({
					kind: 'bad_request',
					providerId: 'fake',
					status: 400,
					detail: 'Invalid `signature` in `thinking` block',
				})
			},
		}
		await expect(
			drain(new RequestRepair().stream(fake, base([createUserMessage('hi')]))),
		).rejects.toBeInstanceOf(ProviderRequestError)
		expect(sent).toBe(1)
	})
})

describe('classifyRequestRejection', () => {
	const params = { ...base([]), temperature: 0.1, effort: 'low' as const }
	const reject = (detail: string, providerCode?: string) =>
		new ProviderRequestError({
			kind: 'bad_request',
			providerId: 'p',
			status: 400,
			detail,
			...(providerCode ? { providerCode } : {}),
		})

	it.each([
		['Invalid `signature` in `thinking` block', undefined, 'reasoning'],
		['Corrupted thought signature.', undefined, 'reasoning'],
		[
			"Item 'rs_123' of type 'reasoning' was provided without its required following item.",
			undefined,
			'reasoning',
		],
		['bad', 'invalid_encrypted_content', 'reasoning'],
		[
			'`tool_use` ids were found without `tool_result` blocks immediately after: call_1',
			undefined,
			'tool-pairing',
		],
		[
			"messages with role 'tool' must be a response to a preceeding message with 'tool_calls'",
			undefined,
			'tool-pairing',
		],
		[
			'Expected toolResult blocks at messages.2.content for the following Ids: call_1',
			undefined,
			'tool-pairing',
		],
		['image exceeds 5 MB maximum', undefined, 'media'],
		[
			'Request rejected as unprocessable by the model (too many or oversized images)',
			undefined,
			'media',
		],
		['bad', 'invalid_image', 'media'],
		["'temperature' is deprecated for this model", undefined, 'parameter'],
	])('%s -> %s', (detail, code, kind) => {
		expect(classifyRequestRejection(reject(detail, code), params)?.kind).toBe(kind)
	})

	it('ignores a context overflow, an auth failure and a non-400', () => {
		const overflow = new ProviderRequestError({
			kind: 'context_overflow',
			providerId: 'p',
			status: 400,
		})
		const server = new ProviderRequestError({ kind: 'server', providerId: 'p', status: 500 })
		expect(classifyRequestRejection(overflow, params)).toBeNull()
		expect(classifyRequestRejection(server, params)).toBeNull()
		expect(classifyRequestRejection(new Error('boom'), params)).toBeNull()
	})

	it('does not name a parameter the request never set', () => {
		expect(classifyRequestRejection(reject('top_p is not supported'), { ...base([]) })).toBeNull()
	})
})

// ---------------------------------------------------------------------------
// What a repair may teach the run: only what a resend without it confirmed.
// ---------------------------------------------------------------------------

const img = (tag: string) => ({ data: `D${tag}`, mediaType: 'image/png' })
const toolCall = (id: string) => ({
	id,
	type: 'function' as const,
	function: { name: 'x', arguments: '{}' },
})
const stepContext = (): Message => ({
	...createUserMessage('ctx'),
	source: { type: 'runtime-context', kind: 'step-context' },
})
const wireText = (p: ChatCompletionParams | undefined) => JSON.stringify(p?.messages)

describe('a thinking-enabled tool loop after reasoning is rejected', () => {
	const turn = (reasoned: boolean): Message[] => [
		createUserMessage('hi'),
		{
			...createAssistantMessage(
				'',
				[toolCall('t1')],
				reasoned ? [{ type: 'thinking', text: 'a', signature: 'SIG' }] : undefined,
			),
			...(reasoned
				? {
						source: {
							type: 'model',
							providerId: 'fake',
							model: 'm',
							chainIndex: 0,
							replayState: { k: 1 },
						},
					}
				: {}),
		} as Message,
		createToolMessage('r', 't1'),
	]
	const hasReasoning = (p: ChatCompletionParams) =>
		p.messages.some((m) => m.role === 'assistant' && m.reasoning !== undefined)

	it('drops thinking with the reasoning, and both stay off for the next tool turn', async () => {
		const { fake, requests } = provider((p) =>
			hasReasoning(p)
				? 'messages.1.content.0: Invalid `signature` in `thinking` block'
				: p.thinking
					? 'messages.1.content.0.tool_use: Expected `thinking` or `redacted_thinking`, but found `tool_use`'
					: undefined,
		)
		const repair = new RequestRepair()
		const thinking = { type: 'enabled' as const, budgetTokens: 2000 }
		await drain(repair.stream(fake, { ...base(turn(true)), thinking }))
		expect(requests).toHaveLength(2)
		expect(requests[1]?.thinking).toBeUndefined()
		expect(hasReasoning(requests[1] as ChatCompletionParams)).toBe(false)
		// The next tool turn goes out clean on the first try.
		await drain(repair.stream(fake, { ...base(turn(false)), thinking }))
		expect(requests).toHaveLength(3)
		expect(requests[2]?.thinking).toBeUndefined()
	})

	it('remembers nothing when the strip did not fix the request', async () => {
		const { fake, requests } = provider(() => 'Invalid `signature` in `thinking` block')
		const repair = new RequestRepair()
		await expect(drain(repair.stream(fake, base(turn(true))))).rejects.toBeInstanceOf(
			ProviderRequestError,
		)
		const before = requests.length
		const ok = provider(() => undefined)
		await drain(repair.stream(ok.fake, base(turn(true))))
		expect(hasReasoning(ok.requests[0] as ChatCompletionParams)).toBe(true)
		expect(before).toBe(2)
	})
})

describe('which wire index names which message', () => {
	const history = (): Message[] => [
		createUserMessage('a'),
		createAssistantMessage('', [toolCall('a')]),
		createToolMessage([{ type: 'image', ...img('A') }], 'a'),
		stepContext(),
		createAssistantMessage('', [toolCall('b')]),
		createToolMessage([{ type: 'image', ...img('B') }], 'b'),
		stepContext(),
		createAssistantMessage('', [toolCall('c')]),
		createToolMessage([{ type: 'image', ...img('C') }], 'c'),
	]
	const badMiddle = (p: ChatCompletionParams) =>
		wireText(p).includes('DB')
			? 'messages.5.content.0.tool_result.content.0.image.source.base64: image cannot be processed'
			: undefined

	it('strips only the rejected tool image on the Anthropic wire, with steps between', async () => {
		const { fake, requests } = provider(badMiddle)
		fake.id = 'anthropic'
		await drain(new RequestRepair().stream(fake, base(history())))
		const last = wireText(requests.at(-1))
		expect(requests).toHaveLength(2)
		expect(last).toContain('DA')
		expect(last).not.toContain('DB')
		expect(last).toContain('DC')
	})

	it('does not trust an index on a wire it does not know, and still ends with the good images kept where it can', async () => {
		const { fake, requests } = provider(badMiddle)
		await drain(new RequestRepair().stream(fake, base(history())))
		expect(wireText(requests.at(-1))).not.toContain('DB')
		expect(wireText(requests.at(-1))).toContain('DA')
	})

	it('reads an OpenAI-style index as one entry per message, system included', async () => {
		const messages: Message[] = [
			{ role: 'system', content: 'be brief', timestamp: 0 } as Message,
			createUserMessage('look', [img('P')]),
			createAssistantMessage('seen'),
			createUserMessage('and', [img('Q')]),
		]
		const { fake, requests } = provider((p) =>
			wireText(p).includes('DP')
				? 'messages[1].content[1].image_url: invalid image data, cannot be processed'
				: undefined,
		)
		fake.id = 'openai'
		await drain(new RequestRepair().stream(fake, base(messages)))
		expect(wireText(requests.at(-1))).not.toContain('DP')
		expect(wireText(requests.at(-1))).toContain('DQ')
	})
})

describe('a guess that did not fix the request is forgotten', () => {
	const user = () => [createUserMessage('hi')]

	it('does not drop a parameter named only inside a tool schema', async () => {
		const { fake, requests } = provider(
			() => 'tools.2.custom.input_schema.properties.temperature: invalid type',
		)
		const repair = new RequestRepair()
		await expect(
			drain(repair.stream(fake, { ...base(user()), temperature: 0.2 })),
		).rejects.toBeInstanceOf(ProviderRequestError)
		expect(requests).toHaveLength(1)
		const next = provider(() => undefined)
		await drain(repair.stream(next.fake, { ...base(user()), temperature: 0.2 }))
		expect(next.requests[0]?.temperature).toBe(0.2)
	})

	it('does not latch a parameter whose removal the provider still rejected', async () => {
		const { fake } = provider(() => 'Unsupported parameter: temperature is not supported')
		const repair = new RequestRepair()
		await expect(
			drain(repair.stream(fake, { ...base(user()), temperature: 0.2 })),
		).rejects.toBeInstanceOf(ProviderRequestError)
		const next = provider(() => undefined)
		await drain(repair.stream(next.fake, { ...base(user()), temperature: 0.2 }))
		expect(next.requests[0]?.temperature).toBe(0.2)
	})

	it('does not remember media a provider went on rejecting after it was removed', async () => {
		const { fake } = provider(() => 'image could not be processed')
		const repair = new RequestRepair()
		const withImage = () => [
			createUserMessage('old', [img('Y')]),
			createAssistantMessage('seen'),
			createUserMessage('look', [img('Z')]),
		]
		await expect(drain(repair.stream(fake, base(withImage())))).rejects.toBeInstanceOf(
			ProviderRequestError,
		)
		const next = provider(() => undefined)
		await drain(repair.stream(next.fake, base(withImage())))
		expect(wireText(next.requests[0])).toContain('DZ')
	})

	it('learns once a resend is accepted', async () => {
		const { fake, requests } = provider((p) =>
			wireText(p).includes('DZ') ? 'image could not be processed' : undefined,
		)
		const repair = new RequestRepair()
		const withImage = () => [
			createUserMessage('old', [img('Y')]),
			createAssistantMessage('seen'),
			createUserMessage('look', [img('Z')]),
		]
		await drain(repair.stream(fake, base(withImage())))
		await drain(repair.stream(fake, base(withImage())))
		expect(requests).toHaveLength(3)
		expect(wireText(requests[2])).not.toContain('DZ')
	})
})

describe('media wording that is not about media', () => {
	const withImage = (): Message[] => [
		createUserMessage('old', [img('Y')]),
		createAssistantMessage('seen'),
		createUserMessage('look', [img('Z')]),
	]
	it.each([
		['a 422 about a tool schema', 'tools.0.input_schema: must be an object', 422],
		['a bare 413', 'Request Entity Too Large', 413],
		[
			'a document word in a schema error',
			'document is invalid: field limit exceeded in schema',
			400,
		],
	])('leaves %s alone and keeps the attachment', async (_name, detail, status) => {
		const { fake, requests } = provider(() => detail, status)
		await expect(drain(new RequestRepair().stream(fake, base(withImage())))).rejects.toBeInstanceOf(
			ProviderRequestError,
		)
		expect(requests).toHaveLength(1)
	})

	it('treats a 413 that names an image, on a request holding one, as media', async () => {
		const { fake, requests } = provider((p) =>
			wireText(p).includes('DZ') ? 'Payload too large: images exceed the request size' : undefined,
		)
		await drain(new RequestRepair().stream(fake, { ...base(withImage()) }))
		expect(requests).toHaveLength(2)
	})
})

describe('what the person is told about removed media', () => {
	const removals: unknown[] = []
	const repairing = () => {
		removals.length = 0
		return new RequestRepair({ onMediaRemoved: (removal) => void removals.push(removal) })
	}

	it('says so when it was attached to the latest message', async () => {
		const { fake } = provider((p) =>
			wireText(p).includes('DZ') ? 'image could not be processed' : undefined,
		)
		await drain(
			repairing().stream(
				fake,
				base([
					createUserMessage('old', [img('Y')]),
					createAssistantMessage('seen'),
					createUserMessage('look', [img('Z')]),
				]),
			),
		)
		expect(removals).toEqual([{ count: 1, kind: 'image', current: true, limit: false }])
	})

	it('reports a count limit as a limit, not a fault, and keeps the newest', async () => {
		const many = Array.from({ length: 4 }, (_, i) => createUserMessage(`m${i}`, [img(`I${i}`)]))
		const { fake, requests } = provider((p) =>
			(wireText(p).match(/DI\d/g) ?? []).length > 2 ? 'too many images in request' : undefined,
		)
		await drain(repairing().stream(fake, base(many)))
		expect(removals).toEqual([{ count: 2, kind: 'image', current: false, limit: true }])
		expect(wireText(requests.at(-1))).toContain('DI3')
		expect(wireText(requests.at(-1))).not.toContain('DI0')
		expect(wireText(requests.at(-1))).toContain('more files than the provider accepts')
	})
})

describe('the member that served', () => {
	it('keys a refused parameter by the serving member, not the head of the chain', async () => {
		let member = { providerId: 'a' }
		const { fake, requests } = provider((p) =>
			p.effort !== undefined && member.providerId === 'a'
				? "Unsupported parameter: 'reasoning_effort'"
				: undefined,
		)
		const repair = new RequestRepair({ servedBy: () => member })
		const send = () =>
			drain(repair.stream(fake, { ...base([createUserMessage('x')]), effort: 'high' }))
		await send()
		member = { providerId: 'b' }
		await send()
		expect(requests.at(-1)?.effort).toBe('high')
		member = { providerId: 'a' }
		await send()
		expect(requests.at(-1)?.effort).toBeUndefined()
	})
})

describe('one budget per original request', () => {
	it('is shared by every send of a request, and bounded', async () => {
		const { fake, requests } = provider((p) => {
			const text = wireText(p)
			return /D[A-Z]\d/.test(text) || text.includes('removed')
				? 'image could not be processed'
				: undefined
		})
		const messages = Array.from({ length: 12 }, (_, i) =>
			createUserMessage(`m${i}`, [img(`I${i}`)]),
		)
		const repair = new RequestRepair()
		const session = repair.session()
		for (let round = 0; round < 3; round++) {
			await drain(repair.stream(fake, base(messages), session)).catch(() => undefined)
		}
		expect(requests.length).toBeLessThanOrEqual(3 + MAX_REPAIRS_PER_REQUEST)
	})
})
