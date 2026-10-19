import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { ProviderRequestError } from '../../../provider/errors.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
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
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import type { SessionEvent } from '../../../types/session/index.js'
import { drainQuery } from '../index.js'

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const USAGE = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

const png = (tag: string) => ({
	data: `cGl4ZWxz-${tag}`,
	mediaType: 'image/png',
})

/** Rejects a request with a 400 for as long as `reject` finds something wrong with it. */
class RejectingProvider implements LLMProvider {
	readonly id = 'fake'
	readonly name = 'Fake'
	readonly requests: ChatCompletionParams[] = []
	constructor(private readonly reject: (params: ChatCompletionParams) => string | undefined) {}

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		this.requests.push(params)
		const detail = this.reject(params)
		if (detail !== undefined) {
			throw new ProviderRequestError({
				kind: 'bad_request',
				providerId: this.id,
				status: 400,
				detail,
			})
		}
		yield { id: 'a', delta: { content: 'ok' } }
		yield { id: 'a', delta: {}, finishReason: 'stop', usage: USAGE }
	}
}

async function run(
	provider: LLMProvider,
	messages: Message[],
	turnConfig: Record<string, unknown> = {},
) {
	const events: SessionEvent[] = []
	const dir = await mkdtemp(join(tmpdir(), 'namzu-request-repair-'))
	dirs.push(dir)
	const result = await drainQuery(
		{
			provider,
			toolsets: [],
			retry: { maxRetries: 0 },
			turnConfig: {
				model: 'm1',
				timeoutMs: 5_000,
				tokenBudget: 100_000,
				maxIterations: 1,
				maxResponseTokens: 256,
				...turnConfig,
			},
			agentId: 'agent_request_repair',
			agentName: 'Request repair',
			messages,
			workingDirectory: dir,
			sessionId: '1facb730-1762-4583-82ee-3b51eb21bcce' as SessionId,
			topicId: '89b5ba11-b552-44f2-87bf-a506c57b9476' as TopicId,
			projectId: 'ced4d0a7-6c32-4525-93ca-8dc8cd05140f' as ProjectId,
			tenantId: 'd754cc0f-50c6-4bc4-8f2a-c5eb2bfdc657' as TenantId,
		} as never,
		(event) => {
			events.push(event)
		},
	)
	return { result, events }
}

const wire = (params: ChatCompletionParams | undefined) => JSON.stringify(params?.messages)

describe('reasoning the provider rejects', () => {
	const reasoned = (): Message[] => [
		createUserMessage('hi'),
		createAssistantMessage('hello', undefined, [
			{
				type: 'thinking',
				text: 'secret plan',
				signature: 'SIG-FROM-OTHER-MODEL',
			},
		]),
		createUserMessage('and now?'),
	]
	const rejectSignature = (p: ChatCompletionParams) =>
		wire(p).includes('SIG-FROM-OTHER-MODEL')
			? 'messages.1.content.0: Invalid `signature` in `thinking` block'
			: undefined

	it('strips the reasoning blocks and retries without telling the person', async () => {
		const provider = new RejectingProvider(rejectSignature)
		const { result, events } = await run(provider, reasoned())
		expect(result.status).toBe('completed')
		expect(provider.requests).toHaveLength(2)
		expect(wire(provider.requests[1])).not.toContain('SIG-FROM-OTHER-MODEL')
		expect(events.filter((e) => e.type === 'capability_warning')).toHaveLength(0)
		// The stored conversation keeps the reasoning.
		expect(JSON.stringify(result.messages)).toContain('SIG-FROM-OTHER-MODEL')
	})

	it('classifies a rejected encrypted reasoning item by its code before its wording', async () => {
		const provider = new RejectingProvider((p) =>
			wire(p).includes('SIG-FROM-OTHER-MODEL') ? 'something unrelated' : undefined,
		)
		provider.chatStream = async function* (this: RejectingProvider, params) {
			this.requests.push(params)
			if (wire(params).includes('SIG-FROM-OTHER-MODEL')) {
				throw new ProviderRequestError({
					kind: 'bad_request',
					providerId: this.id,
					status: 400,
					providerCode: 'invalid_encrypted_content',
					detail: 'The encrypted content could not be verified.',
				})
			}
			yield { id: 'a', delta: { content: 'ok' } }
			yield { id: 'a', delta: {}, finishReason: 'stop', usage: USAGE }
		}
		const { result } = await run(provider, reasoned())
		expect(result.status).toBe('completed')
		expect(provider.requests).toHaveLength(2)
	})
})

describe('a parameter the model does not accept', () => {
	it.each([
		[
			'effort',
			{ effort: 'high' },
			"Unsupported parameter: 'reasoning_effort' is not supported with this model.",
		],
		[
			'temperature',
			{ temperature: 0.2 },
			"Unsupported value: 'temperature' does not support 0.2 with this model.",
		],
		[
			'thinking',
			{ thinking: { type: 'enabled', budgetTokens: 2048 } },
			'thinking is not supported by this model',
		],
	] as const)(
		'drops %s once, latches it off, and retries silently',
		async (key, config, detail) => {
			const provider = new RejectingProvider((p) =>
				(p as unknown as Record<string, unknown>)[key] !== undefined ? detail : undefined,
			)
			const { result, events } = await run(provider, [createUserMessage('hi')], config)
			expect(result.status).toBe('completed')
			expect(provider.requests).toHaveLength(2)
			expect((provider.requests[1] as unknown as Record<string, unknown>)[key]).toBeUndefined()
			expect(events.filter((e) => e.type === 'capability_warning')).toHaveLength(0)
		},
	)
})

describe('media the provider rejects', () => {
	const two = (): Message[] => [
		createUserMessage('first', [png('one')]),
		createAssistantMessage('seen'),
		createUserMessage('second', [png('two')]),
	]

	it('replaces only the message a named index points at, and says so once', async () => {
		const provider = new RejectingProvider((p) =>
			wire(p).includes('-one')
				? 'messages.0.content.1.image.source.base64: image exceeds the maximum size'
				: undefined,
		)
		const { result, events } = await run(provider, two())
		expect(result.status).toBe('completed')
		expect(provider.requests).toHaveLength(2)
		expect(wire(provider.requests[1])).not.toContain('-one')
		expect(wire(provider.requests[1])).toContain('-two')
		expect(JSON.stringify(result.messages)).toContain('-one')
		const notices = events.filter((e) => e.type === 'capability_warning')
		expect(notices).toHaveLength(1)
		expect(notices[0]).toMatchObject({ contentSource: 'media-removed' })
	})

	it('strips the newest media when the rejection names no index', async () => {
		const provider = new RejectingProvider((p) =>
			wire(p).includes('-two') ? 'image could not be processed' : undefined,
		)
		const { result } = await run(provider, two())
		expect(result.status).toBe('completed')
		expect(wire(provider.requests.at(-1))).not.toContain('-two')
		expect(wire(provider.requests.at(-1))).toContain('-one')
	})

	it('never takes a one-image rejection for a model that cannot read images', async () => {
		const provider = new RejectingProvider((p) =>
			wire(p).includes('-two') ? 'image/webp media type not supported' : undefined,
		)
		const { result, events } = await run(provider, two())
		expect(result.status).toBe('completed')
		expect(
			events.some((e) => e.type === 'capability_warning' && e.contentSource === 'history'),
		).toBe(false)
		expect(wire(provider.requests.at(-1))).toContain('-one')
	})

	it('drops the oldest media in steps for a generic unprocessable rejection', async () => {
		const many = (): Message[] =>
			Array.from({ length: 4 }, (_, i) => createUserMessage(`m${i}`, [png(`img${i}`)]))
		const provider = new RejectingProvider((p) =>
			(wire(p).match(/-img\d/g) ?? []).length > 1
				? 'Request rejected as unprocessable: too many images'
				: undefined,
		)
		const { result } = await run(provider, many())
		expect(result.status).toBe('completed')
		expect(wire(provider.requests.at(-1))).toContain('-img3')
		expect(wire(provider.requests.at(-1))).not.toContain('-img0')
	})
})

describe('tool pairing', () => {
	it('is repaired in the outgoing request after a tool-history rejection', async () => {
		const call = {
			id: 'call_1',
			type: 'function' as const,
			function: { name: 'x', arguments: '{}' },
		}
		const provider = new RejectingProvider((p) =>
			p.messages.some((m) => m.role === 'tool')
				? undefined
				: 'tool_use ids were found without tool_result blocks immediately after: call_1',
		)
		const { result } = await run(provider, [
			createUserMessage('go'),
			createAssistantMessage('calling', [call]),
			createToolMessage('done', call.id),
			createUserMessage('next'),
		])
		expect(result.status).toBe('completed')
	})
})
