import { describe, expect, it } from 'vitest'

import { applyFallbackFlag, parseFallbackEntry, splitFallbackModels } from './fallback-flag.js'
import type { Preferences } from './preferences.js'

const saved: Preferences = {
	version: 3,
	providers: [{ id: 'anthropic', model: 'big' }, { id: 'google' }],
	subagents: { active: ['x'] },
}

describe('splitFallbackModels', () => {
	it('reads commas inside a value and repeated flags alike, in order', () => {
		expect(splitFallbackModels(['openai/a, openai/b', 'c'])).toEqual(['openai/a', 'openai/b', 'c'])
	})
})

describe('parseFallbackEntry', () => {
	it.each([
		['openai/small', { id: 'openai', model: 'small' }],
		['openai', { id: 'openai' }],
		['claude-small', { id: 'anthropic', model: 'claude-small' }],
		// A model id with a slash of its own, on a provider that names them that way.
		['meta/llama-4', { id: 'anthropic', model: 'meta/llama-4' }],
		['openrouter/meta/llama-4', { id: 'openrouter', model: 'meta/llama-4' }],
	])('%s', (entry, member) => {
		expect(parseFallbackEntry(entry, 'anthropic')).toEqual(member)
	})
})

describe('applyFallbackFlag', () => {
	it('puts the models after the primary and drops the saved fallbacks', () => {
		const chain = applyFallbackFlag(saved, ['openai/small,haiku'])
		expect(chain.providers).toEqual([
			{ id: 'anthropic', model: 'big' },
			{ id: 'openai', model: 'small' },
			{ id: 'anthropic', model: 'haiku' },
		])
		expect(chain.subagents).toEqual({ active: ['x'] })
	})

	it('leaves the chain alone when no model is named', () => {
		expect(applyFallbackFlag(saved, [])).toBe(saved)
		expect(applyFallbackFlag(saved, [' , '])).toBe(saved)
	})

	it('drops a member that repeats one already in the chain', () => {
		const chain = applyFallbackFlag(saved, ['anthropic/big,openai,openai'])
		expect(chain.providers).toEqual([{ id: 'anthropic', model: 'big' }, { id: 'openai' }])
	})

	it('does not write to the saved preferences object', () => {
		const before = JSON.stringify(saved)
		applyFallbackFlag(saved, ['openai'])
		expect(JSON.stringify(saved)).toBe(before)
	})
})
