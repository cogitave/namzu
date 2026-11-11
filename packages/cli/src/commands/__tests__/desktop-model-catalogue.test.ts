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
		notice: 'The selected model isn’t offered any more. Choose one from the list.',
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
	expect(result.notice).toContain('didn’t accept your key or sign-in')
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
	expect(result.notice).toContain('no longer available on this computer')
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
				inputPrice: 0,
				outputPrice: 0,
			},
		],
		notice: null,
	})
})

it('names the provider and says why the list is empty, with no catalogue or credential wording', () => {
	const rejected = desktopModelCatalogue(
		{ kind: 'failed', failure: 'authentication', reason: 'denied' },
		'default',
		undefined,
		() => true,
		'OpenAI',
	)
	expect(rejected.notice).toBe(
		'OpenAI didn’t accept your key or sign-in, so its models can’t be listed. Check it in Settings.',
	)
	const unreachable = desktopModelCatalogue(
		{ kind: 'failed', reason: 'offline' },
		'default',
		undefined,
		() => true,
		'Anthropic (Claude)',
	)
	expect(unreachable.notice).toBe(
		'Namzu couldn’t reach Anthropic to list its models. Check your connection, then try again.',
	)
	const empty = desktopModelCatalogue(
		{ kind: 'ok', models: [] },
		'default',
		'gone',
		() => true,
		'OpenAI',
	)
	expect(empty.notice).toBe('OpenAI doesn’t offer any models to this account right now.')
	for (const result of [rejected, unreachable, empty])
		expect(result.notice).not.toMatch(/catalogue|credential/i)
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
		{
			id: 'new-free',
			label: 'New Free',
			note: '(Limits not published yet)',
			inputPrice: 0,
			outputPrice: 0,
		},
		{ id: 'known', label: 'Known', default: true, inputPrice: 1, outputPrice: 2 },
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
					group: 'key',
				},
			],
		},
		'other',
		undefined,
		() => true,
	)
	// Alone it has no heading to sit under, so the row keeps its note.
	expect(result.models).toEqual([
		{ id: 'paid', label: 'Paid', note: '(API key)', group: 'key', inputPrice: 1, outputPrice: 2 },
	])
})

describe('Zen groups on the wire', () => {
	const rows = (
		models: Parameters<typeof desktopModelCatalogue>[0] extends infer L
			? L extends { kind: 'ok'; models: infer M }
				? M
				: never
			: never,
	) => desktopModelCatalogue({ kind: 'ok', models }, 'other', undefined, () => true).models

	it('carries the group and drops the key note when both headings will show', () => {
		expect(
			rows([
				{ id: 'f', name: 'F', inputPrice: 0, outputPrice: 0, group: 'free' },
				{ id: 'k', name: 'K', inputPrice: 1, outputPrice: 1, requiresKey: true, group: 'key' },
				{ id: 'u', name: 'U' },
			]),
		).toEqual([
			{ id: 'f', label: 'F', note: '(free)', group: 'free', inputPrice: 0, outputPrice: 0 },
			{ id: 'k', label: 'K', group: 'key', inputPrice: 1, outputPrice: 1 },
			{ id: 'u', label: 'U' },
		])
	})

	it('leaves a provider without groups exactly as it was', () => {
		expect(rows([{ id: 'a', name: 'A', inputPrice: 0, outputPrice: 0 }])).toEqual([
			{ id: 'a', label: 'A', note: '(free)', inputPrice: 0, outputPrice: 0 },
		])
	})

	it('keeps the key note when every free row was filtered out', () => {
		const result = desktopModelCatalogue(
			{
				kind: 'ok',
				models: [
					{ id: 'f', name: 'F', inputPrice: 0, outputPrice: 0, group: 'free' },
					{ id: 'k', name: 'K', inputPrice: 1, outputPrice: 1, requiresKey: true, group: 'key' },
				],
			},
			'other',
			undefined,
			(id) => id === 'k',
		)
		expect(result.models).toEqual([
			{ id: 'k', label: 'K', note: '(API key)', group: 'key', inputPrice: 1, outputPrice: 1 },
		])
	})
})

it('carries the window and rates a source published, and nothing it did not', () => {
	const { models } = desktopModelCatalogue(
		{
			kind: 'ok',
			models: [
				{ id: 'known', name: 'Known', contextWindow: 200_000, inputPrice: 3, outputPrice: 15 },
				{ id: 'free', name: 'Free one', contextWindow: 32_000, inputPrice: 0, outputPrice: 0 },
				{ id: 'bare', name: 'Bare' },
			],
		},
		'known',
		'known',
		() => true,
	)
	expect(models.find((row) => row.id === 'known')).toMatchObject({
		contextWindow: 200_000,
		inputPrice: 3,
		outputPrice: 15,
	})
	expect(models.find((row) => row.id === 'free')).toMatchObject({ inputPrice: 0, outputPrice: 0 })
	const bare = models.find((row) => row.id === 'bare')
	expect(bare).not.toHaveProperty('contextWindow')
	expect(bare).not.toHaveProperty('inputPrice')
})
