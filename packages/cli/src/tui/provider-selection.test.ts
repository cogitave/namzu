import { expect, it } from 'vitest'

import type { Preferences } from '../integrations/providers/index.js'
import { selectPrimaryProvider } from './provider-selection.js'

it('preserves delegation and fallback policy when a new credential changes the primary', () => {
	const previous: Preferences = {
		version: 3,
		providers: [
			{ id: 'openai', model: 'primary-pin' },
			{ id: 'deepseek', model: 'fallback-pin' },
		],
		subagents: { active: ['reviewer'] },
		allowCapabilityMismatch: true,
	}
	const original = structuredClone(previous)
	const temporary = selectPrimaryProvider(previous, { id: 'anthropic' })
	expect(temporary).toEqual({
		...original,
		providers: [{ id: 'anthropic' }, original.providers[1]],
	})
	const laterModelSelection = selectPrimaryProvider(temporary, {
		id: 'anthropic',
		model: 'next-model',
	})
	expect(laterModelSelection).toEqual({
		...temporary,
		providers: [{ id: 'anthropic', model: 'next-model' }, original.providers[1]],
	})
	expect(previous).toEqual(original)
})
