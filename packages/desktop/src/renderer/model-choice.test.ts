import { expect, it } from 'vitest'
import type { ProviderView } from '../shared/protocol.js'
import { resolveComposerModelChoice } from './model-choice.js'

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
