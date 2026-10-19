import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { ProviderRequestError } from '../../../provider/errors.js'
import { withProviderFallback } from '../../../provider/fallback.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import {
	createAssistantMessage,
	createToolMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import type {
	ChatCompletionParams,
	LLMProvider,
	StreamChunk,
} from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import type { SessionEvent } from '../../../types/session/index.js'
import { drainQuery } from '../index.js'
import { projectRequestRichContent } from '../request-rich-content.js'

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
const image = { data: 'aW1hZ2UtYnl0ZXM=', mediaType: 'image/png' }
const call = {
	id: 'call_capture',
	type: 'function' as const,
	function: { name: 'capture', arguments: '{}' },
}
const history = () => [
	createUserMessage('look at this', [image]),
	createAssistantMessage('capturing', [call]),
	createToolMessage(
		[
			{ type: 'text', text: 'Screenshot s1 captured' },
			{ type: 'image', ...image },
		],
		call.id,
	),
	createUserMessage('and now?'),
]

describe('projecting history for a model that cannot read images', () => {
	it('replaces every user and tool image with a short note and leaves the history alone', () => {
		const messages = history()
		const projected = projectRequestRichContent(messages, 0, { imagesReadable: false })
		const wire = JSON.stringify(projected)
		expect(wire).not.toContain(image.data)
		expect(wire.match(/the current model cannot read images/g)).toHaveLength(2)
		expect(wire).toContain('image/png')
		const tool = projected.find((m) => m.role === 'tool')
		expect(tool).toMatchObject({ role: 'tool', toolCallId: call.id })
		// The stored conversation still holds the bytes.
		expect(JSON.stringify(messages).match(new RegExp(image.data, 'g'))).toHaveLength(2)
	})

	it('is a no-op for a model that reads images', () => {
		const messages = history()
		expect(projectRequestRichContent(messages, 0, { imagesReadable: true })).toBe(messages)
		expect(projectRequestRichContent(messages, 0)).toBe(messages)
	})
})

const BEAM_REFUSAL =
	'Upstream request failed: [invalid_value] Beam supports text input only. This conversation contains an image. Remove the image from the conversation and try again.'

interface ModelAwareOptions {
	readonly id?: string
	/** What the refusal says, and the server's own code for it. */
	readonly detail?: string
	readonly providerCode?: string
	/** Every request is throttled, so a fallback chain moves past this member. */
	readonly throttled?: boolean
}

class ModelAwareProvider implements LLMProvider {
	readonly id: string
	readonly name = 'Model aware'
	readonly requests: ChatCompletionParams[] = []
	constructor(
		private readonly textOnly: ReadonlySet<string>,
		/** Models that are not declared text-only but refuse images anyway. */
		private readonly refuses: ReadonlySet<string> = new Set(),
		private readonly options: ModelAwareOptions = {},
	) {
		this.id = options.id ?? 'model-aware'
	}

	supportsImageInputFor(model: string): boolean {
		return !this.textOnly.has(model)
	}

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		this.requests.push(params)
		if (this.options.throttled) {
			throw new ProviderRequestError({
				kind: 'throttle',
				providerId: this.id,
				status: 429,
				detail: 'slow down',
			})
		}
		if (
			this.refuses.has(params.model ?? '') &&
			JSON.stringify(params.messages).includes(image.data)
		) {
			throw new ProviderRequestError({
				kind: 'bad_request',
				providerId: this.id,
				status: 400,
				...(this.options.providerCode ? { providerCode: this.options.providerCode } : {}),
				detail: this.options.detail ?? BEAM_REFUSAL,
			})
		}
		yield { id: 'a', delta: { content: 'ok' } }
		yield { id: 'a', delta: {}, finishReason: 'stop', usage: USAGE }
	}
}

async function run(
	provider: LLMProvider,
	model: string,
	fallbackProviders?: { provider: LLMProvider; model?: string }[],
) {
	const events: SessionEvent[] = []
	const dir = await mkdtemp(join(tmpdir(), 'namzu-text-only-'))
	dirs.push(dir)
	const result = await drainQuery(
		{
			provider,
			...(fallbackProviders ? { fallbackProviders } : {}),
			toolsets: [],
			retry: { maxRetries: 0 },
			turnConfig: {
				model,
				timeoutMs: 5_000,
				tokenBudget: 100_000,
				maxIterations: 1,
				maxResponseTokens: 256,
			},
			agentId: 'agent_text_only',
			agentName: 'Text only',
			messages: history(),
			workingDirectory: dir,
			sessionId: '1facb730-1762-4583-82ee-3b51eb21bcce' as SessionId,
			topicId: '89b5ba11-b552-44f2-87bf-a506c57b9476' as TopicId,
			projectId: 'ced4d0a7-6c32-4525-93ca-8dc8cd05140f' as ProjectId,
			tenantId: 'd754cc0f-50c6-4bc4-8f2a-c5eb2bfdc657' as TenantId,
		},
		(event) => {
			events.push(event)
		},
	)
	return { result, events }
}

describe('a text-only model inside a conversation that holds images', () => {
	it('is never sent an image when the driver knows the model is text-only', async () => {
		const provider = new ModelAwareProvider(new Set(['beam']))
		const { result, events } = await run(provider, 'beam')
		expect(result.status).toBe('completed')
		expect(provider.requests).toHaveLength(1)
		expect(JSON.stringify(provider.requests[0]?.messages)).not.toContain(image.data)
		expect(events.some((e) => e.type === 'capability_warning')).toBe(false)
		// The same history reaches a vision model with its pixels.
		const vision = new ModelAwareProvider(new Set(['beam']))
		await run(vision, 'seer')
		expect(JSON.stringify(vision.requests[0]?.messages)).toContain(image.data)
	})

	it('retries once without images when an undeclared model refuses them, and says so', async () => {
		const provider = new ModelAwareProvider(new Set(), new Set(['beam']))
		const { result, events } = await run(provider, 'beam')
		expect(result.status).toBe('completed')
		expect(provider.requests).toHaveLength(2)
		expect(JSON.stringify(provider.requests[0]?.messages)).toContain(image.data)
		expect(JSON.stringify(provider.requests[1]?.messages)).not.toContain(image.data)
		const warnings = events.filter((e) => e.type === 'capability_warning')
		expect(warnings).toHaveLength(1)
		expect(warnings[0]).toMatchObject({
			capability: 'vision',
			contentSource: 'history',
			model: 'beam',
		})
		// The conversation itself keeps the images.
		expect(JSON.stringify(result.messages)).toContain(image.data)
	})

	it('does not loop when the retry without images is refused too', async () => {
		const provider = new ModelAwareProvider(new Set(), new Set(['beam']))
		// biome-ignore lint/correctness/useYield: it fails before producing anything
		provider.chatStream = async function* (this: ModelAwareProvider, params) {
			this.requests.push(params)
			throw new ProviderRequestError({
				kind: 'bad_request',
				providerId: this.id,
				status: 400,
				detail: 'Beam supports text input only. This conversation contains an image.',
			})
		}
		const { result } = await run(provider, 'beam')
		expect(result.status).not.toBe('completed')
		expect(provider.requests).toHaveLength(2)
	})
})

describe('a refusal about one image is not a text-only model', () => {
	it('fails as before, and marks nothing, when the 400 is about an image format', async () => {
		const provider = new ModelAwareProvider(new Set(), new Set(['seer']), {
			detail: 'This model does not support image/webp media type',
		})
		const { result, events } = await run(provider, 'seer')
		expect(result.status).not.toBe('completed')
		expect(provider.requests).toHaveLength(1)
		expect(events.some((e) => e.type === 'capability_warning')).toBe(false)
	})

	it("lets the server's own invalid_image code win over wording that sounds text-only", async () => {
		const provider = new ModelAwareProvider(new Set(), new Set(['seer']), {
			providerCode: 'invalid_image',
			detail: 'Model does not support images. Please use a model that does.',
		})
		const { result, events } = await run(provider, 'seer')
		expect(result.status).toBe('completed')
		expect(provider.requests).toHaveLength(2)
		// The one bad image was set aside on its own, not every image for a text-only model.
		expect(JSON.stringify(provider.requests[1]?.messages)).toContain('provider rejected this image')
		expect(JSON.stringify(provider.requests[1]?.messages)).not.toContain(
			'the current model cannot read images',
		)
		expect(events.some((e) => e.type === 'capability_warning')).toBe(false)
	})
})

describe('a fallback chain', () => {
	it('marks the member that refused the image, not the head that was asked first', async () => {
		const head = new ModelAwareProvider(new Set(), new Set(), { id: 'head', throttled: true })
		const tail = new ModelAwareProvider(new Set(), new Set(['beam']), { id: 'tail' })
		const { result, events } = await run(head, 'seer', [{ provider: tail, model: 'beam' }])
		expect(result.status).toBe('completed')
		expect(head.requests).toHaveLength(1)
		expect(tail.requests).toHaveLength(2)
		expect(JSON.stringify(tail.requests[1]?.messages)).not.toContain(image.data)
		const warnings = events.filter((e) => e.type === 'capability_warning')
		expect(warnings).toHaveLength(1)
		expect(warnings[0]).toMatchObject({ providerId: 'tail', model: 'beam' })
	})

	it('answers for images with the member it is serving from', async () => {
		const head = new ModelAwareProvider(new Set(['m']), new Set(), { id: 'head', throttled: true })
		const tail = new ModelAwareProvider(new Set(), new Set(), { id: 'tail' })
		const chain = withProviderFallback([{ provider: head }, { provider: tail }])
		// The head is text-only, so the first request goes out without images.
		expect(chain.supportsImageInputFor?.('m')).toBe(false)
		for await (const _ of chain.chatStream({ model: 'm', messages: history() })) {
			// the head is throttled; the chain moves to the tail
		}
		// The tail reads images, and every later request starts there.
		expect(chain.supportsImageInputFor?.('m')).toBe(true)

		const visionHead = new ModelAwareProvider(new Set(), new Set(), {
			id: 'head',
			throttled: true,
		})
		const textTail = new ModelAwareProvider(new Set(['m']), new Set(), { id: 'tail' })
		const reverse = withProviderFallback([{ provider: visionHead }, { provider: textTail }])
		expect(reverse.supportsImageInputFor?.('m')).toBe(true)
		for await (const _ of reverse.chatStream({ model: 'm', messages: history() })) {
			// moves to the text-only tail
		}
		expect(reverse.supportsImageInputFor?.('m')).toBe(false)
	})
})
