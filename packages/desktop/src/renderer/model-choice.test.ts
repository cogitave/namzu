import { describe, expect, it } from 'vitest'
import type { ProviderView } from '../shared/protocol.js'
import {
	effortLabel,
	effortOrder,
	effortToSend,
	followCatalogue,
	isUnchosen,
	modelDisplayLabel,
	modelSections,
	pickOfferedPalModel,
	recommendedRow,
	resolveComposerModelChoice,
	resolveEffort,
	settleKey,
	splitModels,
	staleEffort,
	startingRow,
	triggerLabel,
} from './model-choice.js'

const profile = { provider: 'zen', model: 'space-bunny-free' }
const global: ProviderView = {
	available: [
		{ id: 'openai', label: 'OpenAI', defaultModel: 'host-default' },
		{ id: 'zen', label: 'Zen', defaultModel: 'space-bunny-free' },
	],
	selected: { id: 'openai', model: 'global-preference' },
}

it('retains the saved Pal default during restart before its catalogue metadata is ready', () => {
	expect(
		resolveComposerModelChoice({
			providers: { available: [], selected: null },
			palModel: profile,
			sessionId: '',
		}),
	).toEqual(profile)
})

it('uses the saved Pal default for a new conversation independently of host preferences', () => {
	expect(
		resolveComposerModelChoice({ providers: global, palModel: profile, sessionId: '' }),
	).toEqual(profile)
})

it('keeps an existing conversation on its own pinned route after the Pal default changes', () => {
	expect(
		resolveComposerModelChoice({
			providers: { ...global, selected: { id: 'zen', model: 'old-profile-model' } },
			palModel: { provider: 'openai', model: 'new-profile-model' },
			sessionId: 'claimed-conversation',
		}),
	).toEqual({ provider: 'zen', model: 'old-profile-model' })
	expect(
		resolveComposerModelChoice({
			providers: { available: [], selected: null },
			palModel: profile,
			sessionId: 'claimed-conversation',
		}),
	).toEqual({ provider: '', model: '' })
})

it('preserves an explicit unsent draft choice instead of replacing it with a profile default', () => {
	const draftChoice = { provider: 'zen', model: 'draft-model', label: 'Draft model' }
	expect(
		resolveComposerModelChoice({
			providers: global,
			palModel: profile,
			draftChoice,
			sessionId: '',
		}),
	).toEqual(draftChoice)
})

it('preserves host preferences and provider defaults when the Pal has no explicit model', () => {
	expect(resolveComposerModelChoice({ providers: global, palModel: null, sessionId: '' })).toEqual({
		provider: 'openai',
		model: 'global-preference',
	})
	expect(
		resolveComposerModelChoice({
			providers: { ...global, selected: { id: 'openai' } },
			sessionId: '',
		}),
	).toEqual({ provider: 'openai', model: 'host-default' })
})

const rows = [
	{ id: 'gpt-top', label: 'GPT Top', default: true as const },
	{ id: 'gpt-other', label: 'GPT Other' },
]

it('names a model from the catalogue first, then the saved label, then the id', () => {
	expect(modelDisplayLabel({ model: 'gpt-other', label: 'Stale name' }, rows)).toBe('GPT Other')
	expect(modelDisplayLabel({ model: 'unlisted', label: 'Saved name' }, rows)).toBe('Saved name')
	expect(modelDisplayLabel({ model: 'unlisted' }, rows)).toBe('unlisted')
	expect(modelDisplayLabel({ model: 'gpt-other', label: 'Saved' }, undefined)).toBe('Saved')
})

it('resolves a choice saved under the retired default preset once, into an ordinary choice', () => {
	const retired = {
		provider: 'codex-cli',
		model: 'gpt-old',
		label: 'GPT Old',
		preset: 'default' as const,
	}
	const resolved = followCatalogue(retired, rows)
	expect(resolved).toEqual({ provider: 'codex-cli', model: 'gpt-top', label: 'GPT Top' })
	expect(resolved).not.toHaveProperty('preset')
	// With no row to resolve to, only the preset is dropped; the saved model stays.
	expect(followCatalogue(retired, [{ id: 'gpt-other', label: 'GPT Other' }])).toEqual({
		provider: 'codex-cli',
		model: 'gpt-old',
		label: 'GPT Old',
	})
	expect(followCatalogue(retired, undefined)).toBeUndefined()
})

it('does not move an explicit choice, but refreshes its saved label', () => {
	const explicit = { provider: 'codex-cli', model: 'gpt-other' }
	expect(followCatalogue(explicit, rows)).toBeUndefined()
	expect(followCatalogue({ ...explicit, label: 'Renamed' }, rows)).toEqual({
		...explicit,
		label: 'GPT Other',
	})
	expect(followCatalogue({ ...explicit, label: 'GPT Other' }, rows)).toBeUndefined()
})

it('labels effort in title case and shows the saved level only while the model offers it', () => {
	expect(effortOrder.map(effortLabel)).toEqual([
		'None',
		'Minimal',
		'Low',
		'Medium',
		'High',
		'Extra High',
		'Max',
		'Ultra',
	])
	const settings = {
		effortLevels: ['max', 'low', 'medium'] as const,
		effortDefault: 'medium' as const,
	}
	expect(resolveEffort(settings, 'max')).toEqual({
		levels: ['low', 'medium', 'max'],
		value: 'max',
		explicit: true,
	})
	expect(resolveEffort(settings, 'high')).toEqual({
		levels: ['low', 'medium', 'max'],
		value: 'medium',
		explicit: false,
	})
	expect(resolveEffort({ effortLevels: ['low', 'high'] }, undefined).value).toBeUndefined()
	expect(resolveEffort(null, 'low')).toEqual({ levels: [], explicit: false })
})

it('keeps a saved effort across a model change while the new model offers it', () => {
	expect(staleEffort(null, 'high')).toBe(false)
	expect(staleEffort({ effortLevels: ['low', 'high'] }, 'high')).toBe(false)
	expect(staleEffort({ effortLevels: ['low', 'medium'] }, 'high')).toBe(true)
	expect(staleEffort({}, 'high')).toBe(true)
	// A failed read decides nothing: the saved effort stays, and only that turn leaves it off.
	expect(staleEffort({ notice: 'Could not be loaded.' }, 'high')).toBe(false)
	expect(effortToSend({ notice: 'Could not be loaded.' }, 'high')).toBeUndefined()
	expect(effortToSend({ effortLevels: ['high'] }, 'high')).toBe('high')
	expect(effortToSend({ effortLevels: ['low'] }, 'high')).toBeUndefined()
	expect(effortToSend(null, 'high')).toBe('high')
	expect(staleEffort({ effortLevels: ['low'] }, undefined)).toBe(false)
})

it('names a heading for each row only when a list holds both Zen groups', () => {
	const rows = [
		{ id: 'f1', label: 'F1', group: 'free' as const },
		{ id: 'f2', label: 'F2', group: 'free' as const },
		{ id: 'k1', label: 'K1', group: 'key' as const },
		{ id: 'u1', label: 'U1' },
	]
	expect(modelSections(rows)).toEqual(
		new Map([
			['f1', 'free'],
			['f2', 'free'],
			['k1', 'key'],
			['u1', 'other'],
		]),
	)
	expect(modelSections(rows.slice(0, 2))).toBeUndefined()
	expect(modelSections(rows.slice(2))).toBeUndefined()
	expect(modelSections([{ id: 'a', label: 'A' }])).toBeUndefined()
	// A row ahead of every grouped one sits under no heading.
	const ahead = modelSections([{ id: 'x', label: 'X' }, ...rows.filter((r) => r.group)])
	expect(ahead?.has('x')).toBe(false)
})

const row = (id: string, label: string, extra: object = {}) => ({ id, label, ...extra })
const ids = (rows: readonly { id: string }[]) => rows.map((item) => item.id)

it('splits a long Anthropic-like list into the newest of each family and the older rest', () => {
	const list = [
		row('claude-haiku-5-5', 'Claude Haiku 5.5'),
		row('claude-sonnet-5-5', 'Claude Sonnet 5.5'),
		row('claude-opus-5-5', 'Claude Opus 5.5'),
		row('claude-fable-5-1', 'Claude Fable 5.1'),
		row('claude-opus-5', 'Claude Opus 5'),
		row('claude-sonnet-5', 'Claude Sonnet 5'),
		row('claude-opus-4-8', 'Claude Opus 4.8'),
		row('claude-haiku-4-5', 'Claude Haiku 4.5'),
	]
	const { current, older } = splitModels(list)
	expect(ids(current)).toEqual([
		'claude-haiku-5-5',
		'claude-sonnet-5-5',
		'claude-opus-5-5',
		'claude-fable-5-1',
	])
	expect(ids(older)).toEqual([
		'claude-opus-5',
		'claude-sonnet-5',
		'claude-opus-4-8',
		'claude-haiku-4-5',
	])
})

it('treats a dated id as the same version as its undated sibling', () => {
	const list = [
		row('claude-haiku-4-5-20251001', 'Claude Haiku 4.5'),
		row('claude-haiku-4-5', 'Claude Haiku 4.5'),
		row('claude-opus-5-5', 'Claude Opus 5.5'),
		row('claude-opus-5-4-20260101', 'Claude Opus 5.4'),
		row('a', 'Alpha 1'),
		row('b', 'Beta 1'),
		row('claude-opus-4-0', 'Claude Opus 4'),
	]
	// Haiku 4.5 is behind its maker's newest major, so both of its ids fold together; Alpha and
	// Beta are other makers' only models, so they stay.
	expect(ids(splitModels(list).older)).toEqual([
		'claude-haiku-4-5-20251001',
		'claude-haiku-4-5',
		'claude-opus-5-4-20260101',
		'claude-opus-4-0',
	])
	const dated = [
		row('x-1-20250101', 'X 1'),
		row('x-1', 'X 1'),
		row('y-1', 'Y 1'),
		row('z-1', 'Z 1'),
		row('w-1', 'W 1'),
		row('v-1', 'V 1'),
		row('u-1', 'U 1'),
	]
	expect(splitModels(dated).older).toEqual([])
})

it('keeps the source order and honours the source saying a model is current', () => {
	const list = [
		row('opus', 'Opus 5.5', { current: true }),
		row('fable', 'Fable 5.1', { current: true }),
		row('sonnet', 'Sonnet 5.5', { current: true }),
		row('haiku', 'Haiku 4.5', { current: true }),
		row('claude-sonnet-5', 'Sonnet 5'),
		row('claude-opus-4-8', 'Opus 4.8'),
		row('claude-opus-4-7', 'Opus 4.7'),
	]
	const { current, older } = splitModels(list)
	expect(ids(current)).toEqual(['opus', 'fable', 'sonnet', 'haiku'])
	expect(ids(older)).toEqual(['claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-7'])
})

it('folds a whole older generation of a Codex-like list but not its latest families', () => {
	const list = [
		row('gpt-6.1-sol', 'GPT-6.1 Sol', { default: true, current: true }),
		row('gpt-6-astra', 'GPT-6 Astra'),
		row('gpt-6-sol', 'GPT-6 Sol'),
		row('gpt-6-luna', 'GPT-6 Luna'),
		row('gpt-5.6-sol', 'GPT-5.6 Sol'),
		row('gpt-5.6-terra', 'GPT-5.6 Terra'),
		row('gpt-5.6-luna', 'GPT-5.6 Luna'),
	]
	const { current, older } = splitModels(list)
	expect(ids(current)).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'])
	expect(ids(older)).toEqual(['gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])
})

it('shows a short or unparseable list whole, in source order', () => {
	const short = [row('a-1', 'A 1'), row('a-2', 'A 2'), row('a-3', 'A 3')]
	expect(splitModels(short)).toEqual({ current: short, older: [] })
	const unversioned = Array.from({ length: 9 }, (_, index) =>
		row(`m${'q'.repeat(index + 1)}`, `Model${'x'.repeat(index)}`),
	)
	expect(splitModels(unversioned)).toEqual({ current: unversioned, older: [] })
	expect(splitModels([])).toEqual({ current: [], older: [] })
})

it('recommends only the flagged row while it is current, and starts from it, else the first current', () => {
	const list = [
		row('new-2', 'Fam 2'),
		row('top-2', 'Top 2', { default: true }),
		row('c-2', 'C 2'),
		row('d-2', 'D 2'),
		row('e-2', 'E 2'),
		row('f-2', 'F 2'),
		row('old-1', 'Fam 1'),
	]
	expect(recommendedRow(list)?.id).toBe('top-2')
	expect(startingRow(list)?.id).toBe('top-2')
	// A flagged default that is an older release is not recommended; the first current row starts.
	const stale = list.map((item) =>
		item.id === 'old-1' ? { ...item, default: true as const } : { ...item, default: undefined },
	)
	expect(recommendedRow(stale)).toBeUndefined()
	expect(startingRow(stale)?.id).toBe('new-2')
	expect(startingRow(undefined)).toBeUndefined()
})

it('knows a conversation that has not started and has nothing chosen anywhere', () => {
	const providers = { available: [{ id: 'a', label: 'A', defaultModel: 'm' }], selected: null }
	expect(isUnchosen({ providers, started: false })).toBe(true)
	expect(isUnchosen({ providers, started: true })).toBe(false)
	expect(
		isUnchosen({ providers, started: false, draftChoice: { provider: 'a', model: 'm' } }),
	).toBe(false)
	expect(isUnchosen({ providers, started: false, palModel: { provider: 'a', model: 'm' } })).toBe(
		false,
	)
	const preferred = { ...providers, selected: { id: 'a', model: 'm' } }
	expect(isUnchosen({ providers: preferred, started: false })).toBe(false)
})

it('judges the newest generation per maker, so a mixed list keeps every maker latest models', () => {
	const list = [
		row('gpt-5', 'GPT-5'),
		row('claude-sonnet-4-5', 'Claude Sonnet 4.5'),
		row('claude-opus-4-1', 'Claude Opus 4.1'),
		row('claude-sonnet-3-7', 'Claude Sonnet 3.7'),
		row('gemini-3-pro', 'Gemini 3 Pro'),
		row('gemini-2-5-pro', 'Gemini 2.5 Pro'),
		row('gpt-4o', 'GPT-4o'),
	]
	const { current, older } = splitModels(list)
	expect(ids(current)).toEqual(['gpt-5', 'claude-sonnet-4-5', 'claude-opus-4-1', 'gemini-3-pro'])
	expect(ids(older)).toEqual(['claude-sonnet-3-7', 'gemini-2-5-pro', 'gpt-4o'])
})

describe('triggerLabel', () => {
	const rows = [{ id: 'a', label: 'Model A' }]
	it('never flashes the prompt or a raw id while the catalogue or the choice resolves', () => {
		expect(triggerLabel({ model: '', rows: undefined, catalogue: 'idle', pending: true })).toEqual({
			text: '',
			pending: true,
			named: false,
		})
		expect(
			triggerLabel({
				model: 'sample-balanced',
				rows: undefined,
				catalogue: 'loading',
				pending: false,
			}),
		).toEqual({ text: '', pending: true, named: false })
		expect(
			triggerLabel({
				model: 'sample-balanced',
				rows: undefined,
				catalogue: 'idle',
				pending: true,
			}),
		).toEqual({ text: '', pending: true, named: false })
	})
	it('names the model from the catalogue, else the saved label, else the id once the catalogue is known or failed', () => {
		expect(
			triggerLabel({ model: 'a', label: 'old', rows, catalogue: 'ready', pending: true }),
		).toEqual({ text: 'Model A', pending: false, named: true })
		expect(
			triggerLabel({
				model: 'x',
				label: 'Saved',
				rows: undefined,
				catalogue: 'loading',
				pending: true,
			}),
		).toEqual({ text: 'Saved', pending: false, named: true })
		expect(triggerLabel({ model: 'x', rows, catalogue: 'ready', pending: false }).text).toBe('x')
		// A bare id is no name: it is never kept to stand in for one while the list is read again.
		expect(triggerLabel({ model: 'x', rows, catalogue: 'ready', pending: false }).named).toBe(false)
		expect(
			triggerLabel({ model: 'x', rows: undefined, catalogue: 'error', pending: false }).text,
		).toBe('x')
	})
	it("lets another conversation's list of the same engine name a model, never prove it absent", () => {
		const named = triggerLabel({
			model: 'a',
			rows: undefined,
			fallbackRows: rows,
			catalogue: 'loading',
			pending: false,
		})
		expect(named).toMatchObject({ text: 'Model A', named: true })
		const unlisted = triggerLabel({
			model: 'x',
			rows: undefined,
			fallbackRows: rows,
			catalogue: 'loading',
			pending: false,
		})
		expect(unlisted).toMatchObject({ text: '', pending: true })
	})
	it('shows the prompt only for a settled picker with nothing to show', () => {
		expect(triggerLabel({ model: '', rows: undefined, catalogue: 'idle', pending: false })).toEqual(
			{
				text: 'Select model',
				pending: false,
				named: false,
			},
		)
	})
})

describe('settleKey', () => {
	it('differs per scope, so one conversation settling does not suppress the next', () => {
		expect(settleKey('p:one', 'sample', 'haiku')).not.toBe(settleKey('p:two', 'sample', 'haiku'))
		expect(settleKey('p:one', 'sample', 'haiku')).toBe(settleKey('p:one', 'sample', 'haiku'))
	})
})

describe('the model a new Pal starts with', () => {
	const providers = {
		available: [
			{ id: 'anthropic', label: 'Anthropic', defaultModel: 'claude-opus-5' },
			{ id: 'ollama', label: 'Ollama', defaultModel: 'llama' },
		],
		selected: { id: 'anthropic', model: 'claude-opus-5' },
	}
	const catalogue = (ids: string[]) => ({
		models: ids.map((id) => ({ id, label: id.toUpperCase() })),
		notice: null,
	})
	it('prefers the composer choice when its provider lists it', async () => {
		const picked = await pickOfferedPalModel({
			candidates: [
				{ provider: 'ollama', model: 'llama' },
				{ provider: 'anthropic', model: 'claude-opus-5' },
			],
			providers,
			loadModels: async (provider) =>
				provider === 'ollama' ? catalogue(['llama']) : catalogue(['claude-opus-5']),
		})
		expect(picked).toEqual({ provider: 'ollama', model: 'llama', label: 'LLAMA' })
	})
	it('never picks a configured model that the connected provider does not list', async () => {
		const picked = await pickOfferedPalModel({
			candidates: [{ provider: 'anthropic', model: 'claude-opus-5' }],
			providers,
			loadModels: async () => catalogue(['claude-haiku-5-5']),
		})
		expect(picked).toEqual({
			provider: 'anthropic',
			model: 'claude-haiku-5-5',
			label: 'CLAUDE-HAIKU-5-5',
		})
	})
	it('chooses nothing when no list can be read, and ignores a provider that is not connected', async () => {
		expect(
			await pickOfferedPalModel({
				candidates: [{ provider: 'anthropic', model: 'claude-opus-5' }],
				providers,
				loadModels: async () => {
					throw new Error('offline')
				},
			}),
		).toBeUndefined()
		expect(
			await pickOfferedPalModel({
				candidates: [{ provider: 'gone', model: 'x' }],
				providers,
				loadModels: async () => catalogue(['x']),
			}),
		).toBeUndefined()
	})
})
