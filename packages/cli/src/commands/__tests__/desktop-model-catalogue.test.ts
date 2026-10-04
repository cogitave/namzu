import { expect, it } from 'vitest'
import { desktopModelCatalogue } from '../desktop-model-catalogue.js'

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
		models: [{ id: 'free', label: 'Free model', note: '(Namzu default · image input)' }],
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
