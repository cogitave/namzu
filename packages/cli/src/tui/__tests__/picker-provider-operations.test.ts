/** Provider side-calls retain the picker operation that authorized them. */

import { type LLMProvider, ProviderRegistry } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type DetectedProvider, PROVIDER_REGISTRY } from '../../integrations/providers/index.js'

vi.mock('../../integrations/providers/register.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../integrations/providers/register.js')>()
	return { ...actual, ensureRegistered: vi.fn(async () => {}) }
})

const { describeProviderModels, verifyCredential } = await import('../agent.js')

const providerId = 'openai'
const detected: DetectedProvider = {
	entry: PROVIDER_REGISTRY[providerId],
	source: { kind: 'session' },
	apiKey: 'not-a-real-key',
	alternatives: [],
}

let provider: LLMProvider

function base(overrides: Partial<LLMProvider>): LLMProvider {
	return {
		id: 'picker-provider',
		name: 'Picker Provider',
		chatStream: async function* () {},
		...overrides,
	}
}

beforeEach(() => {
	provider = base({})
	vi.spyOn(ProviderRegistry, 'create').mockImplementation(
		() =>
			({
				provider,
				capabilities: {},
			}) as never,
	)
})

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
})

describe('picker provider operations', () => {
	it('preserves model input modalities for the picker', async () => {
		provider = base({
			listModels: async () => [
				{
					id: 'vision-model',
					name: 'Vision Model',
					inputModalities: ['text', 'image'],
					inputPrice: 0,
					outputPrice: 0,
					supportsToolUse: true,
					supportsStreaming: true,
				},
			],
		})

		await expect(describeProviderModels(providerId, detected)).resolves.toEqual({
			kind: 'ok',
			models: [
				{
					id: 'vision-model',
					name: 'Vision Model',
					inputModalities: ['text', 'image'],
					// Carried as well, and carried FAITHFULLY: this fixture's
					// driver reported a rate of zero, so the projection keeps a
					// zero. The model step reads it as free, which is what the
					// driver said. A projection that dropped these would take the
					// picker's free marker away from the drivers entitled to it.
					inputPrice: 0,
					outputPrice: 0,
				},
			],
		})
	})

	it('carries an absent rate as absent rather than as zero', async () => {
		// The other half, and the one that used to be indistinguishable. A
		// driver that published nothing must not reach the picker as a zero,
		// because a zero there is the free marker.
		provider = base({
			listModels: async () => [
				{
					id: 'unpriced-model',
					name: 'Unpriced Model',
					supportsToolUse: true,
					supportsStreaming: true,
				},
			],
		})

		await expect(describeProviderModels(providerId, detected)).resolves.toEqual({
			kind: 'ok',
			models: [{ id: 'unpriced-model', name: 'Unpriced Model' }],
		})
	})

	it('does not construct a provider for an already-cancelled choice', async () => {
		const controller = new AbortController()
		const cause = new Error('choice was already cancelled')
		controller.abort(cause)

		await expect(describeProviderModels(providerId, detected, controller.signal)).rejects.toBe(
			cause,
		)
		await expect(verifyCredential(providerId, detected, controller.signal)).rejects.toBe(cause)
		expect(ProviderRegistry.create).not.toHaveBeenCalled()
	})

	it('forwards cancellation to model listing and preserves the caller cause', async () => {
		let seen: AbortSignal | undefined
		provider = base({
			listModels: (signal) => {
				seen = signal
				return new Promise((_resolve, reject) =>
					signal?.addEventListener('abort', () =>
						reject(new DOMException('aborted', 'AbortError')),
					),
				)
			},
		})
		const controller = new AbortController()
		const cause = new Error('left model picker')
		const pending = describeProviderModels(providerId, detected, controller.signal)
		await vi.waitFor(() => expect(seen).toBeDefined())

		controller.abort(cause)

		await expect(pending).rejects.toBe(cause)
		expect(seen?.aborted).toBe(true)
	})

	it('settles a model listing whose provider ignores abort', async () => {
		vi.useFakeTimers()
		let seen: AbortSignal | undefined
		provider = base({
			listModels: (signal) => {
				seen = signal
				return new Promise(() => {})
			},
		})
		const pending = describeProviderModels(providerId, detected)
		await vi.advanceTimersByTimeAsync(3_000)

		await expect(pending).resolves.toEqual({ kind: 'timeout' })
		expect(seen?.aborted).toBe(true)
		expect(vi.getTimerCount()).toBe(0)
	})

	it('bounds credential probes and forwards their operation signal', async () => {
		vi.useFakeTimers()
		let seen: AbortSignal | undefined
		provider = base({
			probeCredential: (signal) => {
				seen = signal
				return new Promise(() => {})
			},
		})
		const pending = verifyCredential(providerId, detected)
		await vi.advanceTimersByTimeAsync(3_000)

		await expect(pending).resolves.toEqual({ kind: 'unverifiable' })
		expect(seen?.aborted).toBe(true)
		expect(vi.getTimerCount()).toBe(0)
	})
})
