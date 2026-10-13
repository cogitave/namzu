import { expect, it } from 'vitest'
import type { ProviderView } from '../shared/protocol.js'
import { automaticChoiceNote } from './first-open-note.js'

const view = (
	available: ProviderView['available'],
	selected: ProviderView['selected'],
): ProviderView => ({ available, selected })

const auto = (id: string) => ({ id, automatic: true as const })

it('says in plain words what Namzu picked, per way it was found', () => {
	const cases: [ProviderView['available'][number], string][] = [
		[
			{ id: 'anthropic', label: 'Anthropic (Claude)', defaultModel: 'x', via: 'sign-in' },
			'Using your Claude sign-in, found on this computer.',
		],
		[
			{ id: 'codex', label: 'OpenAI (Codex subscription)', defaultModel: 'x', via: 'sign-in' },
			'Using your ChatGPT or Codex sign-in, found on this computer.',
		],
		[
			{ id: 'openai', label: 'OpenAI', defaultModel: 'x', via: 'key' },
			'Using your OpenAI key, found on this computer.',
		],
		[
			{ id: 'ollama', label: 'Ollama (local)', defaultModel: 'x', via: 'local' },
			'Using Ollama running on this computer.',
		],
		[
			{ id: 'zen', label: 'Zen', defaultModel: 'x', via: 'free', anonymous: true },
			"Using Zen's free models (experimental). You can connect your own provider in Settings.",
		],
	]
	for (const [provider, sentence] of cases) {
		const note = automaticChoiceNote(
			view([provider], auto(provider.id)),
			{ provider: provider.id },
			true,
		)
		expect(note).toBe(sentence)
		expect(note).not.toMatch(/OPENAI_API_KEY|space-bunny|11434|localhost|\bzen\b|\bhttp/)
	}
})

it('stays silent once a person chose, saved a choice, or the pick was not automatic', () => {
	const zen = { id: 'zen', label: 'Zen', defaultModel: 'x', via: 'free' as const }
	expect(automaticChoiceNote(view([zen], auto('zen')), { provider: 'zen' }, false)).toBeUndefined()
	expect(
		automaticChoiceNote(view([zen], { id: 'zen', model: 'x' }), { provider: 'zen' }, true),
	).toBeUndefined()
	expect(automaticChoiceNote(view([zen], null), { provider: 'zen' }, true)).toBeUndefined()
})
