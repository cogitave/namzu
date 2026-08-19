import { describe, expect, it, vi } from 'vitest'

import { CompactionConfigSchema } from '../../config/runtime.js'
import { MOCK_CAPABILITIES } from '../../provider/index.js'
import {
	createAssistantMessage,
	createSystemMessage,
	createUserMessage,
} from '../../types/message/index.js'
import type { ChatCompletionParams, LLMProvider, StreamChunk } from '../../types/provider/index.js'
import { type CompactNowInput, compactNow, compactRegion } from '../manual.js'

interface Deferred<T> {
	readonly promise: Promise<T>
	resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

const config = CompactionConfigSchema.parse({
	keepRecentMessages: 2,
	clearToolResults: false,
	llmVerification: true,
	richStateThreshold: 1_000,
})

function history() {
	return [
		createSystemMessage('system'),
		...Array.from({ length: 10 }, (_, index) => [
			createUserMessage(`question ${index}`),
			createAssistantMessage(`answer ${index}`),
		]).flat(),
	]
}

const manualModes = ['whole', 'region'] as const
type ManualMode = (typeof manualModes)[number]

function compact(mode: ManualMode, input: CompactNowInput, emptyRegion = false) {
	if (mode === 'whole') return compactNow(input)
	return compactRegion({
		...input,
		start: 1,
		end: emptyRegion ? 1 : input.messages.length - 2,
	})
}

describe('host-triggered compaction owns verifier liveness', () => {
	it.each(manualModes)('bounds a hostile raw provider for a %s compaction', async (mode) => {
		const started = deferred<void>()
		const release = deferred<void>()
		let transportSignal: AbortSignal | undefined
		const provider: LLMProvider = {
			id: 'held-manual-verifier',
			name: 'Held manual verifier',
			capabilities: MOCK_CAPABILITIES,
			async *chatStream(request: ChatCompletionParams): AsyncIterable<StreamChunk> {
				transportSignal = request.signal
				started.resolve()
				// Ignore the wrapper-owned abort. Its independent race must still
				// reject compactNow rather than waiting for provider cooperation.
				await release.promise
				yield { id: 'late', delta: { content: 'COMPLETE' } }
			},
		}
		const compacting = compact(mode, {
			messages: history(),
			config,
			provider,
			model: 'compaction-model',
			streamIdleTimeoutMs: 20,
		})
		let outcome: { value: unknown } | { error: unknown } | undefined
		void compacting.then(
			(value) => {
				outcome = { value }
			},
			(error: unknown) => {
				outcome = { error }
			},
		)

		await started.promise
		let waitFailure: unknown
		try {
			await vi.waitFor(() => expect(outcome).toBeDefined(), {
				timeout: 1_000,
				interval: 10,
			})
		} catch (error) {
			waitFailure = error
		} finally {
			// Raw-provider or option-forwarding mutations fail promptly and then
			// release the hostile iterator instead of hanging the test process.
			release.resolve()
		}

		await compacting.catch(() => undefined)
		if (waitFailure) throw waitFailure
		expect(outcome).toMatchObject({
			error: {
				name: 'ProviderRequestError',
				kind: 'network',
				providerId: 'held-manual-verifier',
			},
		})
		expect(transportSignal?.aborted).toBe(true)
		expect(transportSignal?.reason).toBe(outcome && 'error' in outcome ? outcome.error : undefined)
	})

	it.each(manualModes)('refuses malformed liveness config before a %s no-op', async (mode) => {
		let calls = 0
		const provider: LLMProvider = {
			id: 'unused-verifier',
			name: 'Unused verifier',
			capabilities: MOCK_CAPABILITIES,
			async *chatStream(): AsyncIterable<StreamChunk> {
				calls++
				yield { id: 'unused', delta: { content: 'COMPLETE' } }
			},
		}

		await expect(
			compact(
				mode,
				{
					messages: [createSystemMessage('s'), createUserMessage('too short')],
					config,
					provider,
					streamIdleTimeoutMs: -1,
				},
				true,
			),
		).rejects.toThrow(/streamIdleTimeoutMs must be an integer/)
		expect(calls).toBe(0)
	})

	it.each(manualModes)('starts no %s work when the request was already cancelled', async (mode) => {
		let calls = 0
		const provider: LLMProvider = {
			id: 'cancelled-verifier',
			name: 'Cancelled verifier',
			capabilities: MOCK_CAPABILITIES,
			async *chatStream(): AsyncIterable<StreamChunk> {
				calls++
				yield { id: 'unused', delta: { content: 'COMPLETE' } }
			},
		}
		const caller = new AbortController()
		const stop = new Error('manual compaction cancelled before admission')
		caller.abort(stop)

		await expect(
			compact(mode, {
				messages: history(),
				config,
				provider,
				signal: caller.signal,
			}),
		).rejects.toBe(stop)
		expect(calls).toBe(0)
	})
})
