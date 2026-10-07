import { expect, it } from 'vitest'
import type { ProviderView } from '../shared/protocol.js'
import {
	effortLabel,
	effortOrder,
	effortToSend,
	followCatalogue,
	modelDisplayLabel,
	resolveComposerModelChoice,
	resolveEffort,
	staleEffort,
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

it('moves a choice that follows the default when the engine default changes', () => {
	const following = {
		provider: 'codex-cli',
		model: 'gpt-old',
		label: 'GPT Old',
		preset: 'default' as const,
	}
	expect(followCatalogue(following, rows)).toEqual({
		provider: 'codex-cli',
		model: 'gpt-top',
		label: 'GPT Top',
		preset: 'default',
	})
	expect(
		followCatalogue({ ...following, model: 'gpt-top', label: 'GPT Top' }, rows),
	).toBeUndefined()
	// A catalogue that marks no default leaves the choice alone.
	expect(followCatalogue(following, [{ id: 'gpt-other', label: 'GPT Other' }])).toBeUndefined()
	expect(followCatalogue(following, undefined)).toBeUndefined()
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
