import { describe, expect, it, vi } from 'vitest'

import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type ProviderId,
} from '../integrations/providers/index.js'
import type { ModelListing } from './agent.js'
import { resolveModelSwitch } from './model-switch.js'

function detected(id: ProviderId, apiKey: string | undefined = 'fixture-key'): DetectedProvider {
	return { entry: PROVIDER_REGISTRY[id], apiKey, source: { kind: 'session' }, alternatives: [] }
}

function catalogue(...ids: string[]): ModelListing {
	return { kind: 'ok', models: ids.map((id) => ({ id, name: id })) }
}

function listingProvider(listings: Partial<Record<ProviderId, ModelListing>>) {
	return vi.fn(async (id: ProviderId) => listings[id] ?? catalogue())
}

describe('resolving an active conversation model change', () => {
	it('prefers an exact current-provider match without consulting other routes', async () => {
		const describeModels = listingProvider({
			openai: catalogue('shared'),
			zen: catalogue('shared'),
		})
		await expect(
			resolveModelSwitch(
				{ model: 'shared' },
				{
					currentProvider: 'openai',
					detected: [detected('zen'), detected('openai')],
					describeModels,
				},
			),
		).resolves.toEqual({ kind: 'resolved', selection: { id: 'openai', model: 'shared' } })
		expect(describeModels.mock.calls.map(([id]) => id)).toEqual(['openai'])
	})

	it('finds a unique other provider from its catalogue instead of guessing from the name', async () => {
		const describeModels = listingProvider({
			anthropic: catalogue('claude-model'),
			zen: catalogue('gpt-5.6-luna'),
			openai: catalogue('a-different-model'),
		})
		await expect(
			resolveModelSwitch(
				{ model: 'gpt-5.6-luna' },
				{
					currentProvider: 'anthropic',
					detected: [detected('anthropic'), detected('openai'), detected('zen')],
					describeModels,
				},
			),
		).resolves.toEqual({ kind: 'resolved', selection: { id: 'zen', model: 'gpt-5.6-luna' } })
	})

	it('rejects an ambiguous match with exact provider choices', async () => {
		const result = await resolveModelSwitch(
			{ model: 'shared' },
			{
				currentProvider: 'anthropic',
				detected: [detected('anthropic'), detected('openai'), detected('zen')],
				describeModels: listingProvider({ openai: catalogue('shared'), zen: catalogue('shared') }),
			},
		)
		expect(result).toMatchObject({
			kind: 'rejected',
			choices: [
				{ provider: 'openai', model: 'shared' },
				{ provider: 'zen', model: 'shared' },
			],
		})
	})

	it('honors an explicit provider even when the current provider lists the same model', async () => {
		const describeModels = listingProvider({
			openai: catalogue('shared'),
			zen: catalogue('shared'),
		})
		await expect(
			resolveModelSwitch(
				{ model: 'shared', provider: 'zen' },
				{
					currentProvider: 'openai',
					detected: [detected('openai'), detected('zen')],
					describeModels,
				},
			),
		).resolves.toEqual({ kind: 'resolved', selection: { id: 'zen', model: 'shared' } })
		expect(describeModels.mock.calls.map(([id]) => id)).toEqual(['zen'])
	})

	it('does not fall back when the requested explicit provider lacks the model', async () => {
		const describeModels = listingProvider({ openai: catalogue('target'), zen: catalogue('other') })
		const result = await resolveModelSwitch(
			{ model: 'target', provider: 'zen' },
			{
				currentProvider: 'openai',
				detected: [detected('openai'), detected('zen')],
				describeModels,
			},
		)
		expect(result).toMatchObject({
			kind: 'rejected',
			choices: [{ provider: 'zen', model: 'other' }],
		})
		expect(describeModels.mock.calls.map(([id]) => id)).toEqual(['zen'])
	})

	it.each(['missing', 'OpenAI', 'lmstudio'])(
		'rejects unavailable or inexact provider %s before catalogue access',
		async (provider) => {
			const describeModels = listingProvider({ openai: catalogue('target') })
			const result = await resolveModelSwitch(
				{ model: 'target', provider },
				{
					currentProvider: 'openai',
					detected: [detected('openai'), detected('lmstudio')],
					describeModels,
				},
			)
			expect(result.kind).toBe('rejected')
			expect(describeModels).not.toHaveBeenCalled()
		},
	)

	it('rejects friendly aliases and offers actual catalogue IDs', async () => {
		const result = await resolveModelSwitch(
			{ model: 'Claude' },
			{
				currentProvider: 'anthropic',
				detected: [detected('anthropic')],
				describeModels: listingProvider({
					anthropic: { kind: 'ok', models: [{ id: 'claude-opus-5', name: 'Claude' }] },
				}),
			},
		)
		expect(result).toMatchObject({
			kind: 'rejected',
			choices: [{ provider: 'anthropic', model: 'claude-opus-5' }],
		})
	})

	it.each<ModelListing>([
		{ kind: 'unsupported' },
		{ kind: 'timeout' },
		{ kind: 'failed', reason: 'private-token' },
		catalogue(),
	])('does not manufacture a default for listing $kind', async (listing) => {
		const result = await resolveModelSwitch(
			{ model: PROVIDER_REGISTRY.openai.defaultModel },
			{
				currentProvider: 'openai',
				detected: [detected('openai')],
				describeModels: listingProvider({ openai: listing }),
			},
		)
		expect(result.kind).toBe('rejected')
		expect(JSON.stringify(result)).not.toContain('private-token')
	})

	it('does not expose a thrown catalogue error that could include authentication', async () => {
		const result = await resolveModelSwitch(
			{ model: 'target' },
			{
				currentProvider: 'openai',
				detected: [detected('openai')],
				describeModels: async () => {
					throw new Error('Bearer fixture-secret')
				},
			},
		)
		expect(result).toMatchObject({ kind: 'rejected', reason: expect.stringContaining('openai') })
		expect(JSON.stringify(result)).not.toContain('fixture-secret')
	})

	it.each([undefined, 'public'])(
		'admits a listed anonymous Zen model with credential %s',
		async (apiKey) => {
			const model = 'muse-spark-1.3-contributor-free'
			await expect(
				resolveModelSwitch(
					{ model },
					{
						currentProvider: 'zen',
						detected: [{ ...detected('zen'), apiKey }],
						describeModels: listingProvider({ zen: catalogue(model) }),
					},
				),
			).resolves.toEqual({ kind: 'resolved', selection: { id: 'zen', model } })
		},
	)

	it.each(['glm-5.3-flash', 'unknown-free'])(
		'refuses anonymous Zen model %s before listing',
		async (model) => {
			const describeModels = listingProvider({ zen: catalogue(model) })
			const result = await resolveModelSwitch(
				{ model, provider: 'zen' },
				{
					currentProvider: 'zen',
					detected: [{ ...detected('zen'), apiKey: undefined }],
					describeModels,
				},
			)
			expect(result).toMatchObject({
				kind: 'rejected',
				reason: expect.stringContaining('credential'),
			})
			expect(describeModels).not.toHaveBeenCalled()
		},
	)

	it('does not admit an anonymous free model missing from the actual catalogue', async () => {
		const result = await resolveModelSwitch(
			{ model: 'muse-spark-1.3-contributor-free' },
			{
				currentProvider: 'zen',
				detected: [{ ...detected('zen'), apiKey: undefined }],
				describeModels: listingProvider({ zen: catalogue('big-pickle', 'glm-5.3-flash') }),
			},
		)
		expect(result).toMatchObject({
			kind: 'rejected',
			choices: [{ provider: 'zen', model: 'big-pickle' }],
		})
	})

	it('rejects an already cancelled request without catalogue access', async () => {
		const controller = new AbortController()
		const cause = new Error('cancelled by operator')
		controller.abort(cause)
		const describeModels = listingProvider({ openai: catalogue('target') })
		await expect(
			resolveModelSwitch(
				{ model: 'target' },
				{
					currentProvider: 'openai',
					detected: [detected('openai')],
					describeModels,
					signal: controller.signal,
				},
			),
		).rejects.toBe(cause)
		expect(describeModels).not.toHaveBeenCalled()
	})

	it('rejects a late catalogue result after cancellation', async () => {
		const controller = new AbortController()
		const cause = new Error('conversation departed')
		await expect(
			resolveModelSwitch(
				{ model: 'target' },
				{
					currentProvider: 'openai',
					detected: [detected('openai')],
					signal: controller.signal,
					describeModels: async (_id, _detected, signal) => {
						expect(signal).toBe(controller.signal)
						controller.abort(cause)
						return catalogue('target')
					},
				},
			),
		).rejects.toBe(cause)
	})
})
