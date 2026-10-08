/** Provider side-calls retain the picker operation that authorized them. */

import { type LLMProvider, ProviderRegistry } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { desktopModelCatalogue } from '../../commands/desktop-model-catalogue.js'
import { type DetectedProvider, PROVIDER_REGISTRY } from '../../integrations/providers/index.js'
import {
	CredentialRefreshRejectedError,
	CredentialWithdrawnError,
} from '../../integrations/providers/oauth.js'

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
	it('lists Zen free models before API-key models and carries the unverified-limits flag', async () => {
		const zen: DetectedProvider = { ...detected, entry: PROVIDER_REGISTRY.zen }
		const info = (id: string, price: number, extra: object = {}) => ({
			id,
			name: id,
			inputPrice: price,
			outputPrice: price,
			supportsToolUse: true,
			supportsStreaming: true,
			...extra,
		})
		provider = base({
			listModels: async () =>
				[
					info('paid-one', 2),
					info('exo-free', 0),
					info('paid-two', 3, { limitsVerified: false }),
					info('mimo-v2.6-flash-free', 0, { limitsVerified: false }),
				] as never,
		})
		const listing = await describeProviderModels('zen', zen)
		if (listing.kind !== 'ok') throw new Error('expected a listing')
		expect(listing.models.map((m) => m.id)).toEqual([
			'exo-free',
			'mimo-v2.6-flash-free',
			'paid-one',
			'paid-two',
		])
		expect(listing.models.map((m) => m.limitsVerified)).toEqual([
			undefined,
			false,
			undefined,
			false,
		])
		// Only a stated non-zero price marks a key; free rows are never marked.
		expect(listing.models.map((m) => m.requiresKey)).toEqual([undefined, undefined, true, true])
	})

	it('distinguishes a withdrawn credential from a remote rejection and hides its diagnostic', async () => {
		provider = base({
			listModels: async () => {
				throw new CredentialWithdrawnError('SYNTHETIC_OWNER_DETAIL_MUST_NOT_REACH_UI')
			},
		})
		const listing = await describeProviderModels(providerId, detected)
		expect(listing).toMatchObject({
			kind: 'failed',
			failure: 'credential-unavailable',
		})
		const result = desktopModelCatalogue(
			listing,
			detected.entry.defaultModel,
			undefined,
			() => true,
		)
		expect(result.models).toEqual([])
		expect(result.notice).toContain('no longer available on this device')
		expect(result.notice).not.toContain('rejected')
		expect(JSON.stringify(result)).not.toContain('SYNTHETIC_OWNER_DETAIL')
	})

	it('routes a rejected refresh to a fixed authentication notice without publishing its diagnostic', async () => {
		const rejected = new CredentialRefreshRejectedError()
		rejected.message = 'SYNTHETIC_CREDENTIAL_DIAGNOSTIC_MUST_NOT_REACH_UI'
		provider = base({
			listModels: async () => {
				throw rejected
			},
		})
		const listing = await describeProviderModels(providerId, detected)
		expect(listing).toMatchObject({
			kind: 'failed',
			failure: 'authentication',
		})
		const result = desktopModelCatalogue(
			listing,
			detected.entry.defaultModel,
			undefined,
			() => true,
		)
		expect(result.models).toEqual([])
		expect(result.notice).toContain('rejected its credential')
		expect(JSON.stringify(result)).not.toContain('SYNTHETIC_CREDENTIAL')
	})

	it('keeps a TLS transport failure distinct from credential rejection', async () => {
		const tls = Object.assign(new Error('SYNTHETIC_TLS_DIAGNOSTIC_MUST_NOT_REACH_UI'), {
			code: 'SELF_SIGNED_CERT_IN_CHAIN',
		})
		provider = base({
			listModels: async () => {
				throw new TypeError('fetch failed', { cause: tls })
			},
		})
		const listing = await describeProviderModels(providerId, detected)
		expect(listing.kind).toBe('failed')
		expect(listing).not.toHaveProperty('failure')
		const result = desktopModelCatalogue(
			listing,
			detected.entry.defaultModel,
			undefined,
			() => true,
		)
		expect(result.models).toEqual([])
		expect(result.notice).toContain('could not be loaded')
		expect(JSON.stringify(result)).not.toContain('SYNTHETIC_TLS')
	})

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

	// The picker's `(free)` note reads these two numbers, and `ModelInfo` types
	// both as required — so a driver with no price to give writes something. A
	// number is carried as the provider's own answer; anything that is not a
	// number is not a price, and arrives at the picker absent so that it reads
	// as unknown rather than as zero.
	it('carries a real price and drops every value that is not one', async () => {
		provider = base({
			listModels: async () => [
				{
					id: 'priced',
					name: 'Priced',
					inputPrice: 2.5,
					outputPrice: 7.5,
					supportsToolUse: true,
					supportsStreaming: true,
				},
				{
					id: 'nan',
					name: 'Not a number',
					inputPrice: Number.NaN,
					outputPrice: 7.5,
					supportsToolUse: true,
					supportsStreaming: true,
				},
				{
					id: 'infinite',
					name: 'Infinite',
					inputPrice: Number.POSITIVE_INFINITY,
					outputPrice: Number.POSITIVE_INFINITY,
					supportsToolUse: true,
					supportsStreaming: true,
				},
			],
		})

		const listing = await describeProviderModels(providerId, detected)
		expect(listing).toEqual({
			kind: 'ok',
			models: [
				{ id: 'priced', name: 'Priced', inputPrice: 2.5, outputPrice: 7.5 },
				{ id: 'nan', name: 'Not a number', outputPrice: 7.5 },
				{ id: 'infinite', name: 'Infinite' },
			],
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
