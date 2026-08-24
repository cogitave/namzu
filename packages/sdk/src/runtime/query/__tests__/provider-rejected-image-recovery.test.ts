import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { ProviderRequestError } from '../../../provider/errors.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { InMemoryRunStore } from '../../../store/run/memory.js'
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
import { RunCancelled } from '../../../types/run/cancel-cause.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const ZERO_USAGE = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

class RejectsOneImageProvider implements LLMProvider {
	readonly id = 'image-rejection-fixture'
	readonly name = 'Image rejection fixture'
	readonly requests: ChatCompletionParams[] = []

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		this.requests.push(params)
		if (this.requests.length === 1) {
			throw new ProviderRequestError({
				kind: 'bad_request',
				providerId: this.id,
				providerCode: 'invalid_image',
				status: 400,
				detail: 'some future wording without the legacy phrase',
			})
		}

		yield { id: 'answer', delta: { content: 'Recovered without losing the attachment.' } }
		yield { id: 'answer', delta: {}, finishReason: 'stop', usage: ZERO_USAGE }
	}
}

class ScriptedProvider implements LLMProvider {
	readonly id = 'scripted-image-rejection'
	readonly name = 'Scripted image rejection'
	readonly requests: ChatCompletionParams[] = []

	constructor(
		private readonly script: (
			params: ChatCompletionParams,
			call: number,
		) => AsyncIterable<StreamChunk>,
	) {}

	chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		this.requests.push(params)
		return this.script(params, this.requests.length)
	}
}

function invalidImage(): ProviderRequestError {
	return new ProviderRequestError({
		kind: 'bad_request',
		providerId: 'scripted-image-rejection',
		providerCode: 'invalid_image',
		status: 400,
		detail: 'some future wording without the legacy phrase',
	})
}

async function runFixture(
	provider: LLMProvider,
	messages: ChatCompletionParams['messages'],
	signal?: AbortSignal,
) {
	const events: RunEvent[] = []
	const run = await drainQuery(
		{
			provider,
			tools: new ToolRegistry(),
			retry: { maxRetries: 0 },
			runConfig: {
				model: 'vision-model',
				timeoutMs: 5_000,
				tokenBudget: 100_000,
				maxIterations: 1,
				maxResponseTokens: 256,
			},
			agentId: 'agent_image_recovery_refusal',
			agentName: 'Image Recovery Refusal',
			messages,
			workingDirectory: await workingDirectory(),
			sessionId: 'ses_image_recovery_refusal' as SessionId,
			topicId: 'top_image_recovery_refusal' as TopicId,
			projectId: 'prj_image_recovery_refusal' as ProjectId,
			tenantId: 'tnt_image_recovery_refusal' as TenantId,
			...(signal ? { signal } : {}),
		},
		(event) => {
			events.push(event)
		},
	)
	return { run, events }
}

async function workingDirectory(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-image-recovery-'))
	dirs.push(dir)
	return dir
}

describe('a provider-rejected image is recovered once and suppressed durably', () => {
	it('retries the same turn without one distinct image and heals reconstructed history', async () => {
		const image = { data: 'aW52YWxpZC1pbWFnZQ==', mediaType: 'image/png' }
		const call = {
			id: 'call_capture',
			type: 'function' as const,
			function: { name: 'capture', arguments: '{}' },
		}
		const messages = [
			createUserMessage('inspect this', [image]),
			createAssistantMessage('I captured the same frame.', [call]),
			createToolMessage(
				[
					{ type: 'text', text: 'captured' },
					{ type: 'image', ...image },
				],
				call.id,
			),
			createUserMessage('continue'),
		]
		const provider = new RejectsOneImageProvider()
		const runStore = new InMemoryRunStore()
		const events: RunEvent[] = []

		const run = await drainQuery(
			{
				provider,
				tools: new ToolRegistry(),
				runStore,
				retry: { maxRetries: 0 },
				runConfig: {
					model: 'vision-model',
					timeoutMs: 5_000,
					tokenBudget: 100_000,
					maxIterations: 1,
					maxResponseTokens: 256,
				},
				agentId: 'agent_image_recovery',
				agentName: 'Image Recovery',
				messages,
				workingDirectory: await workingDirectory(),
				sessionId: 'ses_image_recovery' as SessionId,
				topicId: 'top_image_recovery' as TopicId,
				projectId: 'prj_image_recovery' as ProjectId,
				tenantId: 'tnt_image_recovery' as TenantId,
			},
			(event) => {
				events.push(event)
			},
		)

		expect(run.status).toBe('completed')
		expect(provider.requests).toHaveLength(2)
		expect(JSON.stringify(provider.requests[0]?.messages)).toContain(image.data)
		expect(JSON.stringify(provider.requests[1]?.messages)).not.toContain(image.data)
		expect(JSON.stringify(provider.requests[1]?.messages)).toContain('provider rejected this image')
		const sentTool = provider.requests[1]?.messages.find((message) => message.role === 'tool')
		expect(sentTool).toMatchObject({ role: 'tool', toolCallId: call.id })

		const durable = JSON.stringify(run.messages)
		expect(durable.match(new RegExp(image.data, 'g'))).toHaveLength(2)
		expect(durable.match(/provider-rejected/g)).toHaveLength(2)
		const persisted = await runStore.readMessages()
		expect(persisted.kind).toBe('available')
		if (persisted.kind !== 'available') return
		expect(persisted.messages).toEqual(run.messages)

		const repairIndex = events.findIndex(
			(event) =>
				event.type === 'message_history_repaired' && event.source === 'provider-rejected-image',
		)
		const deltaIndex = events.findIndex((event) => event.type === 'text_delta')
		expect(repairIndex).toBeGreaterThan(0)
		expect(repairIndex).toBeLessThan(deltaIndex)
		expect(events[repairIndex]).toMatchObject({
			type: 'message_history_repaired',
			source: 'provider-rejected-image',
			providerRejectedImagesSuppressed: 2,
		})

		const next = new RejectsOneImageProvider()
		// Reconstructed history must use the durable marker immediately; the
		// fixture's first call rejects only when image bytes are sent.
		next.chatStream = async function* (params: ChatCompletionParams) {
			this.requests.push(params)
			if (JSON.stringify(params.messages).includes(image.data)) {
				throw new ProviderRequestError({
					kind: 'bad_request',
					providerId: this.id,
					status: 400,
					detail: 'invalid_image: image could not be processed',
				})
			}
			yield { id: 'next', delta: { content: 'continued' } }
			yield { id: 'next', delta: {}, finishReason: 'stop', usage: ZERO_USAGE }
		}
		const nextEvents: RunEvent[] = []
		const continued = await drainQuery(
			{
				provider: next,
				tools: new ToolRegistry(),
				retry: { maxRetries: 0 },
				runConfig: {
					model: 'vision-model',
					timeoutMs: 5_000,
					tokenBudget: 100_000,
					maxIterations: 1,
					maxResponseTokens: 256,
				},
				agentId: 'agent_image_recovery',
				agentName: 'Image Recovery',
				messages: run.messages,
				workingDirectory: await workingDirectory(),
				sessionId: 'ses_image_recovery_next' as SessionId,
				topicId: 'top_image_recovery_next' as TopicId,
				projectId: 'prj_image_recovery_next' as ProjectId,
				tenantId: 'tnt_image_recovery_next' as TenantId,
			},
			(event) => {
				nextEvents.push(event)
			},
		)

		expect(continued.status).toBe('completed')
		expect(next.requests).toHaveLength(1)
		expect(nextEvents.some((event) => event.type === 'message_history_repaired')).toBe(false)
	})

	it('does not guess which of two distinct images the provider rejected', async () => {
		const provider = new ScriptedProvider(async function* () {
			yield await Promise.reject(invalidImage())
		})
		const messages = [
			createUserMessage('compare', [
				{ data: 'Zmlyc3Q=', mediaType: 'image/png' },
				{ data: 'c2Vjb25k', mediaType: 'image/png' },
			]),
		]

		const { run, events } = await runFixture(provider, messages)

		expect(run.status).toBe('failed')
		expect(provider.requests).toHaveLength(1)
		expect(JSON.stringify(run.messages)).not.toContain('provider-rejected')
		expect(events.some((event) => event.type === 'message_history_repaired')).toBe(false)
	})

	it('does not turn an unrelated invalid request into image recovery', async () => {
		const provider = new ScriptedProvider(async function* () {
			yield await Promise.reject(
				new ProviderRequestError({
					kind: 'bad_request',
					providerId: 'scripted-image-rejection',
					status: 400,
					detail: 'tools.0.input_schema must be an object',
				}),
			)
		})
		const messages = [createUserMessage('inspect', [{ data: 'aW1hZ2U=', mediaType: 'image/png' }])]

		const { run } = await runFixture(provider, messages)

		expect(run.status).toBe('failed')
		expect(provider.requests).toHaveLength(1)
		expect(JSON.stringify(run.messages)).not.toContain('provider-rejected')
	})

	it('keeps legacy phrase recovery request-local instead of asserting durable server proof', async () => {
		const provider = new ScriptedProvider(async function* (_params, call) {
			if (call === 1) {
				throw new ProviderRequestError({
					kind: 'bad_request',
					providerId: 'scripted-image-rejection',
					status: 400,
					detail: 'Base64 string of provided image cannot be decoded.',
				})
			}
			yield { id: 'answer', delta: { content: 'request-local recovery' } }
			yield { id: 'answer', delta: {}, finishReason: 'stop', usage: ZERO_USAGE }
		})
		const image = { data: 'aW1hZ2U=', mediaType: 'image/png' }

		const { run, events } = await runFixture(provider, [createUserMessage('inspect', [image])])

		expect(run.status).toBe('completed')
		expect(provider.requests).toHaveLength(2)
		expect(JSON.stringify(provider.requests[1]?.messages)).not.toContain(image.data)
		expect(JSON.stringify(run.messages)).toContain(image.data)
		expect(JSON.stringify(run.messages)).not.toContain('provider-rejected')
		expect(events.some((event) => event.type === 'message_history_repaired')).toBe(false)
	})

	it('does not edit history when the stripped retry also fails', async () => {
		const provider = new ScriptedProvider(async function* (_params, call) {
			if (call === 1) yield await Promise.reject(invalidImage())
			yield await Promise.reject(
				new ProviderRequestError({
					kind: 'server',
					providerId: 'scripted-image-rejection',
					status: 503,
					detail: 'temporarily unavailable',
				}),
			)
		})
		const messages = [createUserMessage('inspect', [{ data: 'aW1hZ2U=', mediaType: 'image/png' }])]

		const { run } = await runFixture(provider, messages)

		expect(run.status).toBe('failed')
		expect(provider.requests).toHaveLength(2)
		expect(JSON.stringify(run.messages)).not.toContain('provider-rejected')
	})

	it('does not edit history when the stripped retry reports an in-band error', async () => {
		const provider = new ScriptedProvider(async function* (_params, call) {
			if (call === 1) yield await Promise.reject(invalidImage())
			yield { id: 'retry-error', delta: {}, error: 'retry could not process the request' }
		})
		const messages = [createUserMessage('inspect', [{ data: 'aW1hZ2U=', mediaType: 'image/png' }])]

		const { run } = await runFixture(provider, messages)

		expect(run.status).toBe('failed')
		expect(provider.requests).toHaveLength(2)
		expect(JSON.stringify(run.messages)).not.toContain('provider-rejected')
	})

	it('never restarts a request after the model produced output', async () => {
		const provider = new ScriptedProvider(async function* () {
			yield { id: 'partial', delta: { content: 'partial answer' } }
			throw invalidImage()
		})
		const messages = [createUserMessage('inspect', [{ data: 'aW1hZ2U=', mediaType: 'image/png' }])]

		const { run, events } = await runFixture(provider, messages)

		expect(run.status).toBe('failed')
		expect(provider.requests).toHaveLength(1)
		expect(events).toContainEqual(
			expect.objectContaining({ type: 'text_delta', text: 'partial answer' }),
		)
		expect(JSON.stringify(run.messages)).not.toContain('provider-rejected')
	})

	it('lets caller cancellation win while the stripped retry is held', async () => {
		let enterRetry!: () => void
		const retryStarted = new Promise<void>((resolve) => {
			enterRetry = resolve
		})
		let releaseRetry!: () => void
		const held = new Promise<void>((resolve) => {
			releaseRetry = resolve
		})
		const provider = new ScriptedProvider(async function* (_params, call) {
			if (call === 1) throw invalidImage()
			enterRetry()
			await held
			yield { id: 'late', delta: { content: 'late' } }
		})
		const controller = new AbortController()
		const messages = [createUserMessage('inspect', [{ data: 'aW1hZ2U=', mediaType: 'image/png' }])]

		const pending = runFixture(provider, messages, controller.signal)
		await retryStarted
		controller.abort(new RunCancelled('user'))
		const { run } = await pending
		releaseRetry()

		expect(run.status).toBe('cancelled')
		expect(provider.requests).toHaveLength(2)
		expect(JSON.stringify(run.messages)).not.toContain('provider-rejected')
	})

	it('uses the same recovery on the separate limit-closing request', async () => {
		const provider = new RejectsOneImageProvider()
		const events: RunEvent[] = []
		const run = await drainQuery(
			{
				provider,
				tools: new ToolRegistry(),
				retry: { maxRetries: 0 },
				runConfig: {
					model: 'vision-model',
					timeoutMs: 5_000,
					tokenBudget: 100_000,
					maxIterations: 0,
					maxResponseTokens: 256,
				},
				agentId: 'agent_image_recovery_final',
				agentName: 'Image Recovery Final',
				messages: [
					createUserMessage('finish', [{ data: 'aW52YWxpZC1pbWFnZQ==', mediaType: 'image/png' }]),
				],
				workingDirectory: await workingDirectory(),
				sessionId: 'ses_image_recovery_final' as SessionId,
				topicId: 'top_image_recovery_final' as TopicId,
				projectId: 'prj_image_recovery_final' as ProjectId,
				tenantId: 'tnt_image_recovery_final' as TenantId,
			},
			(event) => {
				events.push(event)
			},
		)

		expect(provider.requests).toHaveLength(2)
		expect(run.result).toContain('Recovered without losing the attachment.')
		expect(JSON.stringify(run.messages)).toContain('provider-rejected')
		expect(
			events.some(
				(event) =>
					event.type === 'message_history_repaired' && event.source === 'provider-rejected-image',
			),
		).toBe(true)
	})
})
