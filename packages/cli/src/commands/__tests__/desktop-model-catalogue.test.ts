import { describe, expect, it } from 'vitest'
import { desktopModelCatalogue, modelListLabel } from '../desktop-model-catalogue.js'

it('never treats an absent default or saved pin as a published model', () => {
	expect(
		desktopModelCatalogue(
			{ kind: 'ok', models: [{ id: 'served', name: 'Served model' }] },
			'old-default',
			'unavailable-pin',
			() => true,
		),
	).toEqual({
		models: [{ id: 'served', label: 'Served model' }],
		notice:
			'The selected model is not in this catalogue. Choose a listed model or another provider.',
	})
})

it('distinguishes credential rejection without exposing a remote error or inventing fallback models', () => {
	const result = desktopModelCatalogue(
		{
			kind: 'failed',
			failure: 'authentication',
			reason: 'SYNTHETIC_CREDENTIAL_IN_REMOTE_ERROR',
		},
		'default',
		undefined,
		() => true,
	)
	expect(result.models).toEqual([])
	expect(result.notice).toContain('rejected its credential')
	expect(JSON.stringify(result)).not.toContain('SYNTHETIC_CREDENTIAL')
})

it('reports a missing admitted credential without treating it as a server rejection', () => {
	const result = desktopModelCatalogue(
		{
			kind: 'failed',
			failure: 'credential-unavailable',
			reason: 'SYNTHETIC_PRIVATE_OWNER_PATH',
		},
		'default',
		undefined,
		() => true,
	)
	expect(result.models).toEqual([])
	expect(result.notice).toContain('no longer available on this device')
	expect(result.notice).not.toContain('rejected')
	expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE_OWNER_PATH')
})

it('filters inaccessible and malformed identities, retaining honest free and image notes', () => {
	expect(
		desktopModelCatalogue(
			{
				kind: 'ok',
				models: [
					{ id: 'paid', name: 'Paid model' },
					{ id: 'control\nmodel', name: 'Invalid' },
					{ id: 'x'.repeat(401), name: 'Too long' },
					{
						id: 'free',
						name: 'Free model',
						inputPrice: 0,
						outputPrice: 0,
						inputModalities: ['text', 'image'],
					},
					{ id: 'free', name: 'Duplicate' },
				],
			},
			'free',
			'free',
			(id) => id !== 'paid',
		),
	).toEqual({
		models: [
			{
				id: 'free',
				label: 'Free model',
				note: '(image input)',
				default: true,
			},
		],
		notice: null,
	})
})

it('keeps empty, unsupported and timeout catalogues distinct without adding registry rows', () => {
	for (const listing of [
		{ kind: 'ok' as const, models: [] },
		{ kind: 'unsupported' as const },
		{ kind: 'timeout' as const },
	]) {
		const result = desktopModelCatalogue(listing, 'default', undefined, () => true)
		expect(result.models).toEqual([])
		expect(result.notice).toBeTruthy()
	}
})

describe('modelListLabel', () => {
	it.each([
		['GPT-5.6-Sol', 'gpt-5.6-sol', 'GPT-5.6 Sol'],
		['GPT-5.6-mini', 'gpt-5.6-mini', 'GPT-5.6 mini'],
		['GPT-5.6-Codex-Max', 'gpt-5.6-codex-max', 'GPT-5.6-Codex-Max'],
		['gpt-4o', 'gpt-4o', 'gpt-4o'],
		['gpt-4-turbo', 'gpt-4-turbo', 'gpt-4-turbo'],
		['o3-mini', 'o3-mini', 'o3-mini'],
		['Claude Opus 5.5', 'claude-opus-5-5', 'Claude Opus 5.5'],
		['qwen2.5-coder', 'qwen2.5-coder', 'qwen2.5-coder'],
		['llama-3.3-70b', 'llama-3.3-70b', 'llama-3.3-70b'],
		['GPT-5.6-Sol', 'GPT-5.6-Sol', 'GPT-5.6-Sol'],
	])('%s (id %s) reads %s', (name, id, expected) => {
		expect(modelListLabel(name, id)).toBe(expected)
	})
})

it('notes a model whose limits are not published yet', () => {
	const result = desktopModelCatalogue(
		{
			kind: 'ok',
			models: [
				{
					id: 'new-free',
					name: 'New Free',
					inputPrice: 0,
					outputPrice: 0,
					limitsVerified: false,
				},
				{ id: 'known', name: 'Known', inputPrice: 1, outputPrice: 2 },
			],
		},
		'known',
		'known',
		() => true,
	)
	expect(result.models).toEqual([
		{ id: 'new-free', label: 'New Free', note: '(Limits not published yet)' },
		{ id: 'known', label: 'Known', default: true },
	])
})

it('marks a model the listing flags as needing an API key', () => {
	const result = desktopModelCatalogue(
		{
			kind: 'ok',
			models: [
				{
					id: 'paid',
					name: 'Paid',
					inputPrice: 1,
					outputPrice: 2,
					requiresKey: true,
				},
			],
		},
		'other',
		undefined,
		() => true,
	)
	expect(result.models).toEqual([{ id: 'paid', label: 'Paid', note: '(API key)' }])
})
