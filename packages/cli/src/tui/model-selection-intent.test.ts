import { expect, it } from 'vitest'
import { PROVIDER_REGISTRY } from '../integrations/providers/index.js'
import { parseModelSelectionIntent, resolveModelSelectionIntent } from './model-selection-intent.js'

it('recognizes only standalone selection commands and requests', () => {
	for (const text of [
		'modeli opus-5 yapar mısın',
		'/model opus-5',
		'change model to opus-5',
		'Could you switch the model to opus-5?',
	]) {
		expect(parseModelSelectionIntent(text)).toEqual({ query: 'opus-5' })
	}
	for (const text of [
		'/model',
		'modeli opus-5 yapar mısın ve testleri çalıştır',
		'switch model to opus-5 and fix the bug',
		'Explain how to change model to opus-5',
		'modeli opus-5 yapar mısın\nthen fix it',
	]) {
		expect(parseModelSelectionIntent(text)).toBeUndefined()
	}
})

it('resolves only authenticated exact IDs or unique complete version suffixes', async () => {
	const options = {
		currentProvider: 'anthropic' as const,
		detected: [
			{
				entry: PROVIDER_REGISTRY.anthropic,
				apiKey: 'fixture',
				source: { kind: 'env' as const, envName: 'KEY' },
				alternatives: [],
			},
		],
		describeModels: async () => ({
			kind: 'ok' as const,
			models: [{ id: 'claude-opus-5', name: 'Opus' }],
		}),
	}
	expect(await resolveModelSelectionIntent('opus-5', options)).toMatchObject({
		kind: 'resolved',
		selection: { id: 'anthropic', model: 'claude-opus-5' },
	})
	expect(await resolveModelSelectionIntent('CLAUDE-OPUS-5', options)).toMatchObject({
		kind: 'resolved',
	})
	expect(await resolveModelSelectionIntent('opus', options)).toMatchObject({ kind: 'rejected' })
	expect(
		await resolveModelSelectionIntent('opus-5', {
			...options,
			detected: options.detected.map((provider) => ({ ...provider, apiKey: undefined })),
		}),
	).toMatchObject({ kind: 'rejected' })
	expect(
		await resolveModelSelectionIntent('opus-5', {
			...options,
			describeModels: async () => ({
				kind: 'ok',
				models: [
					{ id: 'claude-opus-5', name: 'One' },
					{ id: 'other-opus-5', name: 'Two' },
				],
			}),
		}),
	).toMatchObject({ kind: 'rejected', reason: expect.stringContaining('ambiguous') })
})

it('recognizes Turkish dative requests and resolves catalogue IDs before suffix removal', async () => {
	for (const text of [
		'gpt-5.6 lunaya geçer misin',
		'gpt-5.6-luna’ya geç',
		'gpt-5.6-luna’ya geçer misin',
	])
		expect(parseModelSelectionIntent(text)).toBeDefined()
	expect(parseModelSelectionIntent('gpt-5.6 lunaya geçer misin ve kodu düzelt')).toBeUndefined()
	const options = {
		currentProvider: 'codex' as const,
		detected: [
			{
				entry: PROVIDER_REGISTRY.codex,
				apiKey: 'fixture',
				source: { kind: 'env' as const, envName: 'KEY' },
				alternatives: [],
			},
		],
		describeModels: async () => ({
			kind: 'ok' as const,
			models: [{ id: 'gpt-5.6-luna', name: 'Luna' }],
		}),
	}
	for (const query of ['gpt-5.6 lunaya', 'gpt-5.6-luna’ya', 'codex/gpt-5.6-luna'])
		expect(await resolveModelSelectionIntent(query, options)).toMatchObject({
			kind: 'resolved',
			selection: { model: 'gpt-5.6-luna' },
		})
	expect(
		await resolveModelSelectionIntent('gpt-5.6-lunaya', {
			...options,
			describeModels: async () => ({
				kind: 'ok',
				models: [
					{ id: 'gpt-5.6-luna', name: 'A' },
					{ id: 'gpt-5.6-lunaya', name: 'B' },
				],
			}),
		}),
	).toMatchObject({ kind: 'resolved', selection: { model: 'gpt-5.6-lunaya' } })
})

it('prefers exact current-provider IDs and accepts explicit provider selection', async () => {
	const options = {
		currentProvider: 'anthropic' as const,
		detected: [PROVIDER_REGISTRY.anthropic, PROVIDER_REGISTRY.codex].map((entry) => ({
			entry,
			apiKey: 'fixture',
			source: { kind: 'env' as const, envName: 'KEY' },
			alternatives: [],
		})),
		describeModels: async () => ({
			kind: 'ok' as const,
			models: [{ id: 'claude-opus-5', name: 'Opus' }],
		}),
	}
	expect(await resolveModelSelectionIntent('claude-opus-5', options)).toMatchObject({
		kind: 'resolved',
		selection: { id: 'anthropic' },
	})
	expect(await resolveModelSelectionIntent('codex/opus-5', options)).toMatchObject({
		kind: 'resolved',
		selection: { id: 'codex' },
	})
	expect(await resolveModelSelectionIntent('opus-5', options)).toMatchObject({ kind: 'rejected' })
})
